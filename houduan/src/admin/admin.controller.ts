import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { Throttle } from '../common/rate-limit.guard';
import { NewsService } from '../news/news.service';
import { TreeholeService } from '../treehole/treehole.service';
import { TreeholeSyncService } from '../treehole/treehole-sync.service';
import { SrsService } from '../srs/srs.service';
import { AppVersionService } from '../module/app-version.service';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
import { ReviewService } from '../auth/review.service';

@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly news: NewsService,
    private readonly treehole: TreeholeService,
    private readonly treeholeSync: TreeholeSyncService,
    private readonly srs: SrsService,
    private readonly appVersion: AppVersionService,
    private readonly review: ReviewService,
  ) {}

  // ---------- iOS 审核模式 / 演示账号 ----------

  @Get('review-mode')
  @UseGuards(AdminGuard)
  reviewMode() {
    return this.review.adminStatus();
  }

  /** 开关 iOS 审核模式；开启时自动创建/补足演示账号 */
  @Put('review-mode')
  @UseGuards(AdminGuard)
  setReviewMode(@Body() body: { ios: boolean }) {
    return this.review.setIos(!!body?.ios);
  }

  /** 重建演示账号资料（从第一个男用户重新复制、城市成都、补足积分） */
  @Post('review-mode/demo-user')
  @UseGuards(AdminGuard)
  async rebuildDemo() {
    await this.review.ensureDemoUser(true);
    return this.review.adminStatus();
  }

  // ---------- App 版本 / 强制更新 ----------

  @Get('app-version')
  @UseGuards(AdminGuard)
  appVersions() {
    return this.appVersion.adminList();
  }

  @Put('app-version/:platform')
  @UseGuards(AdminGuard)
  saveAppVersion(
    @Param('platform') platform: string,
    @Body() body: { latest?: string; minVersion?: string; force?: boolean; url?: string; channel?: string; notes?: string },
  ) {
    return this.appVersion.adminSave(platform, body);
  }

  // ---------- SRS 节点管理 ----------

  /** 节点列表 + 当前连接数 + 环境变量兜底值 */
  @Get('srs-nodes')
  @UseGuards(AdminGuard)
  srsNodes() {
    return this.srs.adminList();
  }

  /** 默认（源）节点：部署工具拉这个决定从哪台复制 */
  @Get('srs-nodes/default')
  @UseGuards(AdminGuard)
  srsDefault() {
    return this.srs.defaultNode();
  }

  @Post('srs-nodes')
  @UseGuards(AdminGuard)
  srsCreate(@Body() body: any) {
    return this.srs.adminCreate(body);
  }

  @Post('srs-nodes/:id')
  @UseGuards(AdminGuard)
  srsUpdate(@Param('id') id: string, @Body() body: any) {
    return this.srs.adminUpdate(Number(id), body);
  }

  @Post('srs-nodes/:id/default')
  @UseGuards(AdminGuard)
  srsSetDefault(@Param('id') id: string) {
    return this.srs.adminSetDefault(Number(id));
  }

  @Post('srs-nodes/:id/delete')
  @UseGuards(AdminGuard)
  srsDelete(@Param('id') id: string) {
    return this.srs.adminDelete(Number(id));
  }

  // ---------- 私密树洞 ----------

  /** 帖子列表（含隐藏）；status=0/1 可筛 */
  @Get('treehole')
  @UseGuards(AdminGuard)
  treeholeList(@Query('beforeId') beforeId?: string, @Query('status') status?: string) {
    return this.treehole.adminList(beforeId ? BigInt(beforeId) : undefined, status != null && status !== '' ? Number(status) : undefined);
  }

  // ---- Telegram 公开频道自动同步（放在 :id 路由之前，避免被当成 id） ----

  @Get('treehole/sources')
  @UseGuards(AdminGuard)
  treeholeSources() {
    return this.treeholeSync.listSources();
  }

  @Post('treehole/sources')
  @UseGuards(AdminGuard)
  treeholeSaveSource(@Body() body: { id?: number; channel: string; enabled?: boolean; minViews?: number; stripLinks?: boolean; blockWords?: string }) {
    return this.treeholeSync.saveSource(body);
  }

  @Delete('treehole/sources/:id')
  @UseGuards(AdminGuard)
  treeholeRemoveSource(@Param('id') id: string) {
    return this.treeholeSync.removeSource(Number(id));
  }

  /** 预览频道最近的帖子（不入库），用来确认频道名对、能抓到 */
  @Get('treehole/sources/preview')
  @UseGuards(AdminGuard)
  treeholePreview(@Query('channel') channel: string) {
    return this.treeholeSync.preview(channel ?? '');
  }

  /** 立即同步；full=1 时往前翻 5 页回灌历史 */
  @Post('treehole/sources/:id/sync')
  @UseGuards(AdminGuard)
  treeholeSyncNow(@Param('id') id: string, @Body() body: { full?: boolean }) {
    return this.treeholeSync.syncOne(Number(id), !!body?.full);
  }

  /** 后台手动录入一条（匿名），可带图片 */
  @Post('treehole')
  @UseGuards(AdminGuard)
  treeholeCreate(@Body() body: { content?: string; images?: string[] }) {
    return this.treehole.adminCreate(body.content ?? '', body.images);
  }

  /** 编辑后台录入 / 同步的内容与图片 */
  @Post('treehole/:id')
  @UseGuards(AdminGuard)
  treeholeUpdate(@Param('id') id: string, @Body() body: { content?: string; images?: string[] }) {
    return this.treehole.adminUpdate(BigInt(id), body.content ?? '', body.images);
  }

  /** 上/下架：status 0=显示 1=隐藏 */
  @Post('treehole/:id/status')
  @UseGuards(AdminGuard)
  treeholeStatus(@Param('id') id: string, @Body() body: { status: number }) {
    return this.treehole.adminSetStatus(BigInt(id), Number(body.status));
  }

  @Get('treehole/:id/comments')
  @UseGuards(AdminGuard)
  treeholeComments(@Param('id') id: string) {
    return this.treehole.adminComments(BigInt(id));
  }

  @Post('treehole/comments/:id/delete')
  @UseGuards(AdminGuard)
  treeholeDeleteComment(@Param('id') id: string) {
    return this.treehole.adminDeleteComment(BigInt(id));
  }

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
      orientation?: string; sort?: number; enabled?: boolean; visibleGender?: number;
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
