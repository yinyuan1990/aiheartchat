/**
 * IM WebSocket JSON 协议
 *
 * 客户端 -> 服务端：
 *   { op: "send", tempId, convType: 1|2, targetId, msgType, content }
 *     convType 1=单聊(targetId=对方用户id) 2=群聊(targetId=群id)
 *     msgType: text|image|video|sticker|gift|call_invite|call_accept|call_reject|call_end
 *     sticker 的 content 为贴纸 JSON {id,format,url,thumb,w,h,emoji}（见 sticker.service StickerPayload）
 *   { op: "read", conversationId, msgId }
 *   { op: "ping" }
 *
 * 服务端 -> 客户端：
 *   { op: "msg", data: MessagePayload }
 *   { op: "ack", tempId, msgId, conversationId, createdAt }
 *   { op: "read", conversationId, msgId, userId }
 *   { op: "error", tempId?, msg }
 *   { op: "pong" }
 *   { op: "msg_edit", data: { conversationId, msgId, content, markup } }   机器人编辑了自己的消息
 *   { op: "msg_delete", data: { conversationId, msgId } }                  机器人删了自己的消息
 *   { op: "bot_callback_answer", data: { queryId, text, showAlert, url } } 点回调按钮后机器人的回应
 *   { op: "msg_delete", data: { conversationId, msgId } }                  也用于用户删除（为双方删除 / 自己其他设备上的「只删自己」）
 *   { op: "msg_reactions", data: { conversationId, msgId, reactions } }    表情回应变了（不发给操作人，操作人以接口返回为准）
 *   { op: "msg_pin", data: { conversationId, msgId, pinned } }             置顶 / 取消置顶
 *
 * send 帧可带 replyToId（回复同会话里的某条消息）。
 */

export interface SendFrame {
  op: 'send';
  tempId?: string;
  convType: 1 | 2;
  targetId: string;
  msgType: string;
  content: string;
  replyToId?: string;
  /** 只在服务端转发时设置，客户端帧里的会被网关丢掉 */
  fwdFrom?: string;
}

export interface ReplyPreview {
  id: string;
  senderId: string;
  senderNickname: string;
  type: string;
  /** 文字取前 100 字、图片是 url，其余类型为空 */
  content: string;
  /** 原消息已被删除 */
  deleted?: boolean;
}

export interface ReactionView {
  emoji: string;
  count: number;
  /** 点了这个表情的人（最多 20 个），客户端据此判断「我点过」 */
  userIds: string[];
}

export interface ReadFrame {
  op: 'read';
  conversationId: string;
  msgId: string;
}

export interface MessagePayload {
  id: string;
  conversationId: string;
  convType: number;
  groupId: string | null;
  senderId: string;
  senderNickname: string;
  senderAvatar: string;
  receiverId: string | null;
  type: string;
  content: string;
  createdAt: string;
  /** 机器人发的消息才有：发送者是机器人、消息下方的按钮 */
  senderIsBot?: boolean;
  markup?: { inline_keyboard: { text: string; url?: string; callback_data?: string }[][] } | null;
  replyTo?: ReplyPreview | null;
  fwdFrom?: string | null;
  reactions?: ReactionView[];
  /** 频道里订阅者（非频道主 / 管理员 / 机器人）发的：客户端当普通聊天消息显示，不带评论 / 浏览数 */
  memberMsg?: boolean;
}

/** Redis 跨节点投递载荷 */
export interface RouteEnvelope {
  userIds: string[];
  frame: unknown;
}
