# SRS 节点一键部署工具

给心之音加 SRS 流媒体节点用。新机统一 **Ubuntu 22.04**，root 密码登录。

## 文件

| 文件 | 作用 |
|---|---|
| `srs_deploy_gui.py` | Windows 图形界面：填 IP/密码 → 上传脚本到新机 → 实时显示日志。不改任何服务器配置，不保存密码 |
| `srs-node-install.sh` | 真正的部署脚本，在新机上以 root 运行（也可以不用 GUI，直接 scp 上去跑） |
| `build.bat` | 打包成 `dist/SRS-Node-Deploy.exe`（需要 `pip install paramiko pyinstaller`） |

## 脚本做什么

1. 从 **源节点** rsync：`/usr/local/src/srs/trunk/`（源码 + `conf/srs.conf`）、`objs/srs`（已编译二进制）、`objs/nginx/html/`、`/etc/systemd/system/srs.service`。
   所有节点安装路径、端口、配置逐字一致，**只改 `rtc_server.candidate` = 本机公网 IP**。
2. 先直接用源节点的二进制；跑不起来才本机编译（`--sanitizer=off`，约 10~15 分钟）。
3. systemd 托管 + sysctl UDP 缓冲 + ufw 放行 22 与 `srs.conf` 里所有 `listen` 端口。
4. 登录 **主服务器**（`45.205.18.158`）的 `peiwan-mysql` 容器，把本机写进 `srs_node` 表（幂等）。后台「SRS 节点」立即可见。
5. 打印状态（目前不做校验，只展示端口/服务/登记情况）。

## 源节点从哪来

- GUI「源节点 IP」留空 → 脚本去主服务器查 `srs_node` 表里 `is_default=1` 的那台（后台「SRS 节点 → 设为默认」可换）。
- 第一台节点下线前，先在后台把默认换到别的节点，之后新机就从新默认节点复制。
- 也可以手工填「源节点 IP」强制指定。

## 命令行用法（不用 GUI）

```bash
scp srs-node-install.sh root@新机:/root/
ssh root@新机
MAIN_PW='主服务器root密码' SRC_PW='源节点root密码' bash /root/srs-node-install.sh
# 可选：SRC_NODE=47.122.115.33 PUBLIC_IP=x.x.x.x PRIORITY=200 MAX_CONN=40 NAME='香港CN2' FORCE_BUILD=1
bash /root/srs-node-install.sh status     # 只看状态
```

## 部署后

- 云控制台安全组手动放行：TCP 1935/1985/7001，UDP 7999（ufw 只是系统层）。
- 后台「SRS 节点」调优先级 / 最大连接数：通话、语音房按优先级选第一个未满的节点，全满取负载率最低者。
- 前提：后端已部署带 `srs_node` 表的版本（`prisma db push` 随容器启动自动执行）。
