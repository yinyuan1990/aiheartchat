import { getToken } from './api';

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

type Handler = (frame: any) => void;

/** IM WebSocket 管理：自动重连、心跳、监听分发 */
class WsManager {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private heartbeat: number | null = null;
  private reconnectTimer: number | null = null;
  private manualClose = false;

  connect() {
    const token = getToken();
    if (!token || (this.ws && this.ws.readyState <= WebSocket.OPEN)) return;
    this.manualClose = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);

    this.ws.onopen = () => {
      this.heartbeat = window.setInterval(() => this.raw({ op: 'ping' }), 25000);
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
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** 发送聊天消息，返回 tempId */
  send(convType: 1 | 2, targetId: string, msgType: string, content: string): string {
    const tempId = `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.raw({ op: 'send', tempId, convType, targetId, msgType, content });
    return tempId;
  }

  markRead(conversationId: string, msgId: string) {
    this.raw({ op: 'read', conversationId, msgId });
  }

  private raw(frame: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }
}

export const wsManager = new WsManager();
