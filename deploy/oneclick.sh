#!/usr/bin/env bash
# 乐播·龙虾脑 一键上线（裸机 → 可访问的 H5 地址）。
# 在你的服务器上执行（需 root）：
#   sudo git clone -b claude/lobster-2kl0yz https://github.com/muuuul0316-alt/lebo.git /opt/lebo
#   cd /opt/lebo
#   sudo DOMAIN=你的域名 bash deploy/oneclick.sh          # 有域名：自动配 HTTPS（推荐，麦克风可用）
#   sudo bash deploy/oneclick.sh                           # 无域名：http://本机IP 直达（可演示，但浏览器禁麦克风）
#
# 说明：H5 手机端「按住说话」用浏览器麦克风，现代浏览器只在 HTTPS/localhost 下放行。
# 因此正式可用必须有域名 + HTTPS；裸 IP 版只能打字发指令 + 看演示。
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/lebo}
PORT=${PORT:-8620}
DOMAIN=${DOMAIN:-}
cd "$APP_DIR"

echo "==================================================="
echo " 乐播·龙虾脑 一键上线   目录=$APP_DIR  域名=${DOMAIN:-（无，用IP）}"
echo "==================================================="

# 1) 基础软件
export DEBIAN_FRONTEND=noninteractive
apt-get update -y >/dev/null 2>&1 || true
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 20 ]; then
  echo "-- 安装 Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y nodejs >/dev/null 2>&1
fi
command -v nginx >/dev/null 2>&1 || apt-get install -y nginx >/dev/null 2>&1
echo "-- node $(node -v)，nginx 已就绪"

# 2) 服务端依赖
echo "-- 安装服务端依赖"
( cd "$APP_DIR/server" && npm install --omit=dev >/dev/null 2>&1 )

# 3) .env（保留已存在的；只补缺失项）
PUBLIC_URL=${PUBLIC_BASE_URL:-}
if [ -z "$PUBLIC_URL" ]; then
  if [ -n "$DOMAIN" ]; then PUBLIC_URL="https://$DOMAIN"; else
    IP=$(curl -s4 --max-time 5 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
    PUBLIC_URL="http://$IP"
  fi
fi
if [ ! -f "$APP_DIR/.env" ]; then cp "$APP_DIR/.env.example" "$APP_DIR/.env"; fi
# 覆盖 PUBLIC_BASE_URL 与 PORT（其余 Key 由你手动填；不填则 mock 模式）
sed -i "s#^PUBLIC_BASE_URL=.*#PUBLIC_BASE_URL=$PUBLIC_URL#" "$APP_DIR/.env"
sed -i "s#^PORT=.*#PORT=$PORT#" "$APP_DIR/.env"
echo "-- .env 就绪：PUBLIC_BASE_URL=$PUBLIC_URL PORT=$PORT"
echo "   （要接豆包/火山/无影，编辑 $APP_DIR/.env 填 Key 后 systemctl restart lebo；不填则以 mock 演示模式运行）"

# 4) systemd 服务
cp "$APP_DIR/deploy/lebo.service" /etc/systemd/system/lebo.service
systemctl daemon-reload
systemctl enable lebo >/dev/null 2>&1
systemctl restart lebo
sleep 2

# 5) nginx 反代
SITE=/etc/nginx/conf.d/lebo.conf
cat > "$SITE" <<NGINX
server {
  listen 80;
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
  }
}
NGINX
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
nginx -t >/dev/null 2>&1 && systemctl restart nginx
echo "-- nginx 反代已配"

# 6) HTTPS（有域名才签；麦克风依赖 HTTPS）
if [ -n "$DOMAIN" ]; then
  command -v certbot >/dev/null 2>&1 || apt-get install -y certbot python3-certbot-nginx >/dev/null 2>&1
  echo "-- 为 $DOMAIN 申请 HTTPS 证书（需该域名已解析到本机）"
  if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "admin@$DOMAIN" --redirect >/dev/null 2>&1; then
    echo "-- HTTPS 已启用"
  else
    echo "!! 证书申请失败：确认 $DOMAIN 的 A 记录已指向本机、80 端口对外开放，然后手动跑：certbot --nginx -d $DOMAIN"
  fi
fi

# 7) 健康检查 + 输出地址
sleep 1
HEALTH=$(curl -s "http://127.0.0.1:$PORT/health" || echo '{}')
echo
echo "================= 上线完成 ================="
echo " 健康检查： $HEALTH"
echo
echo " 电视端（在电视浏览器打开，显示二维码）："
echo "     $PUBLIC_URL/tv/"
echo " 手机端 H5（手机浏览器/微信打开，或扫电视二维码）："
echo "     $PUBLIC_URL/m/"
echo
if [ -z "$DOMAIN" ]; then
  echo " ⚠ 当前是 IP 访问，浏览器会禁用麦克风（按住说话不可用），可用打字发指令演示。"
  echo "   要让语音可用：把一个域名解析到本机，然后 sudo DOMAIN=你的域名 bash deploy/oneclick.sh"
fi
echo "============================================"
