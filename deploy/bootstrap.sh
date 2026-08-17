#!/usr/bin/env bash
# 一键部署乐播·龙虾脑到一台 Linux 服务器（Ubuntu/Debian 系）。
# 用法（在服务器上，仓库已 clone 到 /opt/lebo）：
#   sudo bash deploy/bootstrap.sh
# 部署后仍需：编辑 /opt/lebo/.env 填入真实 Key，改 nginx server_name 并申请 HTTPS 证书。
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/lebo}
echo "== 乐播·龙虾脑 部署 == 目录 $APP_DIR"

# 1. Node.js 20+
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "-- 安装 Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v

# 2. 依赖
echo "-- 安装服务端依赖"
cd "$APP_DIR/server"
npm install --omit=dev

# 3. .env
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  echo "!! 已生成 $APP_DIR/.env —— 请填入真实 Key 后再启动（不填则以 mock 模式运行，可离线演示）"
fi

# 4. systemd 服务
echo "-- 安装 systemd 服务"
cp "$APP_DIR/deploy/lebo.service" /etc/systemd/system/lebo.service
systemctl daemon-reload
systemctl enable lebo
systemctl restart lebo
sleep 2
systemctl --no-pager status lebo | head -5 || true

# 5. nginx（可选）
if command -v nginx >/dev/null 2>&1; then
  echo "-- 检测到 nginx，可用 deploy/nginx.conf.example 配置反代"
else
  echo "-- 未装 nginx。生产环境建议：apt-get install -y nginx certbot python3-certbot-nginx"
fi

echo "== 完成 =="
echo "健康检查： curl http://127.0.0.1:8620/health"
echo "电视端  ： http://<域名>/tv/     手机端： http://<域名>/m/"
echo "下一步  ： 1) 填 .env  2) 配 nginx + HTTPS  3) systemctl restart lebo"
