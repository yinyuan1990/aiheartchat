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
 */

export interface SendFrame {
  op: 'send';
  tempId?: string;
  convType: 1 | 2;
  targetId: string;
  msgType: string;
  content: string;
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
}

/** Redis 跨节点投递载荷 */
export interface RouteEnvelope {
  userIds: string[];
  frame: unknown;
}
