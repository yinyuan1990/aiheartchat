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
import { TelegramClientService } from '../telegram/telegram.service';
import { MusicService } from '../music/music.service';
import { GalleryService } from '../gallery/gallery.service';
import { StickerService } from '../sticker/sticker.service';
import { GifService } from '../gif/gif.service';
import { HallTabsService } from '../module/hall-tabs.service';
import { TgForwardService } from '../tgforward/tg-forward.service';

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
    private readonly tg: TelegramClientService,
    private readonly music: MusicService,
    private readonly gallery: GalleryService,
    private readonly stickers: StickerService,
    private readonly gifs: GifService,
    private readonly hallTabs: HallTabsService,
    private readonly tgForward: TgForwardService,
  ) {}

  // ---------- 频道转发（推广：别人的频道 → 我们的推广频道，与 App 内容无关） ----------

  @Get('tg-forward/status')
  @UseGuards(AdminGuard)
  tgForwardStatus() {
    return this.tgForward.status();
  }

  @Put('tg-forward/target')
  @UseGuards(AdminGuard)
  tgForwardTarget(@Body() body: { channel: string }) {
    return this.tgForward.saveTarget(body?.channel ?? '');
  }

  @Get('tg-forward/sources')
  @UseGuards(AdminGuard)
  tgForwardSources() {
    return this.tgForward.listSources();
  }

  @Get('tg-forward/sources/preview')
  @UseGuards(AdminGuard)
  tgForwardPreview(@Query('channel') channel: string) {
    return this.tgForward.preview(channel ?? '');
  }

  @Post('tg-forward/sources')
  @UseGuards(AdminGuard)
  tgForwardSave(@Body() body: { id?: number; channel: string; enabled?: boolean; dropAuthor?: boolean; mediaOnly?: boolean; maxPerRun?: number; blockWords?: string; backfill?: number }) {
    return this.tgForward.saveSource(body);
  }

  @Delete('tg-forward/sources/:id')
  @UseGuards(AdminGuard)
  tgForwardRemove(@Param('id') id: string) {
    return this.tgForward.removeSource(Number(id));
  }

  /** 立即转发新消息；?backfill=N 不看游标、把最近 N 条转过去 */
  @Post('tg-forward/sources/:id/sync')
  @UseGuards(AdminGuard)
  tgForwardSync(@Param('id') id: string, @Query('backfill') backfill?: string) {
    return this.tgForward.syncOne(Number(id), Number(backfill) || 0);
  }

  // ---------- 表情包（Telegram 公开贴纸集，后台精选） ----------

  @Get('stickers/sets')
  @UseGuards(AdminGuard)
  stickerSets() {
    return this.stickers.listSets();
  }

  @Get('stickers/sets/:id/items')
  @UseGuards(AdminGuard)
  stickerItems(@Param('id') id: string) {
    return this.stickers.items(Number(id));
  }

  /** 解析（不入库）：标题/张数/类型 + 前 12 张缩略图 */
  @Get('stickers/preview')
  @UseGuards(AdminGuard)
  stickerPreview(@Query('name') name: string) {
    return this.stickers.preview(name ?? '');
  }

  /** Telegram 官方热门贴纸集 */
  @Get('stickers/featured')
  @UseGuards(AdminGuard)
  stickerFeatured() {
    return this.stickers.featured();
  }

  /** 添加并开始同步；已存在则重新同步 */
  @Post('stickers/sets')
  @UseGuards(AdminGuard)
  stickerAdd(@Body() body: { name: string }) {
    return this.stickers.addSet(body?.name ?? '');
  }

  @Post('stickers/sets/:id/sync')
  @UseGuards(AdminGuard)
  stickerSync(@Param('id') id: string) {
    return this.stickers.syncOne(Number(id));
  }

  @Put('stickers/sets/:id')
  @UseGuards(AdminGuard)
  stickerUpdate(@Param('id') id: string, @Body() body: { title?: string; enabled?: boolean; sort?: number; isDefault?: boolean }) {
    return this.stickers.updateSet(Number(id), body ?? {});
  }

  /** 推给所有已有面板的用户（新用户看 isDefault） */
  @Post('stickers/sets/:id/push-all')
  @UseGuards(AdminGuard)
  stickerPushAll(@Param('id') id: string) {
    return this.stickers.pushToAll(Number(id));
  }

  @Put('stickers/reorder')
  @UseGuards(AdminGuard)
  stickerReorder(@Body() body: { ids: number[] }) {
    return this.stickers.reorder((body?.ids ?? []).map(Number).filter((n) => n > 0));
  }

  /** purge=1 连文件删（已发出的表情会裂图）；默认只删记录 */
  @Delete('stickers/sets/:id')
  @UseGuards(AdminGuard)
  stickerRemove(@Param('id') id: string, @Query('purge') purge?: string) {
    return this.stickers.removeSet(Number(id), purge === '1' || purge === 'true');
  }

  // ---------- GIF 缓存（Telegram @gif → MinIO） ----------

  @Get('gifs')
  @UseGuards(AdminGuard)
  gifList(@Query('page') page?: string, @Query('size') size?: string, @Query('q') q?: string) {
    return this.gifs.adminList(Math.max(1, Number(page) || 1), Math.min(100, Number(size) || 40), q ?? '');
  }

  @Get('gifs/stats')
  @UseGuards(AdminGuard)
  gifStats() {
    return this.gifs.adminStats();
  }

  /** 屏蔽（删文件、不再出现） */
  @Post('gifs/:id/block')
  @UseGuards(AdminGuard)
  gifBlock(@Param('id') id: string) {
    return this.gifs.block(Number(id));
  }

  @Post('gifs/:id/unblock')
  @UseGuards(AdminGuard)
  gifUnblock(@Param('id') id: string) {
    return this.gifs.unblock(Number(id));
  }

  /** 清空缓存（屏蔽记录保留） */
  @Post('gifs/purge')
  @UseGuards(AdminGuard)
  gifPurge() {
    return this.gifs.purge();
  }

  // ---------- 养眼图片（大厅 tab，名称/保留天数可改，按性别分流） ----------

  @Get('gallery/settings')
  @UseGuards(AdminGuard)
  gallerySettings() {
    return this.gallery.settings();
  }

  @Put('gallery/settings')
  @UseGuards(AdminGuard)
  gallerySaveSettings(@Body() body: { titleM?: string; titleF?: string; daysM?: number; daysF?: number; hideTextM?: boolean; hideTextF?: boolean }) {
    return this.gallery.saveSettings(body ?? {});
  }

  @Get('gallery/sources')
  @UseGuards(AdminGuard)
  gallerySources() {
    return this.gallery.listSources();
  }

  @Get('gallery/sources/preview')
  @UseGuards(AdminGuard)
  galleryPreview(@Query('channel') channel: string) {
    return this.gallery.preview(channel ?? '');
  }

  @Post('gallery/sources')
  @UseGuards(AdminGuard)
  gallerySaveSource(@Body() body: { id?: number; channel: string; audience: number; enabled?: boolean }) {
    return this.gallery.saveSource(body);
  }

  @Delete('gallery/sources/:id')
  @UseGuards(AdminGuard)
  galleryRemoveSource(@Param('id') id: string) {
    return this.gallery.removeSource(Number(id));
  }

  @Post('gallery/sources/:id/sync')
  @UseGuards(AdminGuard)
  gallerySync(@Param('id') id: string) {
    return this.gallery.syncOne(Number(id));
  }

  @Get('gallery/posts')
  @UseGuards(AdminGuard)
  galleryPosts(@Query('audience') audience?: string, @Query('beforeId') beforeId?: string) {
    return this.gallery.adminPosts(audience ? Number(audience) : undefined, beforeId ? BigInt(beforeId) : undefined);
  }

  @Post('gallery/posts/:id/delete')
  @UseGuards(AdminGuard)
  galleryDeletePost(@Param('id') id: string) {
    return this.gallery.adminDeletePost(BigInt(id));
  }

  @Post('gallery/purge')
  @UseGuards(AdminGuard)
  galleryPurge() {
    return this.gallery.purgeOld();
  }

  // ---------- Telegram 账号（音乐频道同步用） ----------

  @Get('telegram/status')
  @UseGuards(AdminGuard)
  tgStatus() {
    return this.tg.status();
  }

  /** 保存 api_id / api_hash（my.telegram.org 申请；留空回退内置值） */
  @Put('telegram/api')
  @UseGuards(AdminGuard)
  tgSaveApi(@Body() body: { apiId?: string; apiHash?: string }) {
    return this.tg.saveApi(body?.apiId ?? '', body?.apiHash ?? '');
  }

  @Post('telegram/send-code')
  @UseGuards(AdminGuard)
  @Throttle(5, 300)
  tgSendCode(@Body() body: { phone: string }) {
    return this.tg.sendCode(body?.phone ?? '');
  }

  /** 输验证码；返回 needPassword=true 时再带 password 调一次 */
  @Post('telegram/sign-in')
  @UseGuards(AdminGuard)
  @Throttle(10, 300)
  tgSignIn(@Body() body: { code?: string; password?: string }) {
    return this.tg.signIn(body?.code ?? '', body?.password);
  }

  @Post('telegram/logout')
  @UseGuards(AdminGuard)
  tgLogout() {
    return this.tg.logout();
  }

  // ---------- 音乐频道 ----------

  @Get('music/sources')
  @UseGuards(AdminGuard)
  musicSources() {
    return this.music.listSources();
  }

  /** 预览：解析频道 + 最近音频列表（不入库），改来源前先核对 */
  @Get('music/sources/preview')
  @UseGuards(AdminGuard)
  musicPreview(@Query('channel') channel: string, @Query('maxTracks') maxTracks?: string) {
    return this.music.preview(channel ?? '', maxTracks ? Number(maxTracks) : undefined);
  }

  /** 新增/修改来源（保存前会解析频道，解析失败不保存；换频道会清掉旧曲目；maxTracks 该来源保留上限 1~500） */
  @Post('music/sources')
  @UseGuards(AdminGuard)
  musicSaveSource(@Body() body: { id?: number; channel: string; enabled?: boolean; maxTracks?: number }) {
    return this.music.saveSource(body);
  }

  @Delete('music/sources/:id')
  @UseGuards(AdminGuard)
  musicRemoveSource(@Param('id') id: string) {
    return this.music.removeSource(Number(id));
  }

  @Post('music/sources/:id/sync')
  @UseGuards(AdminGuard)
  musicSyncNow(@Param('id') id: string) {
    return this.music.syncOne(Number(id));
  }

  @Get('music/tracks')
  @UseGuards(AdminGuard)
  musicTracks(@Query('beforeId') beforeId?: string, @Query('sourceId') sourceId?: string) {
    return this.music.adminTracks(beforeId ? BigInt(beforeId) : undefined, sourceId ? Number(sourceId) : undefined);
  }

  @Post('music/tracks/:id/delete')
  @UseGuards(AdminGuard)
  musicDeleteTrack(@Param('id') id: string) {
    return this.music.adminDeleteTrack(BigInt(id));
  }

  @Post('music/purge')
  @UseGuards(AdminGuard)
  musicPurge() {
    return this.music.purgeOld();
  }

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

  /** 大厅 tab 顺序 */
  @Get('hall-tabs')
  @UseGuards(AdminGuard)
  async hallTabOrder() {
    return { order: await this.hallTabs.order() };
  }

  @Put('hall-tabs')
  @UseGuards(AdminGuard)
  async saveHallTabs(@Body() body: { order?: string[] }) {
    return { order: await this.hallTabs.save(body?.order) };
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
