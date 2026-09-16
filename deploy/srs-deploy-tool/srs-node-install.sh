#!/bin/bash
# ============================================================================
# 心之音 SRS 流媒体节点一键部署脚本（Ubuntu 22.04，在【新机】上以 root 运行）
#
# 做什么：
#   1. apt 装运行依赖（rsync sshpass ufw ...；只有需要编译时才装 gcc/cmake 等）
#   2. 从【源节点】（后台「SRS 节点」里的默认节点；也可用 SRC_NODE 指定）rsync：
#        /usr/local/src/srs/trunk/            源码 + conf/srs.conf（排除 objs/ 编译中间产物）
#        /usr/local/src/srs/trunk/objs/srs    已编译好的二进制（先直接用，跑不起来再本机编译）
#        /usr/local/src/srs/trunk/objs/nginx/html/   测试页
#        /etc/systemd/system/srs.service      systemd 单元（源节点没有则自动生成）
#      → 所有节点安装路径、端口、配置逐字一致，只有 rtc_server.candidate 改成本机公网 IP
#   3. systemd 托管 + sysctl UDP 缓冲 + ufw 放行 22 与 srs.conf 里所有 listen 端口
#   4. 登录【主服务器】(45.205.18.158) 的 peiwan-mysql 容器，把本机写进 srs_node 表（幂等）
#      → 后台「SRS 节点」立刻能看到；通话/语音房按优先级 + 最大连接数自动分配
#   5. 打印端口监听情况（目前不做校验，只展示）
#
# 用法（在新机上；只需要"源节点 + 主服务器"的 root 密码，本机不需要）：
#   SRC_PW='源节点root密码' MAIN_PW='主服务器root密码' bash srs-node-install.sh
#   ... SRC_NODE=47.122.115.33          指定源节点（默认：问主服务器要「默认节点」）
#   ... MAIN_SRV=45.205.18.158            主服务器 IP（默认就是它）
#   ... PUBLIC_IP=1.2.3.4               公网 IP 自动探测不准时手工指定
#   ... PRIORITY=200 MAX_CONN=40 NAME='香港CN2' REMARK='...'
#   ... FORCE_BUILD=1                   不用源节点二进制，强制本机编译
#   bash srs-node-install.sh status     只看状态（版本 / 服务 / 端口 / 是否已登记）
# ============================================================================
# 从 Windows 传上来常带 CRLF，自动修复后重新执行
if grep -q $'\r' "$0" 2>/dev/null; then sed -i 's/\r$//' "$0"; exec bash "$0" "$@"; fi
set -o pipefail

# ---------- 可覆盖参数 ----------
MAIN_SRV="${MAIN_SRV:-45.205.18.158}"
SRC_NODE="${SRC_NODE:-}"
PRIORITY="${PRIORITY:-200}"
MAX_CONN="${MAX_CONN:-40}"
NAME="${NAME:-新节点 $(date +%m%d)}"
REMARK="${REMARK:-部署工具 $(date +%F)}"
FORCE_BUILD="${FORCE_BUILD:-0}"
MYSQL_CONTAINER="${MYSQL_CONTAINER:-peiwan-mysql}"
DB_NAME="${DB_NAME:-peiwan}"
SRS_ROOT=/usr/local/src/srs
T=$SRS_ROOT/trunk
CONF=$T/conf/srs.conf
UNIT=/etc/systemd/system/srs.service
PWF_SRC=/root/.srs_deploy_pw_src
PWF_MAIN=/root/.srs_deploy_pw_main
SSHOPT="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=15"
LOG=/root/srs-node-install.log

G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
info(){ echo -e "${G}[INFO]${N} $*" | tee -a $LOG; }
warn(){ echo -e "${Y}[WARN]${N} $*" | tee -a $LOG; }
fail(){ echo -e "${R}[FAIL]${N} $*" | tee -a $LOG; }
die(){ fail "$*"; echo "详细日志: $LOG"; exit 1; }

[ "$EUID" -eq 0 ] || die "请用 root 运行"
MODE="${1:-install}"
echo "==== $(date) mode=$MODE ====" >> $LOG

# ---------- 密码 ----------
SRC_PW="${SRC_PW:-$SRS_PW}"; MAIN_PW="${MAIN_PW:-$SRS_PW}"
if [ -z "$MAIN_PW" ]; then read -rsp "请输入主服务器 $MAIN_SRV 的 root 密码: " MAIN_PW; echo; fi
[ -n "$MAIN_PW" ] || die "主服务器密码为空"
umask 077; printf '%s' "$MAIN_PW" > $PWF_MAIN; umask 022
trap 'rm -f $PWF_SRC $PWF_MAIN /tmp/srs_register.sh' EXIT
mssh(){ sshpass -f $PWF_MAIN ssh $SSHOPT "root@$MAIN_SRV" "$@"; }
sssh(){ sshpass -f $PWF_SRC ssh $SSHOPT "root@$SRC_NODE" "$@"; }

# 在主服务器的 mysql 容器里执行 SQL（先 root，不行再业务账号）
cat > /tmp/srs_register.sh <<'EOF'
C="$1"; DB="$2"; shift 2
q(){
  docker exec -e SQL="$1" "$C" sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$0" -N -e "$SQL"' "$DB" 2>/dev/null && return 0
  docker exec -e SQL="$1" "$C" sh -c 'mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$0" -N -e "$SQL"' "$DB" 2>/dev/null
}
for sql in "$@"; do q "$sql" || echo "SQL_FAILED: $sql"; done
EOF
# mrun "sql1" "sql2" ...：把上面的小脚本连同参数（printf %q 逐个转义，SQL 里有空格/引号也安全）送到主服务器执行
mrun(){
  local args=""; local a
  for a in "$MYSQL_CONTAINER" "$DB_NAME" "$@"; do args+=" $(printf '%q' "$a")"; done
  mssh "bash -s $args" < /tmp/srs_register.sh
}
# 从 srs.conf 读端口：顶层 listen(RTMP) 与各 server 块 listen；rtc_server / srt_server 是 UDP
conf_ports(){  # conf_ports tcp|udp
  awk -v want="$1" '
    /^[ \t]*(rtc_server|srt_server)[ \t]*\{/ {u=1}
    /^[ \t]*\}/ {u=0}
    /^[ \t]*listen[ \t]+/ { t = u ? "udp" : "tcp"; if (t==want) { for (i=2;i<=NF;i++) { gsub(";","",$i); if ($i ~ /^[0-9]+$/) print $i } } }
  ' "$CONF" | sort -un
}
conf_api_port(){ awk '/^[ \t]*http_api[ \t]*\{/{a=1} a&&/^[ \t]*listen[ \t]+/{gsub(";","",$2);print $2;exit}' "$CONF"; }

# ---------- 公网 IP / 网卡 ----------
export DEBIAN_FRONTEND=noninteractive
command -v sshpass >/dev/null && command -v rsync >/dev/null || {
  info "[0/6] apt 基础依赖"
  apt-get update -qq >>$LOG 2>&1
  apt-get install -y -qq rsync sshpass curl ufw net-tools python3 >>$LOG 2>&1 || die "apt 安装失败，看 $LOG"
}
NIC=$(ip -o -4 route show to default | awk '{print $5}' | head -1)
if [ -z "$PUBLIC_IP" ]; then
  PUBLIC_IP=$(curl -s -m 3 http://100.100.100.200/latest/meta-data/eipv4 2>/dev/null | grep -E '^[0-9.]+$')   # 阿里云
  [ -n "$PUBLIC_IP" ] || PUBLIC_IP=$(curl -s -m 3 http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null | grep -E '^[0-9.]+$')  # 腾讯云/AWS
  [ -n "$PUBLIC_IP" ] || PUBLIC_IP=$(curl -4 -s -m 5 https://ifconfig.me 2>/dev/null | grep -E '^[0-9.]+$')
  [ -n "$PUBLIC_IP" ] || PUBLIC_IP=$(curl -4 -s -m 5 https://api.ipify.org 2>/dev/null | grep -E '^[0-9.]+$')
fi
[ -n "$PUBLIC_IP" ] || die "探测不到公网 IP，请用 PUBLIC_IP=x.x.x.x 指定"

info "本机公网 IP=$PUBLIC_IP  网卡=$NIC  主服务器=$MAIN_SRV"

# =============================== 安装 ===============================
if [ "$MODE" = "install" ]; then

# ---------- 源节点：未指定则问主服务器要默认节点 ----------
if [ -z "$SRC_NODE" ]; then
  info "向主服务器 $MAIN_SRV 查询默认（源）节点 …"
  SRC_NODE=$(mrun "SELECT ip FROM srs_node WHERE is_default=1 LIMIT 1;" 2>/dev/null | grep -E '^[0-9.]+$' | head -1)
  [ -n "$SRC_NODE" ] || SRC_NODE=$(mrun "SELECT ip FROM srs_node WHERE enabled=1 ORDER BY priority,id LIMIT 1;" 2>/dev/null | grep -E '^[0-9.]+$' | head -1)
  [ -n "$SRC_NODE" ] || die "主服务器上没有可用的 SRS 节点记录（后台「SRS 节点」为空，或后端还没部署 srs_node 表）。请用 SRC_NODE=x.x.x.x 指定源节点"
fi
[ "$SRC_NODE" = "$PUBLIC_IP" ] && die "源节点就是本机（$PUBLIC_IP），不能自己复制自己"
if [ -z "$SRC_PW" ]; then read -rsp "请输入源节点 $SRC_NODE 的 root 密码: " SRC_PW; echo; fi
[ -n "$SRC_PW" ] || die "源节点密码为空"
umask 077; printf '%s' "$SRC_PW" > $PWF_SRC; umask 022
info "源节点=$SRC_NODE（复制源码 / 配置 / 二进制 / systemd）"

info "[1/6] 从源节点 $SRC_NODE 同步源码、配置、二进制"
sssh "test -f $CONF && test -x $T/objs/srs" >>$LOG 2>&1 || die "源节点 $SRC_NODE 上没有 $T（路径不一致或密码错误）"
SRC_VER=$(sssh "$T/objs/srs -v 2>&1" | tail -1 | tr -d '\r')
info "源节点 SRS 版本: ${SRC_VER:-未知}"
[ "$(systemctl is-active srs 2>/dev/null)" = active ] && systemctl stop srs
mkdir -p $SRS_ROOT $T/objs/nginx
sshpass -f $PWF_SRC rsync -a --delete -e "ssh $SSHOPT" --exclude='objs/' "root@$SRC_NODE:$T/" "$T/" >>$LOG 2>&1 || die "rsync 源码失败（密码/网络？）"
if [ "$FORCE_BUILD" != "1" ]; then
  sshpass -f $PWF_SRC rsync -a -e "ssh $SSHOPT" "root@$SRC_NODE:$T/objs/srs" "$T/objs/srs" >>$LOG 2>&1 || warn "拉源节点二进制失败，将本机编译"
fi
sshpass -f $PWF_SRC rsync -a -e "ssh $SSHOPT" "root@$SRC_NODE:$T/objs/nginx/html/" "$T/objs/nginx/html/" >>$LOG 2>&1 || warn "测试页未同步（不影响）"
sshpass -f $PWF_SRC rsync -a -e "ssh $SSHOPT" "root@$SRC_NODE:$UNIT" /root/srs.service >>$LOG 2>&1 || {
  warn "源节点没有 $UNIT，自动生成"
  cat > /root/srs.service <<EOF
[Unit]
Description=SRS Streaming Server
After=network.target

[Service]
Type=forking
PIDFile=$T/objs/srs.pid
ExecStart=$T/objs/srs -c $CONF
ExecReload=/bin/kill -HUP \$MAINPID
ExecStop=/bin/kill -QUIT \$MAINPID
Restart=always
RestartSec=5
User=root
WorkingDirectory=$T/objs

[Install]
WantedBy=multi-user.target
EOF
}
[ -f $CONF ] || die "同步后没有 $CONF"

info "[2/6] 二进制：先试源节点的，跑不起来再编译"
bin_ok(){ [ -x $T/objs/srs ] && V=$($T/objs/srs -v 2>&1 | tail -1) && [[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; }
if [ "$FORCE_BUILD" != "1" ] && bin_ok; then
  info "源节点二进制可直接运行：版本 $V"
else
  info "本机编译（首次约 8~15 分钟，日志 $LOG）"
  apt-get install -y -qq gcc g++ make cmake nasm patch autoconf automake libtool pkg-config unzip tcl python3 >>$LOG 2>&1 || die "编译依赖安装失败"
  MEM_MB=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
  if [ "$MEM_MB" -lt 3000 ] && [ "$(swapon --noheadings | wc -l)" -eq 0 ]; then
    info "内存 ${MEM_MB}MB 且无 swap，创建 /swapfile 2G"
    fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >>$LOG 2>&1 && swapon /swapfile && \
      (grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab)
  fi
  # 与源节点相同的功能开关；SRS6 在 x86_64 默认 --sanitizer=on（CPU/内存翻倍），生产必须显式关掉
  CFG_FLAGS="--prefix=$T/objs --hls=on --hds=off --dvr=on --ssl=on --https=on --transcode=on --ingest=on --stat=on --http-callback=on --http-server=on --stream-converter=on --http-api=on --utest=off --srt=on --rtc=on --h265=on --gb28181=off --ffmpeg-fit=on --nasm=on --srtp-nasm=on --backtrace=on --log-trace=on --log-level_v2=on --apm=off --sanitizer=off --sanitizer-static=off --sanitizer-log=off"
  cd $T || die "无 trunk"
  rm -rf $T/objs/src $T/objs/srs $T/objs/srs_auto_headers.hpp
  ./configure $CFG_FLAGS --jobs=$(nproc) >>$LOG 2>&1 || die "configure 失败"
  make -j"$(nproc)" >>$LOG 2>&1 || die "make 失败"
  bin_ok || die "编译产物无法运行"
  info "编译完成：版本 $V"
fi
[ -n "$SRC_VER" ] && [ "$V" != "$SRC_VER" ] && warn "本机版本 $V 与源节点 $SRC_VER 不一致"

info "[3/6] srs.conf：只改 rtc_server.candidate = $PUBLIC_IP"
[ -f /root/srs.conf.from_src.bak ] || cp $CONF /root/srs.conf.from_src.bak
if grep -qE '^\s*candidate\s+' $CONF; then
  sed -i -E "s/^(\s*candidate\s+)[^;]+;/\1$PUBLIC_IP;/" $CONF
else
  sed -i -E "s/^(\s*rtc_server\s*\{)/\1\n    candidate $PUBLIC_IP;/" $CONF
fi
grep -qE "candidate\s+$PUBLIC_IP;" $CONF || die "candidate 替换失败，请检查 $CONF"
# 日志/pid 目录
mkdir -p $T/objs
$T/objs/srs -t -c $CONF 2>&1 | tee -a $LOG | grep -q "test is successful" || die "srs.conf 语法检查失败（看 $LOG）"

info "[4/6] systemd / sysctl / ufw"
cp /root/srs.service $UNIT
systemctl daemon-reload; systemctl enable srs >>$LOG 2>&1; systemctl restart srs; sleep 3
cat > /etc/sysctl.d/90-srs.conf <<EOF
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.core.rmem_default = 1048576
net.core.wmem_default = 1048576
EOF
sysctl -p /etc/sysctl.d/90-srs.conf >>$LOG 2>&1
mapfile -t TCP_PORTS < <(conf_ports tcp)
mapfile -t UDP_PORTS < <(conf_ports udp)
API_PORT=$(conf_api_port); API_PORT=${API_PORT:-1985}
ufw --force reset >>$LOG 2>&1; ufw default deny incoming >>$LOG 2>&1; ufw default allow outgoing >>$LOG 2>&1
ufw allow 22/tcp >>$LOG 2>&1
RULES="22/tcp"
for p in "${TCP_PORTS[@]}"; do ufw allow $p/tcp >>$LOG 2>&1; RULES+=" $p/tcp"; done
for p in "${UDP_PORTS[@]}"; do ufw allow $p/udp >>$LOG 2>&1; RULES+=" $p/udp"; done
ufw --force enable >>$LOG 2>&1
info "ufw 放行: $RULES"

info "[5/6] 主服务器 $MAIN_SRV：写入 srs_node 表（幂等）"
ESC_NAME=$(printf '%s' "$NAME" | sed "s/'/''/g"); ESC_REMARK=$(printf '%s' "$REMARK" | sed "s/'/''/g")
REG_OUT=$(mrun \
  "INSERT INTO srs_node (name,ip,api_port,priority,max_connections,enabled,is_default,remark,created_at,updated_at) SELECT '$ESC_NAME','$PUBLIC_IP',$API_PORT,$PRIORITY,$MAX_CONN,1,IF((SELECT COUNT(*) FROM srs_node s)=0,1,0),'$ESC_REMARK',NOW(3),NOW(3) FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM srs_node WHERE ip='$PUBLIC_IP');" \
  "SELECT CONCAT(id,' | ',name,' | ',ip,':',api_port,' | prio=',priority,' | max=',max_connections,' | enabled=',enabled,' | default=',is_default) FROM srs_node ORDER BY priority,id;" \
  2>&1)
echo "$REG_OUT" | tee -a $LOG
if echo "$REG_OUT" | grep -q "SQL_FAILED"; then
  warn "写表失败：多半是后端还没部署带 srs_node 表的版本。可稍后在后台「SRS 节点」手工添加 $PUBLIC_IP"
elif echo "$REG_OUT" | grep -q "$PUBLIC_IP"; then
  info "已登记 $PUBLIC_IP（后台「SRS 节点」可见，10 秒内生效）"
else
  warn "主服务器上没看到 $PUBLIC_IP，请到后台手工添加"
fi
fi   # ---- install 结束 ----

# =============================== 状态（不做校验，只展示） ===============================
info "[6/6] 状态"
[ -f "$CONF" ] || die "本机没有 $CONF，尚未部署"
API_PORT=$(conf_api_port); API_PORT=${API_PORT:-1985}
echo "  SRS 版本      : $($T/objs/srs -v 2>&1 | tail -1)"
echo "  srs.service   : $(systemctl is-active srs 2>/dev/null)"
echo "  candidate     : $(grep -oE 'candidate[ \t]+[^;]+' $CONF 2>/dev/null | awk '{print $2}')"
echo "  监听端口      :"
ss -lntup 2>/dev/null | grep '"srs"' | awk '{printf "                  %s %s\n", $1, $5}'
echo "  WHIP          : http://$PUBLIC_IP:$API_PORT/rtc/v1/whip/"
echo "  WHEP          : http://$PUBLIC_IP:$API_PORT/rtc/v1/whep/"
echo "  主服务器登记  : $(mrun "SELECT CONCAT('id=',id,' prio=',priority,' max=',max_connections,' enabled=',enabled,' default=',is_default) FROM srs_node WHERE ip='$PUBLIC_IP';" 2>/dev/null | grep -v SQL_FAILED | head -1)"
cat <<EOF

提醒：
  - 云控制台安全组仍需手动放行：TCP $(conf_ports tcp | tr '\n' ' ')，UDP $(conf_ports udp | tr '\n' ' ')（ufw 只是系统层）
  - 灰度：后台「SRS 节点」把本机优先级/最大连接数调好；老节点满了会自动落到这里
  - 换复制源：后台「SRS 节点」→ 设为默认；之后新机默认从该节点复制
日志: $LOG    原始 srs.conf 备份: /root/srs.conf.from_src.bak
EOF
info "完成"
