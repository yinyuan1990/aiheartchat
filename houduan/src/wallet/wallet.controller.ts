import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, Length, Matches } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from './wallet.service';
import { BadRequestException } from '@nestjs/common';

class TransferDto {
  /** 收款人 6 位短号 */
  @IsString()
  @Matches(/^\d{6}$/, { message: '请输入 6 位数字 ID' })
  toShortId!: string;

  /** 转赠积分（分） */
  @IsString()
  @Matches(/^[1-9]\d*$/, { message: '金额必须为正整数' })
  amountFen!: string;

  @IsOptional()
  @IsString()
  @Length(0, 50)
  remark?: string;
}

class WithdrawDto {
  /** 整数积分 */
  @IsString()
  @Matches(/^[1-9]\d*$/, { message: '金额必须为正整数' })
  amount!: string;

  @IsString()
  @Length(1, 100)
  account!: string;
}

@Controller('wallet')
@UseGuards(JwtAuthGuard)
export class WalletController {
  constructor(
    private readonly wallets: WalletService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  wallet(@CurrentUser() userId: bigint) {
    return this.wallets.getWallet(userId);
  }

  @Get('transactions')
  transactions(@CurrentUser() userId: bigint, @Query('beforeId') beforeId?: string) {
    return this.wallets.listTransactions(userId, beforeId ? BigInt(beforeId) : undefined);
  }

  /** 贡献榜：女生看男生贡献排行，男生看送花排行 */
  @Get('contrib-rank')
  contribRank(@CurrentUser() userId: bigint) {
    return this.wallets.contribRank(userId);
  }

  /** 提现申请：扣可用余额入冻结，后台审核 */
  @Post('withdraw')
  async withdraw(@CurrentUser() userId: bigint, @Body() dto: WithdrawDto) {
    const amount = BigInt(dto.amount);
    return this.prisma.$transaction(async (tx) => {
      const apply = await tx.withdrawApply.create({
        data: { userId, amount, account: dto.account },
      });
      await this.wallets.applyTx(tx, userId, 'withdraw', -amount, {
        frozenDelta: amount,
        refKey: `wd_${apply.id}`,
        remark: '提现申请冻结',
      });
      return apply;
    });
  }

  @Get('withdrawals')
  withdrawals(@CurrentUser() userId: bigint) {
    return this.prisma.withdrawApply.findMany({ where: { userId }, orderBy: { id: 'desc' }, take: 50 });
  }

  /** 按短号查收款人（转赠前确认对方昵称） */
  @Get('lookup/:shortId')
  lookup(@Param('shortId') shortId: string) {
    return this.wallets.lookupByShortId(shortId);
  }

  /** 积分转赠 */
  @Post('transfer')
  transfer(@CurrentUser() userId: bigint, @Body() dto: TransferDto) {
    return this.wallets.transfer(userId, dto.toShortId, BigInt(dto.amountFen), dto.remark ?? '');
  }
}
