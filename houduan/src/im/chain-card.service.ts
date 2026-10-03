import { BadRequestException, ConflictException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ImService } from './im.service';
import { MessagePayload } from './im.types';
import { cleanText as clean, isCardChain } from './card-content';
import { verifyTransferProof } from '../user/chain-address';

/**
 * 链上钱包相关的聊天卡片。
 * - transfer：钱包转账成功后由 App 交上来，服务端到链上核对过（经 Arm indexer 的 /api/verify-transfer）才发卡片，
 *   一笔交易只能发一张，收款地址必须是对方在钱包里公开的地址，付款地址要用付款私钥签过（proof，见 chain-address.ts
 *   transferMessage）。客户端不能直接通过 WS 发这种消息（im.gateway 拦掉）。
 * - callout：喊单 / 分享代币，内容是代币信息，客户端照常通过 WS 发，服务端只清洗字段（card-content.ts sanitizeCallout）。
 */

const ARM_API = (process.env.ARM_API_BASE ?? 'https://arm.yyheart.com/api').replace(/\/$/, '');
const VERIFY_TRIES = 8;
const VERIFY_GAP_MS = 3_000;

export type TransferBody = { targetId?: string; chain?: string; hash?: string; token?: string; amount?: string; symbol?: string; decimals?: number; from?: string; to?: string; proof?: string };

@Injectable()
export class ChainCardService {
  private readonly logger = new Logger('ChainCard');

  constructor(
    private readonly prisma: PrismaService,
    private readonly im: ImService,
  ) {}

  async sendTransfer(userId: bigint, b: TransferBody): Promise<MessagePayload> {
    const targetId = String(b.targetId ?? '');
    if (!/^\d{1,19}$/.test(targetId)) throw new BadRequestException('参数不正确');
    const chain = String(b.chain ?? '');
    if (!isCardChain(chain)) throw new BadRequestException('不支持的链');
    const hash = String(b.hash ?? '');
    const token = String(b.token ?? '');
    const amount = String(b.amount ?? '');
    const from = String(b.from ?? '');
    const to = String(b.to ?? '');
    const decimals = Number(b.decimals);
    if (!/^\d{1,40}$/.test(amount) || amount === '0' || !Number.isInteger(decimals) || decimals < 0 || decimals > 36 || !hash || hash.length > 100) throw new BadRequestException('转账信息不对');
    // 付款地址必须是发卡片的人自己的：钱包用付款私钥签过这笔交易
    if (!verifyTransferProof(chain, hash, from, to, b.proof)) throw new BadRequestException('付款人证明不对');

    // 卡片只发给收款的那个人：to 必须是对方公开的收款地址
    const peer = await this.prisma.userChainAddress.findUnique({ where: { userId: BigInt(targetId) } });
    const base58 = chain === 'sol' || chain === 'trx';
    const expected = chain === 'sol' ? peer?.sol : chain === 'trx' ? peer?.trx : peer?.evm;
    if (!expected || (base58 ? expected !== to : expected.toLowerCase() !== to.toLowerCase())) throw new BadRequestException('收款地址不是对方公开的地址');

    // 先占住这笔交易，防止同一笔交易重复发卡
    try {
      await this.prisma.chainTransfer.create({ data: { hash, chain, messageId: 0n, senderId: userId, receiverId: BigInt(targetId) } });
    } catch {
      throw new ConflictException('这笔转账已经发过卡片了');
    }
    try {
      await this.verify({ chain, hash, from, to, token, amount });
      const content = JSON.stringify({ chain, token, symbol: clean(b.symbol, 16) || '?', decimals, amount, from, to, hash, verified: true });
      const payload = await this.im.sendMessage(userId, { op: 'send', convType: 1, targetId, msgType: 'transfer', content });
      await this.prisma.chainTransfer.update({ where: { hash }, data: { messageId: BigInt(payload.id) } });
      return payload;
    } catch (e) {
      await this.prisma.chainTransfer.delete({ where: { hash } }).catch(() => {});
      throw e;
    }
  }

  /** 交易刚确认时有的节点还查不到：查不到就隔 3 秒再查，最多约 25 秒 */
  private async verify(q: Record<string, string>) {
    let last = '';
    for (let i = 0; i < VERIFY_TRIES; i++) {
      try {
        const r = await fetch(`${ARM_API}/verify-transfer?${new URLSearchParams(q)}`, { signal: AbortSignal.timeout(15_000) });
        const j = (await r.json()) as { ok?: boolean; pending?: boolean; reason?: string };
        if (j.ok) return;
        last = j.reason ?? `HTTP ${r.status}`;
        if (!j.pending) throw new BadRequestException(`链上核对没通过：${last}`);
      } catch (e) {
        if (e instanceof BadRequestException) throw e;
        last = (e as Error).message;
      }
      await new Promise((r) => setTimeout(r, VERIFY_GAP_MS));
    }
    this.logger.warn(`verify gave up ${q.chain} ${q.hash}: ${last}`);
    throw new ServiceUnavailableException('链上还查不到这笔转账，稍后再试');
  }
}
