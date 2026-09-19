import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Wallet } from 'ethers';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';

/** App Store 审核用演示账号：账号 11111111111，密码任意（对审核员说 123456） */
export const DEMO_USERNAME = '11111111111';
export const DEMO_DEVICE_ID = 'demo_' + DEMO_USERNAME;
const KEY_REVIEW_IOS = 'review_mode_ios';
const DEMO_BALANCE_FEN = 1_000_000n; // 10000 积分

/**
 * iOS 审核模式：
 * - 开关 review_mode_ios（后台可切，默认开）。开着时 iOS 启动显示「账号 + 密码」登录页；关掉后回到一机一号逻辑。
 * - 演示账号内容从平台第一个男用户复制（昵称/头像/年龄/签名），城市固定成都，充 10000 积分。
 */
@Injectable()
export class ReviewService {
  private readonly logger = new Logger('Review');

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  /** 公开：客户端启动时读取 */
  async publicStatus() {
    const row = await this.prisma.sysSetting.findUnique({ where: { key: KEY_REVIEW_IOS } });
    // 未设置过 = 默认开启
    return { ios: row ? row.value === '1' : true };
  }

  async adminStatus() {
    const s = await this.publicStatus();
    const demo = await this.prisma.user.findUnique({ where: { deviceId: DEMO_DEVICE_ID }, include: { wallet: true } });
    return {
      ...s,
      demo: demo
        ? { id: demo.id, shortId: demo.shortId, nickname: demo.nickname, cityName: demo.cityName, balance: demo.wallet?.balance ?? 0n, username: DEMO_USERNAME, password: '123456' }
        : null,
    };
  }

  async setIos(enabled: boolean) {
    await this.prisma.sysSetting.upsert({
      where: { key: KEY_REVIEW_IOS },
      update: { value: enabled ? '1' : '0' },
      create: { key: KEY_REVIEW_IOS, value: enabled ? '1' : '0' },
    });
    if (enabled) await this.ensureDemoUser();
    return this.adminStatus();
  }

  /** 账号密码登录（仅演示账号；密码不校验，只要账号对） */
  async demoLogin(username: string, password: string) {
    if ((username ?? '').trim() !== DEMO_USERNAME) throw new BadRequestException('账号或密码错误');
    if (!(password ?? '').trim()) throw new BadRequestException('请输入密码');
    const user = await this.ensureDemoUser();
    if (user.status !== 0) throw new BadRequestException('账号异常');
    return user;
  }

  /** 创建/刷新演示账号：从第一个男用户复制资料，城市成都，余额补到 10000 积分 */
  async ensureDemoUser(refresh = false) {
    let user = await this.prisma.user.findUnique({ where: { deviceId: DEMO_DEVICE_ID } });
    const src = await this.prisma.user.findFirst({ where: { gender: 1, deviceId: { not: DEMO_DEVICE_ID } }, orderBy: { id: 'asc' } });
    const profile = {
      nickname: src?.nickname || '心之音体验',
      avatar: src?.avatar || '',
      age: src?.age && src.age >= 18 ? src.age : 26,
      signature: src?.signature || '',
      cityCode: '510100',
      cityName: '成都',
      latitude: 30.5728,
      longitude: 104.0668,
    };
    if (!user) {
      const w = Wallet.createRandom();
      user = await this.prisma.user.create({
        data: {
          deviceId: DEMO_DEVICE_ID,
          address: w.address,
          encPrivKey: this.crypto.wrapKey(Buffer.from(w.privateKey.slice(2), 'hex')),
          shortId: await this.genShortId(),
          gender: 1,
          ...profile,
          wallet: { create: {} },
        },
      });
      this.logger.log(`demo user created #${user.id} from #${src?.id}`);
    } else if (refresh) {
      user = await this.prisma.user.update({ where: { id: user.id }, data: profile });
    }
    // 余额不足 10000 积分就补齐
    const wallet = await this.prisma.wallet.upsert({ where: { userId: user.id }, create: { userId: user.id }, update: {} });
    if (wallet.balance < DEMO_BALANCE_FEN) {
      const delta = DEMO_BALANCE_FEN - wallet.balance;
      await this.prisma.$transaction([
        this.prisma.wallet.update({ where: { userId: user.id }, data: { balance: DEMO_BALANCE_FEN } }),
        this.prisma.walletTransaction.create({
          data: { userId: user.id, type: 'admin_grant', amount: delta, balanceAfter: DEMO_BALANCE_FEN, refKey: `demo_topup_${Date.now()}`, remark: '审核演示账号补足积分' },
        }),
      ]);
    }
    // 复制源用户的照片墙（演示账号没有时）
    if (src) {
      const has = await this.prisma.userAlbum.count({ where: { userId: user.id } });
      if (has === 0) {
        const albums = await this.prisma.userAlbum.findMany({ where: { userId: src.id }, orderBy: { sort: 'asc' } });
        if (albums.length) {
          await this.prisma.userAlbum.createMany({ data: albums.map((a) => ({ userId: user!.id, type: a.type, url: a.url, coverUrl: a.coverUrl, sort: a.sort })) });
        }
      }
    }
    return user;
  }

  isDemo(deviceId: string) {
    return deviceId === DEMO_DEVICE_ID;
  }

  private async genShortId(): Promise<string> {
    for (let i = 0; i < 20; i++) {
      const id = String(Math.floor(100000 + Math.random() * 900000));
      if (!(await this.prisma.user.findUnique({ where: { shortId: id } }))) return id;
    }
    throw new Error('短号生成失败');
  }
}
