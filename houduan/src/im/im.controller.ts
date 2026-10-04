import { BadRequestException, Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { ImService } from './im.service';
import { GroupService } from './group.service';
import { VoiceRoomService } from './voiceroom.service';
import { ChannelService } from './channel.service';
import { BotService } from './bot.service';
import { MessageService } from './message.service';
import { ChainCardService, type TransferBody } from './chain-card.service';
import { CoinGroupService, type CoinGroupBody } from './coin-group.service';
import { PerpCallService, type PerpCallBody } from './perp-call.service';
import { CreateGroupDto, GroupInfoDto, MemberIdsDto } from './im.dto';

function toId(v: unknown): bigint {
  const s = String(v ?? '');
  if (!/^\d{1,19}$/.test(s)) throw new BadRequestException('参数不正确');
  return BigInt(s);
}

function toIds(v: unknown): bigint[] {
  return Array.isArray(v) ? [...new Set(v.map(String))].map(toId) : [];
}

@Controller('im')
@UseGuards(JwtAuthGuard)
export class ImController {
  constructor(
    private readonly im: ImService,
    private readonly groups: GroupService,
    private readonly voiceRoom: VoiceRoomService,
    private readonly channels: ChannelService,
    private readonly bots: BotService,
    private readonly msgs: MessageService,
    private readonly cards: ChainCardService,
    private readonly coinGroups: CoinGroupService,
    private readonly perpCalls: PerpCallService,
  ) {}

  /** 币的讨论群：没有就建（系统账号当群主），然后加入；返回群和会话 id。见 coin-group.service.ts */
  @Post('coin-group')
  coinGroup(@CurrentUser() userId: bigint, @Body() body: CoinGroupBody) {
    return this.coinGroups.open(userId, body ?? {});
  }

  /** 合约喊单：卡片发进这个合约的群（没有就建），喊单者地址从主钱包签名恢复，见 perp-call.service.ts */
  @Post('perp-call')
  perpCall(@CurrentUser() userId: bigint, @Body() body: PerpCallBody) {
    return this.perpCalls.call(userId, body ?? {});
  }

  /** 链上钱包转账成功后发转账卡片（单聊）；服务端到链上核对过才发，见 chain-card.service.ts */
  @Post('transfer')
  chainTransfer(@CurrentUser() userId: bigint, @Body() body: TransferBody) {
    return this.cards.sendTransfer(userId, body ?? {});
  }

  @Get('conversations')
  conversations(@CurrentUser() userId: bigint) {
    return this.im.listConversations(userId);
  }

  /** 消息页搜索：消息内容 + 全局用户（会话名客户端本地匹配） */
  @Get('search')
  search(@CurrentUser() userId: bigint, @Query('q') q?: string) {
    return this.im.search(userId, q ?? '');
  }

  @Get('messages')
  messages(
    @CurrentUser() userId: bigint,
    @Query('conversationId') conversationId: string,
    @Query('beforeId') beforeId?: string,
    @Query('limit') limit?: string,
    @Query('aroundId') aroundId?: string,
  ) {
    return this.im.listMessages(
      userId,
      BigInt(conversationId),
      beforeId ? BigInt(beforeId) : undefined,
      limit ? Number(limit) : 30,
      aroundId ? BigInt(aroundId) : undefined,
    );
  }

  /** 清空聊天记录：单聊双向删除，群聊仅清本人视图 */
  @Post('conversations/:id/clear')
  clear(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.im.clearMessages(userId, BigInt(id));
  }

  // ---------- 消息长按菜单 ----------

  /** 删除：forAll=true 为双方删除（自己的消息 / 群管理删任何人），否则只删自己这边 */
  @Post('messages/delete')
  deleteMessages(@CurrentUser() userId: bigint, @Body() dto: { conversationId?: string; ids?: string[]; forAll?: boolean }) {
    return this.msgs.deleteMessages(userId, toId(dto?.conversationId), toIds(dto?.ids), !!dto?.forAll);
  }

  /** 转发：targets=[{convType:1 单聊对方 userId | 2 群/频道 groupId, targetId}] */
  @Post('messages/forward')
  forward(
    @CurrentUser() userId: bigint,
    @Body() dto: { fromConversationId?: string; ids?: string[]; targets?: { convType: 1 | 2; targetId: string }[] },
  ) {
    return this.msgs.forward(userId, toId(dto?.fromConversationId), toIds(dto?.ids), Array.isArray(dto?.targets) ? dto.targets : []);
  }

  /** 表情回应：emoji 为空或与已选相同则取消 */
  @Post('messages/:id/react')
  reactMessage(@CurrentUser() userId: bigint, @Param('id') id: string, @Body() dto: { emoji?: string }) {
    return this.msgs.react(userId, toId(id), String(dto?.emoji ?? ''));
  }

  @Post('messages/:id/pin')
  pinMessage(@CurrentUser() userId: bigint, @Param('id') id: string, @Body() dto: { pin?: boolean }) {
    return this.msgs.pin(userId, toId(id), dto?.pin !== false);
  }

  @Get('conversations/:id/pins')
  pins(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.msgs.pins(userId, toId(id));
  }

  @Get('messages/:id/readers')
  readers(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.msgs.readers(userId, toId(id));
  }

  @Post('messages/:id/report')
  reportMessage(@CurrentUser() userId: bigint, @Param('id') id: string, @Body() dto: { reason?: string }) {
    return this.msgs.report(userId, toId(id), String(dto?.reason ?? ''));
  }

  /** 扫邀请名片：按名片码（短号）直接打开单聊 */
  @Post('conversations/open-by-code')
  openByCode(@CurrentUser() userId: bigint, @Body() dto: { code?: string }) {
    return this.im.openByInviteCode(userId, String(dto?.code ?? ''));
  }

  /** 打开与某用户的会话（不存在则创建），返回会话 id */
  @Post('conversations/open/:peerId')
  async open(@CurrentUser() userId: bigint, @Param('peerId') peerId: string) {
    const conv = await this.im.getOrCreateSingleConversation(userId, BigInt(peerId));
    return { conversationId: conv.id };
  }

  // ---------- 群聊 ----------

  @Post('group')
  createGroup(@CurrentUser() userId: bigint, @Body() dto: CreateGroupDto) {
    return this.groups.createGroup(userId, dto.name, (dto.memberIds ?? []).map(BigInt), dto.avatar ?? '');
  }

  // ---- 群分享/入群（静态路径注意声明在 group/:id 相关通配前） ----

  /** 群广场：可加入的群列表 */
  @Get('group/list')
  listGroups(@CurrentUser() userId: bigint) {
    return this.groups.listGroups(userId);
  }

  /** 邀请码预检：群名/人数/是否需要密码 */
  @Get('group/code/:code')
  codeInfo(@CurrentUser() userId: bigint, @Param('code') code: string) {
    return this.groups.codeInfo(userId, code);
  }

  /** 扫码/输码入群，有密码必须带 password */
  @Post('group/join-by-code')
  joinByCode(@CurrentUser() userId: bigint, @Body() dto: { code: string; password?: string }) {
    return this.groups.joinByCode(userId, dto.code, dto.password);
  }

  /** 分享信息：邀请码 + 是否有密码（成员可看） */
  @Get('group/:id/share')
  shareInfo(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.groups.shareInfo(userId, BigInt(id));
  }

  /** 设置入群密码（群主/管理员）；password 传空串 = 无密码 */
  @Post('group/:id/share')
  setShare(@CurrentUser() userId: bigint, @Param('id') id: string, @Body() dto: { password?: string }) {
    return this.groups.setSharePassword(userId, BigInt(id), dto.password ?? '');
  }

  @Get('group/:id')
  group(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.groups.getGroup(userId, BigInt(id));
  }

  @Put('group/:id')
  updateGroup(@CurrentUser() userId: bigint, @Param('id') id: string, @Body() dto: GroupInfoDto) {
    return this.groups.updateInfo(userId, BigInt(id), dto);
  }

  @Post('group/:id/invite')
  invite(@CurrentUser() userId: bigint, @Param('id') id: string, @Body() dto: MemberIdsDto) {
    return this.groups.invite(userId, BigInt(id), dto.userIds.map(BigInt));
  }

  @Post('group/:id/join')
  join(@CurrentUser() userId: bigint, @Param('id') id: string, @Body() dto: { password?: string }) {
    return this.groups.join(userId, BigInt(id), dto?.password);
  }

  @Post('group/:id/leave')
  leave(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.groups.leave(userId, BigInt(id));
  }

  @Post('group/:id/kick/:targetId')
  kick(@CurrentUser() userId: bigint, @Param('id') id: string, @Param('targetId') targetId: string) {
    return this.groups.kick(userId, BigInt(id), BigInt(targetId));
  }

  @Post('group/:id/transfer/:targetId')
  transfer(@CurrentUser() userId: bigint, @Param('id') id: string, @Param('targetId') targetId: string) {
    return this.groups.transfer(userId, BigInt(id), BigInt(targetId));
  }

  @Post('group/:id/dissolve')
  dissolve(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.groups.dissolve(userId, BigInt(id));
  }

  // ---------- 频道（kind=2 的群：频道主发帖，订阅者看 + 表情回应 + 评论） ----------

  @Post('channel')
  createChannel(@CurrentUser() userId: bigint, @Body() dto: { name?: string; avatar?: string; description?: string; memberPost?: boolean }) {
    return this.channels.create(userId, dto ?? {});
  }

  /** 发现频道：按订阅数倒序，q 搜名称 / 简介 */
  @Get('channel/quota')
  channelQuota(@CurrentUser() userId: bigint) {
    return this.channels.quota(userId);
  }

  @Get('channel/list')
  listChannels(@CurrentUser() userId: bigint, @Query('q') q?: string) {
    return this.channels.list(userId, q);
  }

  @Post('channel/posts/:msgId/react')
  react(@CurrentUser() userId: bigint, @Param('msgId') msgId: string, @Body() dto: { emoji?: string }) {
    return this.channels.react(userId, BigInt(msgId), dto?.emoji ?? '');
  }

  @Get('channel/posts/:msgId/comments')
  postComments(@Param('msgId') msgId: string, @Query('beforeId') beforeId?: string) {
    return this.channels.comments(BigInt(msgId), beforeId ? BigInt(beforeId) : undefined);
  }

  @Post('channel/posts/:msgId/comments')
  addPostComment(
    @CurrentUser() userId: bigint,
    @Param('msgId') msgId: string,
    @Body() dto: { content?: string; stickerId?: string; replyToId?: string },
  ) {
    return this.channels.addComment(userId, BigInt(msgId), dto ?? {});
  }

  @Post('channel/posts/:msgId/delete')
  deletePost(@CurrentUser() userId: bigint, @Param('msgId') msgId: string) {
    return this.channels.deletePost(userId, BigInt(msgId));
  }

  @Post('channel/comments/:id/delete')
  deletePostComment(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.channels.deleteComment(userId, BigInt(id));
  }

  @Get('channel/:id')
  channelInfo(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.channels.info(userId, BigInt(id));
  }

  @Put('channel/:id')
  updateChannel(@CurrentUser() userId: bigint, @Param('id') id: string, @Body() dto: { name?: string; avatar?: string; description?: string; memberPost?: boolean }) {
    return this.channels.update(userId, BigInt(id), dto ?? {});
  }

  /** 帖子列表（订阅前也能预览），最新在后，beforeId 往前翻 */
  @Get('channel/:id/posts')
  channelPosts(@CurrentUser() userId: bigint, @Param('id') id: string, @Query('beforeId') beforeId?: string) {
    return this.channels.posts(userId, BigInt(id), beforeId ? BigInt(beforeId) : undefined);
  }

  @Post('channel/:id/subscribe')
  subscribe(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.channels.subscribe(userId, BigInt(id));
  }

  @Post('channel/:id/unsubscribe')
  unsubscribe(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.channels.unsubscribe(userId, BigInt(id));
  }

  @Post('channel/:id/mute')
  muteChannel(@CurrentUser() userId: bigint, @Param('id') id: string, @Body() dto: { muted?: boolean }) {
    return this.channels.setMuted(userId, BigInt(id), !!dto?.muted);
  }

  /** 频道主一键清空所有消息（连同评论、回应和文件物理删除） */
  @Post('channel/:id/clear')
  clearChannel(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.channels.clearAll(userId, BigInt(id));
  }

  @Post('channel/:id/delete')
  deleteChannel(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.channels.remove(userId, BigInt(id));
  }

  // ---------- 机器人（管理自己的机器人；第三方调用走 /api/bot<token>/<method>） ----------

  @Get('bots')
  myBots(@CurrentUser() userId: bigint) {
    return this.bots.mine(userId);
  }

  @Post('bots')
  createBot(@CurrentUser() userId: bigint, @Body() dto: { name?: string; username?: string; description?: string; avatar?: string }) {
    return this.bots.create(userId, dto ?? {});
  }

  /** 机器人公开资料（id 或用户名）：聊天页头部、命令菜单 */
  @Get('bot/info/:key')
  botInfo(@Param('key') key: string) {
    return this.bots.publicInfo(key);
  }

  /** 用户点了机器人消息上的回调按钮 */
  @Post('bot/callback')
  botCallback(@CurrentUser() userId: bigint, @Body() dto: { messageId?: string; data?: string }) {
    return this.bots.userCallback(userId, BigInt(String(dto?.messageId ?? '0')), String(dto?.data ?? ''));
  }

  @Get('bots/:id')
  myBot(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.bots.mineOne(userId, BigInt(id));
  }

  @Put('bots/:id')
  updateBot(@CurrentUser() userId: bigint, @Param('id') id: string, @Body() dto: { name?: string; description?: string; avatar?: string; privacy?: boolean }) {
    return this.bots.update(userId, BigInt(id), dto ?? {});
  }

  @Post('bots/:id/token')
  resetBotToken(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.bots.resetToken(userId, BigInt(id));
  }

  @Post('bots/:id/delete')
  deleteBot(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.bots.remove(userId, BigInt(id));
  }

  /** 群主 / 管理员按用户名把机器人加进群；频道里机器人是管理员（能发帖） */
  @Post('group/:id/bot')
  addBot(@CurrentUser() userId: bigint, @Param('id') id: string, @Body() dto: { username?: string }) {
    return this.bots.addToChat(userId, BigInt(id), String(dto?.username ?? ''));
  }

  // ---------- 群聊语音房 ----------

  /** 语音房二维码扫码：token 校验通过免密入群，返回群会话与房间状态 */
  @Post('voiceroom/scan')
  voiceRoomScan(@CurrentUser() userId: bigint, @Body() dto: { groupId: string; token: string }) {
    return this.voiceRoom.scanJoin(userId, BigInt(dto.groupId), dto.token ?? '');
  }

  /** 房间状态：成员列表 + 人数上限（群聊页入口展示 N/max） */
  @Get('group/:id/voiceroom')
  voiceRoomInfo(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.voiceRoom.info(userId, BigInt(id));
  }

  /** 加入语音房：返回成员、SRS 推拉流地址、本人流名、场次 ID */
  @Post('group/:id/voiceroom/join')
  voiceRoomJoin(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.voiceRoom.join(userId, BigInt(id));
  }

  @Post('group/:id/voiceroom/leave')
  voiceRoomLeave(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.voiceRoom.leave(userId, BigInt(id));
  }

  /** 30 秒心跳：保活房内席位；返回 inRoom=false 时客户端应退出 */
  @Post('group/:id/voiceroom/heartbeat')
  voiceRoomHeartbeat(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.voiceRoom.heartbeat(userId, BigInt(id));
  }

  /** 静音状态同步：广播全群刷新静音图标 */
  @Post('group/:id/voiceroom/mute')
  voiceRoomMute(@CurrentUser() userId: bigint, @Param('id') id: string, @Body() dto: { muted: boolean }) {
    return this.voiceRoom.setMuted(userId, BigInt(id), !!dto.muted);
  }

  /** 客户端日志上报：按房间场次汇总（管理端「通话日志-语音房」查看） */
  @Post('group/:id/voiceroom/log')
  voiceRoomLog(
    @CurrentUser() userId: bigint,
    @Param('id') id: string,
    @Body() dto: { platform: string; lines: string[] },
  ) {
    return this.voiceRoom.appendLog(userId, BigInt(id), dto.platform ?? 'unknown', dto.lines ?? []);
  }
}
