#!/usr/bin/env bash
# 乐播·龙虾脑 一键上线（裸机 → 可访问的 H5 地址）。
#
# 在你的服务器上执行（需 root）：
#   sudo git clone -b claude/lobster-2kl0yz https://github.com/muuuul0316-alt/lebo.git /opt/lebo
#   cd /opt/lebo
#   sudo DOMAIN=你的域名 bash deploy/oneclick.sh     # 有域名：自动配 HTTPS（推荐，语音可用）
#   sudo bash deploy/oneclick.sh                      # 无域名：http://本机IP（可演示，浏览器禁麦克风）
#
# 设计原则：**绝不谎报成功**。每一步失败都要说清楚失败在哪、怎么办；
# 最终地址只在真正可访问时才打印。
set -uo pipefail   # 故意不用 -e：需要逐步判断并给出可读的错误，而不是静默退出

APP_DIR=${APP_DIR:-/opt/lebo}
PORT=${PORT:-8620}
DOMAIN=${DOMAIN:-}
LOG=/tmp/lebo-deploy.log
: > "$LOG"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m部署中断：%s\033[0m\n' "$*"; printf '详细日志：%s\n' "$LOG"; exit 1; }
step() { printf '\n\033[36m== %s ==\033[0m\n' "$*"; }

[ "$(id -u)" = "0" ] || die "请用 root 执行：sudo bash deploy/oneclick.sh"
cd "$APP_DIR" 2>/dev/null || die "找不到目录 $APP_DIR"

printf '\033[1m乐播·龙虾脑 一键上线\033[0m  目录=%s  域名=%s\n' "$APP_DIR" "${DOMAIN:-（无，将用 IP）}"

# ---------- 1. 基础软件 ----------
step "安装运行环境"
export DEBIAN_FRONTEND=noninteractive
# 锁超时：刚开机的云主机常有 unattended-upgrades 占着 dpkg 锁，直接装会以 100 退出
APT="apt-get -o DPkg::Lock::Timeout=300 -y"
# update 失败不致命（机器上常有失效的第三方源），但要留痕
$APT update >>"$LOG" 2>&1 || warn "apt update 有告警（可能存在失效的第三方源），继续"

# 最小化镜像可能连 curl / ca-certificates 都没有，而下一步就要用 curl
for pkg in curl ca-certificates; do
  command -v "${pkg%%-*}" >/dev/null 2>&1 && continue
  $APT install "$pkg" >>"$LOG" 2>&1 || true
done
command -v curl >/dev/null 2>&1 || die "缺少 curl 且自动安装失败。请先执行： apt-get install -y curl ca-certificates"

NODE_MAJOR_MIN=20
NODE_SETUP_VER=22   # Node 20 已于 2026-04 EOL，新装一律用 22
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt "$NODE_MAJOR_MIN" ]; then
  echo "  正在安装 Node.js ${NODE_SETUP_VER}（约 1 分钟）…"
  if ! curl -fsSL "https://deb.nodesource.com/setup_${NODE_SETUP_VER}.x" 2>>"$LOG" | bash - >>"$LOG" 2>&1; then
    die "Node.js 源配置失败，多半是服务器连不上外网（DNS 或安全组）。日志末尾：$(tail -3 "$LOG" | tr '\n' ' ')"
  fi
  if ! $APT install nodejs >>"$LOG" 2>&1; then
    # 发行版自带的 npm 包会与 nodesource 的 nodejs 冲突（overwrite /usr/include/node/...）
    if grep -q "trying to overwrite" "$LOG"; then
      warn "检测到发行版 npm 包冲突，正在移除后重试"
      $APT remove npm >>"$LOG" 2>&1 || true
      $APT install nodejs >>"$LOG" 2>&1 || die "Node.js 安装失败。日志末尾：$(tail -5 "$LOG" | tr '\n' ' ')"
    else
      die "Node.js 安装失败。日志末尾：$(tail -5 "$LOG" | tr '\n' ' ')"
    fi
  fi
fi
command -v node >/dev/null 2>&1 || die "Node.js 仍不可用"
ok "Node.js $(node -v)"

if ! command -v nginx >/dev/null 2>&1; then
  $APT install nginx >>"$LOG" 2>&1 || die "nginx 安装失败。日志末尾：$(tail -3 "$LOG" | tr '\n' ' ')"
fi
ok "nginx 已就绪"

# ---------- 2. 依赖 ----------
step "安装服务端依赖"
( cd "$APP_DIR/server" && npm install --omit=dev >>"$LOG" 2>&1 ) \
  || die "npm install 失败。日志末尾：$(tail -5 "$LOG" | tr '\n' ' ')"
ok "依赖安装完成"

# ---------- 3. 对外地址 ----------
step "确定对外地址"
if [ -n "$DOMAIN" ]; then
  # 有域名时先按 http 写入；证书签发成功后再改成 https（避免签发失败却留下打不开的 https 地址）
  PUBLIC_URL="http://$DOMAIN"
  ok "域名 $DOMAIN"
else
  IP=""
  for svc in "https://api.ipify.org" "https://ifconfig.me/ip" "https://icanhazip.com"; do
    C=$(curl -s4 --max-time 8 "$svc" 2>/dev/null | tr -d '[:space:]')
    # 必须是公网 IPv4：排除返回 HTML 错误页、内网地址等情况
    if printf '%s' "$C" | grep -qE '^([0-9]{1,3}\.){3}[0-9]{1,3}$' &&
       ! printf '%s' "$C" | grep -qE '^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)'; then
      IP="$C"; break
    fi
  done
  if [ -z "$IP" ]; then
    warn "自动探测公网 IP 失败（可能在 NAT 后）。"
    read -r -p "  请手动输入这台服务器的公网 IP 或域名：" IP </dev/tty || true
    [ -n "$IP" ] || die "没有可用的对外地址，无法生成二维码"
  fi
  PUBLIC_URL="http://$IP"
  ok "对外地址 $PUBLIC_URL"
fi

# ---------- 4. .env ----------
step "写入配置"
[ -f "$APP_DIR/.env" ] || cp "$APP_DIR/.env.example" "$APP_DIR/.env"
set_env() {  # set_env KEY VALUE —— 用 | 作分隔符并转义，兼容含 / & # 的值
  local k="$1" v="$2" esc
  esc=$(printf '%s' "$v" | sed -e 's/[|&\\]/\\&/g')
  if grep -q "^$k=" "$APP_DIR/.env"; then
    sed -i "s|^$k=.*|$k=$esc|" "$APP_DIR/.env"
  else
    printf '%s=%s\n' "$k" "$v" >> "$APP_DIR/.env"
  fi
}
set_env PUBLIC_BASE_URL "$PUBLIC_URL"
set_env PORT "$PORT"
# CUA 通道令牌必须随机，默认值等于不设防
if grep -qE '^CUA_AGENT_TOKEN=(change-me)?$' "$APP_DIR/.env"; then
  set_env CUA_AGENT_TOKEN "$(head -c 24 /dev/urandom | base64 | tr -d '/+=' )"
fi
# 素材签名密钥固定下来，避免重启后旧素材链接全部失效
grep -qE '^ASSET_SECRET=.+' "$APP_DIR/.env" || set_env ASSET_SECRET "$(head -c 32 /dev/urandom | base64 | tr -d '/+=')"
chmod 600 "$APP_DIR/.env"
ok ".env 就绪（PUBLIC_BASE_URL=$PUBLIC_URL PORT=$PORT，权限 600）"

# ---------- 5. systemd ----------
step "启动服务"
cp "$APP_DIR/deploy/lebo.service" /etc/systemd/system/lebo.service
# 按实际 node 路径与目录改写单元，避免硬编码失配导致重启风暴
sed -i "s|^ExecStart=.*|ExecStart=$(command -v node) src/index.js|" /etc/systemd/system/lebo.service
sed -i "s|^WorkingDirectory=.*|WorkingDirectory=$APP_DIR/server|" /etc/systemd/system/lebo.service
systemctl daemon-reload
systemctl enable lebo >>"$LOG" 2>&1
systemctl restart lebo
sleep 3
systemctl is-active --quiet lebo || {
  echo "  --- 服务日志 ---"; journalctl -u lebo -n 20 --no-pager | sed 's/^/  /'
  die "服务没起来（原因见上面日志）"
}
ok "服务已运行"

# 真正确认端口在响应
HEALTH=""
for i in 1 2 3 4 5; do
  HEALTH=$(curl -s --max-time 5 "http://127.0.0.1:$PORT/health" 2>/dev/null)
  printf '%s' "$HEALTH" | grep -q '"ok":true' && break
  sleep 2
done
printf '%s' "$HEALTH" | grep -q '"ok":true' || {
  journalctl -u lebo -n 20 --no-pager | sed 's/^/  /'
  die "服务端口 $PORT 无响应"
}
ok "健康检查通过"

# ---------- 6. nginx ----------
step "配置反向代理"
SITE=/etc/nginx/conf.d/lebo.conf
# 幂等：certbot 会改写本文件加入 443；已有证书配置时不要覆盖
if [ -f "$SITE" ] && grep -q "ssl_certificate" "$SITE"; then
  ok "已存在含 HTTPS 的 nginx 配置，保持不变"
else
  cat > "$SITE" <<NGINX
server {
  listen 80;
  listen [::]:80;
  server_name ${DOMAIN:-_};
  client_max_body_size 600m;
  location / {
    proxy_pass http://127.0.0.1:$PORT;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_buffering off;
  }
}
NGINX
  # Debian/Ubuntu 默认站点会抢占 default_server，导致访问到 nginx 欢迎页
  rm -f /etc/nginx/sites-enabled/default 2>/dev/null
  nginx -t >>"$LOG" 2>&1 || { nginx -t 2>&1 | sed 's/^/  /'; die "nginx 配置检查未通过"; }
  systemctl restart nginx || die "nginx 重启失败"
  ok "反向代理已配置"
fi

# ---------- 7. HTTPS ----------
HTTPS_OK=0
if [ -n "$DOMAIN" ]; then
  step "申请 HTTPS 证书"
  command -v certbot >/dev/null 2>&1 || $APT install certbot python3-certbot-nginx >>"$LOG" 2>&1
  # --keep-until-expiring：已有未到期证书时不报错，保证重跑幂等
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
    -m "admin@$DOMAIN" --redirect --keep-until-expiring >>"$LOG" 2>&1 || true
  nginx -t >>"$LOG" 2>&1 && systemctl reload nginx >>"$LOG" 2>&1

  # 判据用「事实」而不是 certbot 退出码：证书文件在 + 443 真的有人听。
  # 只看退出码会让已签过证的机器在重跑时被降级回 http。
  if [ -s "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ] && ss -ltn 2>/dev/null | grep -q ':443 '; then
    HTTPS_OK=1
  fi

  if [ "$HTTPS_OK" = "1" ]; then
    PUBLIC_URL="https://$DOMAIN"
    ok "HTTPS 已启用"
  else
    warn "HTTPS 未启用，继续用 $PUBLIC_URL（此模式下手机「按住说话」不可用，只能打字）"
    warn "排查：1) dig +short $DOMAIN 是否等于本机公网 IP  2) 安全组/ufw 放行 80 与 443"
    warn "      3) 修好后执行： certbot --nginx -d $DOMAIN --redirect && systemctl restart lebo"
    warn "证书日志见 $LOG"
  fi
fi

# 地址最终确定后再回写 .env 并重启，确保二维码与素材 URL 都用同一个地址
set_env PUBLIC_BASE_URL "$PUBLIC_URL"
systemctl restart lebo
sleep 2

# ---------- 8. 连通性自检 ----------
step "外部可访问性自检"
REACHABLE=0
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$PUBLIC_URL/health" 2>/dev/null)
if [ "$CODE" = "200" ]; then REACHABLE=1; ok "从公网地址访问正常（HTTP $CODE）"; else
  warn "从 $PUBLIC_URL 访问返回 $CODE"
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw status | grep -qE '(^|\s)80(/tcp)?\s' || warn "本机 ufw 已开启但未放行 80 端口：ufw allow 80/tcp"
    ufw status | grep -qE '(^|\s)443(/tcp)?\s' || warn "本机 ufw 未放行 443 端口：ufw allow 443/tcp"
  fi
  warn "另请检查云服务商安全组是否放行 80/443（这是最常见原因）"
fi

# ---------- 结果 ----------
printf '\n\033[1m================= 结果 =================\033[0m\n'
printf '服务状态：%s\n' "$HEALTH"
if [ "$REACHABLE" = "1" ]; then
  printf '\n\033[32m可以用了：\033[0m\n'
  printf '  电视端（电视浏览器打开，显示二维码）： %s/tv/\n' "$PUBLIC_URL"
  printf '  手机端（扫码进入，或直接打开）：      %s/m/\n' "$PUBLIC_URL"
else
  printf '\n\033[33m服务已在本机正常运行，但公网还访问不到。\033[0m\n'
  printf '  按上面的提示放行端口后，地址会是：\n'
  printf '  电视端 %s/tv/   手机端 %s/m/\n' "$PUBLIC_URL" "$PUBLIC_URL"
fi
if [ -z "$DOMAIN" ] || [ "$HTTPS_OK" != "1" ]; then
  printf '\n\033[33m注意：当前不是 HTTPS，浏览器会禁用麦克风（按住说话不可用），可先用打字。\033[0m\n'
  printf '  启用语音：把域名解析到本机后执行  sudo DOMAIN=你的域名 bash deploy/oneclick.sh\n'
fi
printf '\n接真实 AI：编辑 %s/.env 填入 ARK_API_KEY 等，然后 systemctl restart lebo\n' "$APP_DIR"
printf '不填也能用：当前以 mock 演示模式运行，全流程可跑通。\n'
printf '完整日志：%s\n' "$LOG"
