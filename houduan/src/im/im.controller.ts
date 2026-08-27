import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { ImService } from './im.service';
import { GroupService } from './group.service';
import { VoiceRoomService } from './voiceroom.service';
import { CreateGroupDto, GroupInfoDto, MemberIdsDto } from './im.dto';

@Controller('im')
@UseGuards(JwtAuthGuard)
export class ImController {
  constructor(
    private readonly im: ImService,
    private readonly groups: GroupService,
    private readonly voiceRoom: VoiceRoomService,
  ) {}

  @Get('conversations')
  conversations(@CurrentUser() userId: bigint) {
    return this.im.listConversations(userId);
  }

  @Get('messages')
  messages(
    @CurrentUser() userId: bigint,
    @Query('conversationId') conversationId: string,
    @Query('beforeId') beforeId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.im.listMessages(
      userId,
      BigInt(conversationId),
      beforeId ? BigInt(beforeId) : undefined,
      limit ? Number(limit) : 30,
    );
  }

  /** 清空聊天记录：单聊双向删除，群聊仅清本人视图 */
  @Post('conversations/:id/clear')
  clear(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.im.clearMessages(userId, BigInt(id));
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

  // ---------- 群聊语音房 ----------

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
