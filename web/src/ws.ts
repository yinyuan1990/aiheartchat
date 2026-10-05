import { getToken } from './api';
import { lang } from './i18n';

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
  /** 机器人发的消息才有 */
  senderIsBot?: boolean;
  markup?: { inline_keyboard: { text: string; url?: string; callback_data?: string }[][] } | null;
  replyTo?: ReplyPreview | null;
  fwdFrom?: string | null;
  reactions?: Reaction[];
}

export interface ReplyPreview {
  id: string;
  senderId: string;
  senderNickname: string;
  type: string;
  content: string;
  deleted?: boolean;
}

export interface Reaction {
  emoji: string;
  count: number;
  userIds: string[];
}

type Handler = (frame: any) => void;

/** IM WebSocket 管理：自动重连、心跳、监听分发 */
class WsManager {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private heartbeat: number | null = null;
  private reconnectTimer: number | null = null;
  private manualClose = false;
  private queue: string[] = [];

  connect() {
    const token = getToken();
    if (!token || (this.ws && this.ws.readyState <= WebSocket.OPEN)) return;
    this.manualClose = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}&lang=${lang()}`);

    this.ws.onopen = () => {
      this.heartbeat = window.setInterval(() => this.raw({ op: 'ping' }), 25000);
      const pending = this.queue;
      this.queue = [];
      pending.forEach((f) => this.ws?.send(f));
      // 合约喊单卡片：重连后服务端不记得在看哪些卡片，重新告诉它
      if (this.perpWatching && !pending.some((f) => f.includes('"perpWatch"'))) this.ws?.send(JSON.stringify(this.perpWatching));
    };
    this.ws.onmessage = (e) => {
      try {
        const frame = JSON.parse(e.data);
        this.handlers.forEach((h) => h(frame));
      } catch {}
    };
    this.ws.onclose = () => {
      if (this.heartbeat) window.clearInterval(this.heartbeat);
      this.heartbeat = null;
      this.ws = null;
      if (!this.manualClose) {
        this.reconnectTimer = window.setTimeout(() => this.connect(), 3000);
      }
    };
  }

  close() {
    this.manualClose = true;
    this.queue = [];
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** 发送聊天消息，返回 tempId */
  send(convType: 1 | 2, targetId: string, msgType: string, content: string, replyToId?: string): string {
    const tempId = `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.raw({ op: 'send', tempId, convType, targetId, msgType, content, ...(replyToId ? { replyToId } : {}) });
    return tempId;
  }

  markRead(conversationId: string, msgId: string) {
    this.raw({ op: 'read', conversationId, msgId });
  }

  /** 正在看的会话里的合约喊单卡片（服务端据此每 3 秒推 perpTick，见后端 perp-watch.service.ts） */
  private perpWatching: { op: string; conversationId: string; ids: string[] } | null = null;

  perpWatch(conversationId: string, ids: string[]) {
    this.perpWatching = { op: 'perpWatch', conversationId, ids: ids.slice(-100) };
    this.raw(this.perpWatching);
  }

  perpUnwatch(conversationId: string) {
    if (this.perpWatching?.conversationId === conversationId) this.perpWatching = null;
    this.raw({ op: 'perpUnwatch', conversationId });
  }

  /** 没连上时 send / read 先排队，连上后补发（刚打开页面就发消息不会丢） */
  private raw(frame: { op: string; [k: string]: unknown }) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    } else if (frame.op !== 'ping' && this.queue.length < 50) {
      this.queue.push(JSON.stringify(frame));
      this.connect();
    }
  }
}

export const wsManager = new WsManager();
