import Foundation
import Security

struct UserProfile: Codable {
    let id: String
    var shortId: String?
    var address: String?
    var nickname: String
    var avatar: String
    let gender: Int
    var age: Int
    var cityCode: String
    var cityName: String
    var signature: String
    var isGuide: Bool
    var videoPriceFen: Int?
    var realname: Bool?
    var realNameMasked: String?
    var balance: String?
    var frozen: String?
    var following: Int?
    var fans: Int?
    /// 照片墙（最多 8 张）
    var albums: [AlbumItem]?
}

struct EnterResp: Codable {
    let registered: Bool
    let token: String?
    let user: UserProfile?
}

struct AppModuleItem: Codable, Identifiable {
    let id: Int
    let name: String
    let icon: String
    let type: String
    let entry: String
}

struct ApiError: Error, LocalizedError {
    let code: Int
    let msg: String
    var errorDescription: String? { msg }
}


enum Api {
    static let baseURL = "http://8.162.5.160:20080"

    // 一机一号：设备 ID 存 Keychain，卸载重装后仍在，凭此恢复账号
    static var deviceId: String {
        let account = "com.wh.peiwan.deviceid"
        if let data = keychainGet(account), let id = String(data: data, encoding: .utf8) {
            return id
        }
        let id = "ios_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        keychainSet(account, Data(id.utf8))
        return id
    }

    static var token: String? {
        get { UserDefaults.standard.string(forKey: "pw_token") }
        set { UserDefaults.standard.set(newValue, forKey: "pw_token") }
    }

    private struct Envelope<T: Decodable>: Decodable {
        let code: Int
        let msg: String
        let data: T?
    }

    /// 注册头像上传（免登录），返回可访问的相对 URL
    static func uploadAvatar(_ imageData: Data) async throws -> String {
        struct UploadResp: Decodable { let url: String }
        var req = URLRequest(url: URL(string: baseURL + "/api/upload/avatar")!)
        req.httpMethod = "POST"
        let boundary = "Boundary-\(UUID().uuidString)"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        var body = Data()
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"avatar.jpg\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: image/jpeg\r\n\r\n".data(using: .utf8)!)
        body.append(imageData)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        req.httpBody = body
        let (data, _) = try await URLSession.shared.data(for: req)
        let envelope = try JSONDecoder().decode(Envelope<UploadResp>.self, from: data)
        guard envelope.code == 0, let value = envelope.data else {
            throw ApiError(code: envelope.code, msg: envelope.msg)
        }
        return value.url
    }

    /// 相对资源路径转完整 URL
    static func fullUrl(_ path: String) -> String {
        path.hasPrefix("http") || path.isEmpty ? path : baseURL + path
    }

    /// 登录后上传 kind=image|video|audio，progress 回调 0~1（主线程）
    static func upload(_ kind: String, data: Data, filename: String, mime: String, progress: ((Double) -> Void)? = nil) async throws -> String {
        struct R: Decodable { let url: String }
        var req = URLRequest(url: URL(string: baseURL + "/api/upload/\(kind)")!)
        req.httpMethod = "POST"
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let boundary = "B-\(UUID().uuidString)"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        var body = Data()
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: \(mime)\r\n\r\n".data(using: .utf8)!)
        body.append(data)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)

        // 用 task.progress KVO 跟踪上传进度（didSendBodyData 回调在部分系统版本不可靠）
        let d: Data = try await withCheckedThrowingContinuation { cont in
            var observation: NSKeyValueObservation?
            let task = URLSession.shared.uploadTask(with: req, from: body) { data, _, error in
                observation?.invalidate()
                if let error {
                    cont.resume(throwing: error)
                } else {
                    cont.resume(returning: data ?? Data())
                }
            }
            observation = task.progress.observe(\.fractionCompleted) { p, _ in
                let value = p.fractionCompleted
                DispatchQueue.main.async { progress?(value) }
            }
            task.resume()
        }
        let env = try JSONDecoder().decode(Envelope<R>.self, from: d)
        guard env.code == 0, let v = env.data else { throw ApiError(code: env.code, msg: env.msg) }
        return v.url
    }

    static func request<T: Decodable>(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> T {
        var req = URLRequest(url: URL(string: baseURL + "/api" + path)!)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body { req.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, _) = try await URLSession.shared.data(for: req)
        let envelope = try JSONDecoder().decode(Envelope<T>.self, from: data)
        guard envelope.code == 0 else { throw ApiError(code: envelope.code, msg: envelope.msg) }
        guard let value = envelope.data else { throw ApiError(code: -1, msg: "空数据") }
        return value
    }

    // MARK: - Keychain

    private static func keychainGet(_ account: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else { return nil }
        return item as? Data
    }

    private static func keychainSet(_ account: String, _ data: Data) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        var attrs = query
        attrs[kSecValueData as String] = data
        attrs[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(attrs as CFDictionary, nil)
    }
}
