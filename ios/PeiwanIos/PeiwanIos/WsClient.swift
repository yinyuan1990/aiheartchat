import Foundation

struct MessagePayload: Codable {
    let id: String
    let conversationId: String
    let convType: Int
    let groupId: String?
    let senderId: String
    let senderNickname: String
    let senderAvatar: String
    let receiverId: String?
    let type: String
    let content: String
    let createdAt: String
}

/// IM WebSocket：自动重连 + 心跳 + 帧分发（协议见后端 im.types.ts）
final class WsClient: NSObject {
    static let shared = WsClient()

    private var task: URLSessionWebSocketTask?
    private var manualClose = false
    private var listeners: [UUID: ([String: Any]) -> Void] = [:]
    private var heartbeatTimer: Timer?

    func connect() {
        guard let token = Api.token else { return }
        // 已有存活连接则跳过；僵死连接（后台被挂起）直接重建
        if let task, task.state == .running { return }
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        manualClose = false
        let wsBase = Api.baseURL.replacingOccurrences(of: "http", with: "ws")
        guard let url = URL(string: "\(wsBase)/ws?token=\(token)") else { return }
        task = URLSession.shared.webSocketTask(with: url)
        task?.resume()
        receiveLoop()

        DispatchQueue.main.async { [weak self] in
            self?.heartbeatTimer?.invalidate()
            self?.heartbeatTimer = Timer.scheduledTimer(withTimeInterval: 25, repeats: true) { _ in
                self?.sendFrame(["op": "ping"])
            }
        }
    }

    func close() {
        manualClose = true
        heartbeatTimer?.invalidate()
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }

    @discardableResult
    func addListener(_ handler: @escaping ([String: Any]) -> Void) -> () -> Void {
        let id = UUID()
        listeners[id] = handler
        return { [weak self] in self?.listeners.removeValue(forKey: id) }
    }

    /// 发送消息，返回 tempId
    @discardableResult
    func send(convType: Int, targetId: String, msgType: String, content: String) -> String {
        let tempId = "t_\(Int(Date().timeIntervalSince1970 * 1000))_\(Int.random(in: 1000...9999))"
        sendFrame([
            "op": "send",
            "tempId": tempId,
            "convType": convType,
            "targetId": targetId,
            "msgType": msgType,
            "content": content,
        ])
        return tempId
    }

    func markRead(conversationId: String, msgId: String) {
        sendFrame(["op": "read", "conversationId": conversationId, "msgId": msgId])
    }

    private func sendFrame(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let text = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(text)) { _ in }
    }

    private func receiveLoop() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                if case .string(let text) = message,
                   let data = text.data(using: .utf8),
                   let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    DispatchQueue.main.async {
                        self.listeners.values.forEach { $0(frame) }
                    }
                }
                self.receiveLoop()
            case .failure:
                self.task = nil
                if !self.manualClose {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 3) { self.connect() }
                }
            }
        }
    }
}
