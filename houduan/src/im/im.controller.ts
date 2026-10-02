import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { ImService } from './im.service';
import { GroupService } from './group.service';
import { VoiceRoomService } from './voiceroom.service';
import { ChannelService } from './channel.service';
import { CreateGroupDto, GroupInfoDto, MemberIdsDto } from './im.dto';

@Controller('im')
@UseGuards(JwtAuthGuard)
export class ImController {
  constructor(
    private readonly im: ImService,
    private readonly groups: GroupService,
    private readonly voiceRoom: VoiceRoomService,
    private readonly channels: ChannelService,
  ) {}

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
  createChannel(@CurrentUser() userId: bigint, @Body() dto: { name?: string; avatar?: string; description?: string }) {
    return this.channels.create(userId, dto ?? {});
  }

  /** 发现频道：按订阅数倒序，q 搜名称 / 简介 */
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
  updateChannel(@CurrentUser() userId: bigint, @Param('id') id: string, @Body() dto: { name?: string; avatar?: string; description?: string }) {
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

  @Post('channel/:id/delete')
  deleteChannel(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.channels.remove(userId, BigInt(id));
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
