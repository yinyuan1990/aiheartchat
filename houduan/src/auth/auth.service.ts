import { BadRequestException, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Wallet } from 'ethers';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { RegisterDto } from './auth.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly crypto: CryptoService,
  ) {}

  async enter(deviceId: string) {
    const user = await this.prisma.user.findUnique({ where: { deviceId } });
    if (!user) {
      return { registered: false, token: null, user: null };
    }
    if (user.status !== 0) {
      throw new BadRequestException('账号已被封禁');
    }
    return { registered: true, token: this.sign(user.id), user: this.toProfile(user) };
  }

  async register(dto: RegisterDto, ip = '') {
    const exists = await this.prisma.user.findUnique({ where: { deviceId: dto.deviceId } });
    if (exists) {
      // 一机一号：已注册直接恢复，不允许二次注册
      return { registered: true, token: this.sign(exists.id), user: this.toProfile(exists), inviter: null };
    }

    // 账号 = BNB 链(BSC)地址，私钥主密钥加密托管
    const wallet = Wallet.createRandom();
    const user = await this.prisma.user.create({
      data: {
        deviceId: dto.deviceId,
        address: wallet.address,
        encPrivKey: this.crypto.wrapKey(Buffer.from(wallet.privateKey.slice(2), 'hex')),
        shortId: await this.genShortId(),
        nickname: dto.nickname,
        age: dto.age,
        gender: dto.gender,
        avatar: dto.avatar ?? '',
        wallet: { create: {} },
      },
    });
    const inviter = await this.attributeInvite(user, dto.inviteCode, ip).catch(() => null);
    return { registered: true, token: this.sign(user.id), user: this.toProfile(user), inviter };
  }

  /**
   * 邀请归因（注册时执行一次）：
   * 1. 带了邀请码 → 按短号/ID 找邀请人；
   * 2. 否则找 48h 内「同 IP + 同平台（按 deviceId 前缀 and_/ios_）」最近一条未消费的邀请页访问记录。
   * 命中后写 user.inviterId、消费该记录；若邀请人是异性则新用户自动关注 TA，
   * 并把邀请人简况返回给客户端（客户端据此直接打开 TA 主页）。
   */
  private async attributeInvite(user: { id: bigint; gender: number; deviceId: string }, inviteCode: string | undefined, ip: string) {
    let inviterId: bigint | null = null;
    let clickId: bigint | null = null;

    const code = (inviteCode ?? '').trim();
    if (code) {
      const byCode = /^\d{6}$/.test(code)
        ? await this.prisma.user.findUnique({ where: { shortId: code } })
        : /^\d{1,19}$/.test(code) ? await this.prisma.user.findUnique({ where: { id: BigInt(code) } }) : null;
      if (byCode) inviterId = byCode.id;
    }
    if (!inviterId && ip) {
      const platform = user.deviceId.startsWith('ios_') ? 'ios' : user.deviceId.startsWith('and_') ? 'android' : 'other';
      const click = await this.prisma.inviteClick.findFirst({
        where: { ip, platform, claimedBy: null, createdAt: { gt: new Date(Date.now() - 48 * 3600_000) } },
        orderBy: { id: 'desc' },
      });
      if (click) {
        inviterId = click.inviterId;
        clickId = click.id;
      }
    }
    if (!inviterId || inviterId === user.id) return null;

    const inviter = await this.prisma.user.findUnique({ where: { id: inviterId } });
    if (!inviter || inviter.status !== 0) return null;

    await this.prisma.user.update({ where: { id: user.id }, data: { inviterId } });
    if (clickId) await this.prisma.inviteClick.update({ where: { id: clickId }, data: { claimedBy: user.id } });

    // 性别隔离：同性不可见，只记录归因不建立关系
    const visible = inviter.gender !== user.gender;
    if (visible) {
      await this.prisma.follow.upsert({
        where: { followerId_targetId: { followerId: user.id, targetId: inviterId } },
        update: {},
        create: { followerId: user.id, targetId: inviterId },
      });
    }
    return visible
      ? { id: inviter.id, nickname: inviter.nickname, avatar: inviter.avatar, gender: inviter.gender }
      : null;
  }

  private sign(userId: bigint): string {
    return this.jwt.sign({ sub: userId.toString() });
  }

  /** 给其它登录方式（审核演示账号）签发同款 token */
  signFor(userId: bigint): string {
    return this.sign(userId);
  }

  /** 生成唯一 6 位数字短号（100000-999999） */
  private async genShortId(): Promise<string> {
    for (let i = 0; i < 20; i++) {
      const id = String(Math.floor(100000 + Math.random() * 900000));
      const exists = await this.prisma.user.findUnique({ where: { shortId: id } });
      if (!exists) return id;
    }
    throw new Error('短号生成失败，请重试');
  }

  toProfile(u: any) {
    return {
      id: u.id,
      shortId: u.shortId,
      address: u.address,
      nickname: u.nickname,
      avatar: u.avatar,
      gender: u.gender,
      age: u.age,
      cityCode: u.cityCode,
      cityName: u.cityName,
      signature: u.signature,
      isGuide: u.isGuide,
      videoPriceFen: u.videoPriceFen ?? 0,
      // 实名认证状态（不返回证号，姓名脱敏为首字 + *）
      realname: !!u.idCard,
      realNameMasked: u.realName ? u.realName[0] + '*'.repeat(Math.max(1, u.realName.length - 1)) : '',
      createdAt: u.createdAt,
    };
  }
}
