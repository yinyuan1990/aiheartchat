# Arm

Circle Arc 链（USDC 原生 gas）上的代币发射平台：发币免费，发币即建 Uniswap V3 池、LP 永久锁定；每笔交易 1% 池费按 **78 / 16 / 5 / 1** 分给 创作者 / 储备 / 回购 / 技术团队；创作者可开启推广分佣（推广者按带来的成交量分佣金）。线上：https://arm.yyheart.com

| 目录 | 内容 |
|---|---|
| `contracts/` | Foundry 合约（同步推送到 https://github.com/yinyuan1990/arn ），部署地址见 `contracts/deployments/arc-mainnet.json` |
| `indexer/` | 索引器 + REST / WS API + Keeper（分发手续费、分账合约 sync、推广结算、Treasury 周结）+ AI 雷达（微博） |
| `web/` | Next.js 前端（黑 / 白两套主题，中英文） |
| `ops/` | 部署脚本：`node ops/deploy.mjs --upload-only` 上传源码，服务器上 `ops/native-deploy.sh` 构建并重启 systemd 服务 |

## 部署（服务器 45.205.17.161，香港）

这台机器从 Docker Hub 拉镜像不稳定，所以不用 Docker：Node 24 + PostgreSQL 直接装在机器上，`arm-indexer` / `arm-web` 两个 systemd 服务，宿主 nginx 反代 + certbot 证书。

```bash
# 首次：装 Node / Postgres / systemd 服务（幂等）
ssh root@45.205.17.161 "nohup bash /opt/arm/ops/native-setup.sh > /root/arm-setup.log 2>&1 &"
# 每次发版（本机）
node ops/deploy.mjs --upload-only
ssh root@45.205.17.161 "nohup bash /opt/arm/ops/native-deploy.sh 'indexer web' > /root/arm-build.log 2>&1 &"
# 域名 + 证书（DNS 解析到本机后）
ssh root@45.205.17.161 "bash /opt/arm/ops/domains.sh set arm.yyheart.com"
```

服务器上的密钥只在 `/opt/arm/.env`（chmod 600），从不进仓库。这家机房的 SSH 连接 60 秒无输出会被断开，长任务一律 `nohup` 后台跑、再看日志。
