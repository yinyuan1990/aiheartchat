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

  async register(dto: RegisterDto) {
    const exists = await this.prisma.user.findUnique({ where: { deviceId: dto.deviceId } });
    if (exists) {
      // 一机一号：已注册直接恢复，不允许二次注册
      return { registered: true, token: this.sign(exists.id), user: this.toProfile(exists) };
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
    return { registered: true, token: this.sign(user.id), user: this.toProfile(user) };
  }

  private sign(userId: bigint): string {
    return this.jwt.sign({ sub: userId.toString() });
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
