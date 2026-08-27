import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 亲密度记分：任何互动（消息/点赞/评论/视频每分钟）
 * 发起方对对方 +1 分，接受方对发起方 +0.5 分。
 * score 以 x10 整数存储（半分粒度）。
 */
@Injectable()
export class IntimacyService {
  private readonly logger = new Logger(IntimacyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 记一次互动：actor（发起方）+1 x times，target（接受方）+0.5 x times。
   * 失败只记日志，绝不影响业务主流程。
   */
  async bump(actorId: bigint, targetId: bigint, times = 1) {
    if (actorId === targetId || times <= 0) return;
    const actorPts = 10 * times;
    const targetPts = 5 * times;
    try {
      await this.prisma.$executeRaw`
        INSERT INTO intimacy (user_id, peer_id, score, updated_at)
        VALUES (${actorId}, ${targetId}, ${actorPts}, NOW()), (${targetId}, ${actorId}, ${targetPts}, NOW())
        ON DUPLICATE KEY UPDATE score = score + VALUES(score), updated_at = NOW()`;
    } catch (e: any) {
      this.logger.warn(`intimacy bump fail ${actorId}->${targetId} x${times}: ${e.message}`);
    }
  }
}
