# 部署手册

## 一、前置

- 一台 Linux 服务器（Ubuntu/Debian 系，2C4G 起步），公网可访问。
- 一个域名 + HTTPS 证书。**HTTPS 是硬要求**：手机端麦克风（`getUserMedia`）与浏览器语音识别只在安全上下文可用；微信内打开也要求 https。
- （可选）阿里云无影云桌面、火山方舟/语音、豆包等账号与 Key。

## 二、一键部署

```bash
# 1. 把仓库放到 /opt/lebo
sudo git clone <repo> /opt/lebo && cd /opt/lebo
sudo git checkout claude/lobster-2kl0yz

# 2. 一键装 Node + 依赖 + systemd 服务
sudo bash deploy/bootstrap.sh

# 3. 填 .env（不填则以 mock 模式运行，可先联调）
sudo vim /opt/lebo/.env

# 4. 配 nginx 反代 + HTTPS
sudo cp deploy/nginx.conf.example /etc/nginx/conf.d/lebo.conf
sudo vim /etc/nginx/conf.d/lebo.conf          # 改 server_name
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo certbot --nginx -d your.domain.com       # 自动签证书并改 443

# 5. 重启
sudo systemctl restart lebo nginx
curl https://your.domain.com/health
```

`PUBLIC_BASE_URL` 必须设为对外 https 地址（二维码里用的就是它）。

## 三、.env 关键项

| 变量 | 用途 | 不填时 |
|---|---|---|
| `PUBLIC_BASE_URL` | 对外地址（二维码/素材 URL） | 用 localhost，仅本机可用 |
| `ARK_API_KEY` | 豆包主脑（意图/讲解/问答） | 退回规则引擎(mock) |
| `DASHSCOPE_API_KEY` | 备用主脑（阿里，长上下文） | — |
| `VOLC_TTS_*` | 火山 TTS/ASR，真人化讲解 | 电视端用浏览器 speechSynthesis 兜底 |
| `WUYING_*` | 无影云桌面（CUA、做 PPT） | 内容生产降级为可直接开讲的讲稿产物 |
| `DEMO_MEDIA_JSON` | 演示片源 | 用内置公开示例视频 |

凭据安全（PRD 10.4 / 材料文档要求）：`.env` 权限设 `600`，不进 Git；生产用独立最小权限 RAM 用户，密钥定期轮换。

## 四、云桌面（CUA）接入

1. 无影控制台开好企业版云电脑，拿到 `DesktopId`、`OfficeSiteId`，配好独立 RAM AccessKey（最小 EDS 权限）。
2. 填 `WUYING_*` 到 `.env`；`GET /api/cua/status` 可查实例状态。
3. 云桌面内装 Python 依赖并拉起执行体：
   ```powershell
   pip install pyautogui pillow websocket-client
   python agent.py --server wss://your.domain.com/cua --token $CUA_AGENT_TOKEN --desktop ecd-xxxx
   ```
   服务端也可通过无影 `RunCommand` 自动部署并拉起（`server/src/cua/wuying.js`）。
4. 串流拉取到电视端按无影 Web SDK 文档联调（`GetConnectionTicket` → WebRTC 绑定 `#stream-video`）。

## 五、验证

```bash
curl https://your.domain.com/health
# {"ok":true,"brainMode":"ark","ttsMode":"volcano","cua":true,...}
```

- 电视：浏览器打开 `https://your.domain.com/tv/`，出现二维码与投屏码。
- 手机：微信/浏览器扫码 → 进入 H5 → 按住说话"看个电影" → 电视起播。

## 六、日志与运维

- 应用日志：`/var/log/lebo.log`
- 埋点数据：`server/data/events.jsonl`、`server/data/costs.jsonl`（数据侧可直接拉走）
- 重启：`systemctl restart lebo`；查看：`systemctl status lebo`
