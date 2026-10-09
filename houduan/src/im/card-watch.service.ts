import { BadRequestException, ForbiddenException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { WebSocket } from 'ws';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { GROUP_HIDDEN } from './group-hidden';
import { CARD_HOSTS } from './card-content';

/**
 * 通用卡片（msgType card）的实时数据，走 IM WebSocket，和合约卡片的 perp-watch.service.ts 同一个思路：手机打开聊天时
 * 发 cardWatch（会话 + 屏幕上的卡片消息 id），离开发 cardUnwatch。本节点每 20 秒把在看的卡片按 `live` 地址去重后
 * 统一拉一次（同一个地址 15 秒内只拉一次，不管多少人在看），数据变了才给在看的连接推 cardTick { values: { 消息id: {...} } }。
 * 客户端不直接请求 live 地址。
 */

const TICK_MS = 20_000;
const CACHE_MS = 15_000;
const MAX_CONVS_PER_SOCKET = 4;
const MAX_IDS = 100;
const PARALLEL = 6;

const liveOk = (u: unknown): u is string => {
  try {
    const h = new URL(String(u));
    return h.protocol === 'https:' && (CARD_HOSTS.includes(h.hostname) || h.hostname.endsWith('.yyheart.com'));
  } catch {
    return false;
  }
};

type Watch = Map<string, Map<string, string>>; // conversationId → msgId → live url

@Injectable()
export class CardWatchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('CardWatch');
  private readonly watches = new Map<WebSocket, Watch>();
  /** per socket: msgId → last values sent (JSON) */
  private readonly sent = new WeakMap<WebSocket, Map<string, string>>();
  private readonly cache = new Map<string, { at: number; values: Record<string, string> | null }>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async watch(ws: WebSocket, userId: bigint, conversationId: unknown, ids: unknown) {
    const cid = String(conversationId ?? '');
    if (!/^\d{1,19}$/.test(cid)) throw new BadRequestException('参数不正确');
    const msgIds = (Array.isArray(ids) ? ids : []).map(String).filter((s) => /^\d{1,19}$/.test(s)).slice(-MAX_IDS);
    const conv = await this.prisma.conversation.findUnique({ where: { id: BigInt(cid) } });
    if (!conv) throw new BadRequestException('会话不存在');
    const member = conv.groupId
      ? !!(await this.prisma.groupMember.findUnique({ where: { groupId_userId: { groupId: conv.groupId, userId } }, select: { id: true } }))
      : conv.userAId === userId || conv.userBId === userId;
    if (!member) throw new ForbiddenException('不在这个聊天里');
    if (conv.groupId && (await this.prisma.chatGroup.findUnique({ where: { id: conv.groupId }, select: { visible: true } }))?.visible === false) throw new ForbiddenException(GROUP_HIDDEN);
    const rows = msgIds.length ? await this.prisma.message.findMany({ where: { id: { in: msgIds.map(BigInt) }, conversationId: conv.id, type: 'card' }, select: { id: true, cipherContent: true } }) : [];
    const key = this.crypto.unwrapKey(conv.wrappedKey);
    const cards = new Map<string, string>();
    for (const r of rows) {
      try {
        const live = (JSON.parse(this.crypto.decrypt(key, r.cipherContent)) as { live?: unknown }).live;
        if (liveOk(live)) cards.set(String(r.id), live);
      } catch {
        /* unreadable card: skip */
      }
    }
    let w = this.watches.get(ws);
    if (!w) this.watches.set(ws, (w = new Map()));
    w.delete(cid);
    w.set(cid, cards);
    while (w.size > MAX_CONVS_PER_SOCKET) w.delete(w.keys().next().value!);
    const last = this.sent.get(ws);
    for (const id of cards.keys()) last?.delete(id);
    if (cards.size) void this.tick([ws]);
  }

  unwatch(ws: WebSocket, conversationId: unknown) {
    this.watches.get(ws)?.delete(String(conversationId ?? ''));
  }

  drop(ws: WebSocket) {
    this.watches.delete(ws);
  }

  private async pull(url: string): Promise<Record<string, string> | null> {
    const hit = this.cache.get(url);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.values;
    let values: Record<string, string> | null = null;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      const j = r.ok ? ((await r.json()) as { values?: Record<string, unknown> }) : null;
      if (j?.values && typeof j.values === 'object') {
        values = {};
        for (const [k, v] of Object.entries(j.values)) if (/^[a-zA-Z0-9_]{1,20}$/.test(k) && (typeof v === 'string' || typeof v === 'number')) values[k] = String(v).slice(0, 24);
      }
    } catch {
      /* keep null: nothing is pushed for this card this round */
    }
    if (this.cache.size > 2000) this.cache.clear();
    this.cache.set(url, { at: Date.now(), values });
    return values;
  }

  /** `only`: answer just these sockets now (a fresh cardWatch), outside the regular tick */
  private async tick(only?: WebSocket[]) {
    if (!only && this.busy) return;
    const sockets = (only ?? [...this.watches.keys()]).filter((ws) => {
      if (ws.readyState !== ws.OPEN) {
        this.watches.delete(ws);
        return false;
      }
      return true;
    });
    const urls = new Set<string>();
    for (const ws of sockets) for (const cards of this.watches.get(ws)?.values() ?? []) for (const u of cards.values()) urls.add(u);
    if (!urls.size) return;
    if (!only) this.busy = true;
    try {
      const list = [...urls];
      const got = new Map<string, Record<string, string> | null>();
      for (let i = 0; i < list.length; i += PARALLEL) {
        const chunk = list.slice(i, i + PARALLEL);
        const res = await Promise.all(chunk.map((u) => this.pull(u)));
        chunk.forEach((u, k) => got.set(u, res[k]));
      }
      for (const ws of sockets) {
        let last = this.sent.get(ws);
        if (!last) this.sent.set(ws, (last = new Map()));
        for (const [cid, cards] of this.watches.get(ws) ?? []) {
          const values: Record<string, Record<string, string>> = {};
          for (const [msgId, u] of cards) {
            const v = got.get(u);
            if (!v) continue;
            const j = JSON.stringify(v);
            if (last.get(msgId) === j) continue;
            last.set(msgId, j);
            values[msgId] = v;
          }
          if (Object.keys(values).length) ws.send(JSON.stringify({ op: 'cardTick', conversationId: cid, values }));
        }
      }
    } catch (e) {
      this.logger.warn(`tick: ${(e as Error).message}`);
    } finally {
      if (!only) this.busy = false;
    }
  }
}
