import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { Throttle } from '../common/rate-limit.guard';
import { NewsService } from '../news/news.service';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';

@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly news: NewsService,
  ) {}

  // ---------- 内容（花边新闻 / 励志行） ----------

  /** 手动触发采集一轮新闻（两性别，不看间隔；采不到走 AI 兜底） */
  @Post('news/crawl')
  @UseGuards(AdminGuard)
  crawlNews() {
    return this.news.forceCrawl();
  }

  /** 手动重新生成今天的励志语句（两性别，覆盖当天已有） */
  @Post('news/quote')
  @UseGuards(AdminGuard)
  genQuote() {
    return this.news.forceQuote();
  }

  @Post('login')
  @Throttle(10, 300)
  login(@Body() body: { username: string; password: string }, @Req() req: Request) {
    const ip = (req.headers['x-real-ip'] as string) || req.socket?.remoteAddress || '';
    return this.admin.login(body.username, body.password, ip);
  }

  // ---------- 用户 ----------

  @Get('users')
  @UseGuards(AdminGuard)
  users(@Query('keyword') keyword?: string, @Query('beforeId') beforeId?: string) {
    return this.admin.listUsers(keyword, beforeId ? BigInt(beforeId) : undefined);
  }

  @Post('users/:id/status')
  @UseGuards(AdminGuard)
  setStatus(@Param('id') id: string, @Body() body: { status: number }) {
    return this.admin.setUserStatus(BigInt(id), body.status);
  }

  /** 后台发放/调整积分（唯一积分来源，amount 可为负） */
  @Post('users/:id/grant')
  @UseGuards(AdminGuard)
  grant(@Param('id') id: string, @Body() body: { amount: string; remark?: string }) {
    return this.admin.grantPoints(BigInt(id), BigInt(body.amount), body.remark ?? '');
  }

  /** 查看某用户积分明细（beforeId 游标分页） */
  @Get('users/:id/transactions')
  @UseGuards(AdminGuard)
  userTransactions(@Param('id') id: string, @Query('beforeId') beforeId?: string) {
    return this.admin.listUserTransactions(BigInt(id), beforeId ? BigInt(beforeId) : undefined);
  }

  // ---------- 通话日志 ----------

  @Get('call-logs')
  @UseGuards(AdminGuard)
  callLogs(@Query('beforeId') beforeId?: string) {
    return this.admin.listCallLogs(beforeId ? BigInt(beforeId) : undefined);
  }

  @Get('call-logs/:callId')
  @UseGuards(AdminGuard)
  callLogDetail(@Param('callId') callId: string) {
    return this.admin.callLogDetail(callId);
  }

  // ---------- 语音房日志（按房间场次汇总多端日志） ----------

  @Get('vroom-logs')
  @UseGuards(AdminGuard)
  vroomLogs() {
    return this.admin.listVroomSessions();
  }

  @Get('vroom-logs/:roomId')
  @UseGuards(AdminGuard)
  vroomLogDetail(@Param('roomId') roomId: string) {
    return this.admin.vroomLogDetail(roomId);
  }

  // ---------- 平台账本 ----------

  @Get('ledger/summary')
  @UseGuards(AdminGuard)
  ledgerSummary(@Query('from') from?: string, @Query('to') to?: string) {
    return this.admin.ledgerSummary(from, to);
  }

  @Get('ledger/females')
  @UseGuards(AdminGuard)
  ledgerFemales(@Query('from') from?: string, @Query('to') to?: string) {
    return this.admin.ledgerFemales(from, to);
  }

  @Get('ledger/females/:id')
  @UseGuards(AdminGuard)
  ledgerFemaleDetail(@Param('id') id: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.admin.ledgerFemaleDetail(BigInt(id), from, to);
  }

  // ---------- 地陪审核 ----------

  @Get('guide-applies')
  @UseGuards(AdminGuard)
  guideApplies(@Query('status') status?: string) {
    return this.admin.listGuideApplies(status ? Number(status) : 0);
  }

  @Post('guide-applies/:id/review')
  @UseGuards(AdminGuard)
  reviewGuide(@Param('id') id: string, @Body() body: { pass: boolean; reason?: string }) {
    return this.admin.reviewGuide(BigInt(id), body.pass, body.reason ?? '');
  }

  // ---------- 提现审核 ----------

  @Get('withdrawals')
  @UseGuards(AdminGuard)
  withdrawals(@Query('status') status?: string) {
    return this.admin.listWithdrawals(status ? Number(status) : 0);
  }

  @Post('withdrawals/:id/review')
  @UseGuards(AdminGuard)
  reviewWithdraw(@Param('id') id: string, @Body() body: { pass: boolean; remark?: string }) {
    return this.admin.reviewWithdraw(BigInt(id), body.pass, body.remark ?? '');
  }

  // ---------- 通话参数 ----------

  @Get('call-config')
  @UseGuards(AdminGuard)
  getCallConfig() {
    return this.admin.getCallConfig();
  }

  @Put('call-config')
  @UseGuards(AdminGuard)
  callConfig(@Body() body: { width?: number; height?: number; fps?: number; bitrate?: number; voiceRoomMax?: number }) {
    return this.admin.updateCallConfig(body);
  }

  // ---------- 计费配置（单位：分） ----------

  @Get('price-config')
  @UseGuards(AdminGuard)
  priceConfig() {
    return this.admin.getPriceConfig();
  }

  @Put('price-config')
  @UseGuards(AdminGuard)
  updatePriceConfig(@Body() body: { msgPriceFen?: number; videoBaseFenPerMin?: number; videoPlatformX?: number; momentNeedRealname?: boolean }) {
    return this.admin.updatePriceConfig(body);
  }

  /** 重置全平台女生视频价格 = 成本 x times（默认 5） */
  @Post('price-config/reset-female')
  @UseGuards(AdminGuard)
  resetFemalePrices(@Body() body: { times?: number }) {
    return this.admin.resetFemalePrices(body.times ?? 5);
  }

  // ---------- 礼物 ----------

  @Get('gifts')
  @UseGuards(AdminGuard)
  gifts() {
    return this.admin.listGifts();
  }

  @Post('gifts')
  @UseGuards(AdminGuard)
  upsertGift(@Body() body: { id?: number; name: string; icon: string; price: string; sort?: number; enabled?: boolean }) {
    return this.admin.upsertGift(body);
  }

  // ---------- 模块入口 ----------

  @Get('modules')
  @UseGuards(AdminGuard)
  modules() {
    return this.admin.listModules();
  }

  @Post('modules')
  @UseGuards(AdminGuard)
  upsertModule(
    @Body() body: {
      id?: number; name: string; icon?: string; desc?: string; cover?: string; type: string; entry: string;
      sort?: number; enabled?: boolean; visibleGender?: number;
    },
  ) {
    return this.admin.upsertModule(body);
  }

  // ---------- 约单仲裁 ----------

  @Get('disputes')
  @UseGuards(AdminGuard)
  disputes() {
    return this.admin.listDisputes();
  }

  @Post('disputes/:id/arbitrate')
  @UseGuards(AdminGuard)
  arbitrate(@Param('id') id: string, @Body() body: { settleToTaker: boolean }) {
    return this.admin.arbitrate(BigInt(id), body.settleToTaker);
  }

  // ---------- 动态 ----------

  @Post('moments/:id/hide')
  @UseGuards(AdminGuard)
  hideMoment(@Param('id') id: string) {
    return this.admin.hideMoment(BigInt(id));
  }
}
