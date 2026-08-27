# 心之音

一对一聊天、语音、视频为底座的社交平台。地陪（同城搭子）是第一个业务模块，大厅可按配置接入更多项目。

仓库：<https://github.com/yinyuan1990/aiheartchat>

三端（Android / iOS / Web）功能与视觉对齐。Web 不提供音视频通话，点击通话入口会引导下载 App。

## 产品要点

- **一机一号、无密码**：注册填昵称、年纪、头像、性别；账号为自动生成的 BNB 链地址。同一设备只能注册一个号，卸载重装凭设备 ID 恢复。
- **性别隔离**：广场、遇见、搜索等由服务端强制只展示异性；群聊不受此限制。
- **IM**：单聊 + 群聊（邀请码 / 二维码入群，可选入群密码），消息 AES-256-GCM 加密落库。
- **音视频**：App 端走 SRS（WHIP 推流 / WHEP 拉流），信令走 WebSocket。
- **积分钱包 + 礼物**：无用户充值入口，积分为后台发放或收礼入账；视频按分钟计费。
- **遇见 / 动态 / 励志行**：遇见卡片流（所有 / 新人 / 同城 / 亲密度）；动态支持瀑布流与抖音竖滑；励志行按性别每日一句。
- **消息页附加能力**：免费 AI 助手（支持 HTML 预览）、按性别分流的花边新闻（点击打开原文）。
- **大厅**：同城搭子约单 / 接单等业务模块，入口后台可配。

## 架构

```
Android (Kotlin / Compose)     iOS (Swift / SwiftUI)     Web (React / Vite)
                    \                  |                  /
                     \                 |                 /
                      \                |                /
                       NestJS API  +  WebSocket IM
                       MySQL · Redis · MinIO
                              |
                         SRS 流媒体（音视频）
```

管理后台（Vue）独立部署，用于用户、礼物、积分、动态、通话参数与通话日志等运维能力。

## 仓库结构

| 目录 | 说明 |
|---|---|
| `houduan/` | NestJS 后端，Prisma + MySQL，WebSocket IM、通话信令、钱包、AI、新闻采集 |
| `android/` | Android App（Kotlin + Jetpack Compose） |
| `ios/PeiwanIos/` | iOS App（SwiftUI），最低系统 **iOS 15.6** |
| `web/` | 用户 Web 端（React + TypeScript + Vite） |
| `admin/` | 管理后台（Vue + Vite） |
| `deploy/` | Nginx / Docker 部署配置（含密钥的 compose 文件不入库） |
| `docs/` | 策划、UI 规范、开发接力说明 |

更细的进度与排查记录见 [`docs/接力文档.md`](docs/接力文档.md)，产品方案见 [`docs/整体策划方案.md`](docs/整体策划方案.md)，视觉规范见 [`docs/UI设计规范.md`](docs/UI设计规范.md)。

## 技术栈

| 层 | 技术 |
|---|---|
| 后端 | NestJS 10、Prisma 5、MySQL、Redis、MinIO、JWT |
| 实时 | WebSocket（IM + 通话信令） |
| 音视频 | SRS · WebRTC（WHIP / WHEP） |
| Android | Kotlin、Jetpack Compose |
| iOS | Swift、SwiftUI（部署目标 15.6） |
| Web | React 18、Vite、Zustand |
| 管理端 | Vue 3、Vite |
| AI | OpenAI 兼容协议（默认 DeepSeek） |

## 本地开发（后端）

需要本机或 Docker 提供 MySQL、Redis、MinIO。密钥放在 `houduan/.env`（已加入 `.gitignore`，不入库）。

```bash
cd houduan
npm install
npx prisma generate
npx prisma db push
npm run start:dev
```

Web / 管理端：

```bash
cd web && npm install && npm run dev
cd admin && npm install && npm run dev
```

客户端请用 Android Studio / Xcode 打开对应工程编译运行。iOS 最低版本为 15.6（NavigationStack/PhotosPicker 等 iOS 16 API 已做兼容降级，见 Compat.swift）。

## 安全说明

本仓库为 **Public**。下列文件只存在于本机和服务器，不会进 Git：

- `houduan/.env`（数据库、JWT、AI Key 等）
- `deploy/app/docker-compose.yml`（部署口令）

换机器开发需要单独拷贝上述文件。建议将仓库改为 Private。

## 许可

私有项目，未开放第三方使用许可。
