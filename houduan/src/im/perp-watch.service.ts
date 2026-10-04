import { BadRequestException, ForbiddenException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { WebSocket } from 'ws';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';

/**
 * 合约喊单卡片的实时状态，走 IM WebSocket：手机打开一个聊天时发 perpWatch（这个会话 + 屏幕上的喊单消息 id），
 * 离开发 perpUnwatch。本节点每 3 秒把自己连接上在看的卡片一起交给 Arm indexer（POST /api/hl/call-status，
 * 它按 Hyperliquid 限额自己控频、缓存），再给每个在看的连接推 perpTick：行情价每次都推，卡片状态变了才推。
 * 没人打开的群不查也不推；多节点各管各的连接，不需要共享状态。
 */

const ARM_API = (process.env.ARM_API_BASE ?? 'https://arm.yyheart.com/api').replace(/\/$/, '');
const TICK_MS = 3_000;
const MAX_CONVS_PER_SOCKET = 4;
const MAX_IDS = 100;

type Card = { user: string; coin: string; since: number; side: 'long' | 'short' };
type Watch = Map<string, Map<string, Card>>;
const cardKey = (c: Card) => `${c.user}|${c.coin}|${c.since}`;

@Injectable()
export class PerpWatchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('PerpWatch');
  private readonly watches = new Map<WebSocket, Watch>();
  /** per socket: msgId → last status sent (JSON), so unchanged ones are not resent */
  private readonly sent = new WeakMap<WebSocket, Map<string, string>>();
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
    const rows = msgIds.length ? await this.prisma.message.findMany({ where: { id: { in: msgIds.map(BigInt) }, conversationId: conv.id, type: 'perp' }, select: { id: true, cipherContent: true } }) : [];
    const key = this.crypto.unwrapKey(conv.wrappedKey);
    const cards = new Map<string, Card>();
    for (const r of rows) {
      try {
        const o = JSON.parse(this.crypto.decrypt(key, r.cipherContent)) as { address?: string; coin?: string; at?: number; side?: string };
        if (o.address && o.coin && o.at && (o.side === 'long' || o.side === 'short')) cards.set(String(r.id), { user: o.address, coin: o.coin, since: o.at, side: o.side });
      } catch {
        /* unreadable card: skip */
      }
    }
    let w = this.watches.get(ws);
    if (!w) this.watches.set(ws, (w = new Map()));
    w.delete(cid);
    w.set(cid, cards);
    while (w.size > MAX_CONVS_PER_SOCKET) w.delete(w.keys().next().value!);
    // a reopened chat renders its cards from scratch: send every status again
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

  /** `only`: answer just these sockets now (a fresh perpWatch), outside the regular tick */
  private async tick(only?: WebSocket[]) {
    if (!only && this.busy) return;
    const sockets = (only ?? [...this.watches.keys()]).filter((ws) => {
      if (ws.readyState !== ws.OPEN) {
        this.watches.delete(ws);
        return false;
      }
      return true;
    });
    const items = new Map<string, Card>();
    for (const ws of sockets) for (const cards of this.watches.get(ws)?.values() ?? []) for (const c of cards.values()) items.set(cardKey(c), c);
    if (!items.size) return;
    if (!only) this.busy = true;
    try {
      const r = await fetch(`${ARM_API}/hl/call-status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: [...items.values()] }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { results, marks } = (await r.json()) as { results: Record<string, { state: string }>; marks: Record<string, number> };
      for (const ws of sockets) {
        let last = this.sent.get(ws);
        if (!last) this.sent.set(ws, (last = new Map()));
        for (const [cid, cards] of this.watches.get(ws) ?? []) {
          if (!cards.size) continue;
          const statuses: Record<string, unknown> = {};
          const coinMarks: Record<string, number> = {};
          for (const [msgId, c] of cards) {
            if (marks[c.coin]) coinMarks[c.coin] = marks[c.coin];
            const s = results[cardKey(c)];
            if (!s || s.state === 'error') continue;
            const { at: _at, mark: _mark, ...stable } = s as Record<string, unknown>;
            const j = JSON.stringify(stable);
            if (last.get(msgId) === j) continue;
            last.set(msgId, j);
            statuses[msgId] = s;
          }
          ws.send(JSON.stringify({ op: 'perpTick', conversationId: cid, marks: coinMarks, statuses }));
        }
      }
    } catch (e) {
      this.logger.warn(`tick: ${(e as Error).message}`);
    } finally {
      if (!only) this.busy = false;
    }
  }
}
