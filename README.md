# 乐播 · 龙虾脑

> 扫一个码，承载一切 —— 用云桌面 + 大模型重新定义大屏的使用方式。

对着手机说一句话，电视上的云电脑就把这件事做完、显示出来，并像真人一样讲给屋里所有人听。

本仓库是《乐播·龙虾脑 PRD v1.1》第一阶段（种子验证）的可运行工程实现。**第一版用 H5 替代小程序**，无需微信授权，扫码即用，可快速上线。

## 一句话架构

```
手机 H5（说 + 传）  ──WebSocket──▶  云端龙虾脑（懂 + 讲）  ──WebSocket──▶  电视端 Web（做 + 显示）
   麦克风/上传口                     意图·任务树·路由·讲解Skill               二维码/串流/本地播放/讲解屏
                                          │
                                     ┌────┴─────┐
                                  豆包ARK    无影云桌面(CUA)
                                  火山TTS/ASR   PPT制作/网页操作
```

## 目录

| 目录 | 内容 |
|---|---|
| `server/` | 服务端：会话网关、龙虾脑主脑、内容理解与讲解、语音/CUA 适配层 |
| `tv/` | 电视端 Web 应用（S0 待机码 → S3 讲解屏 → S2 本地播放，共 6 屏） |
| `phone/` | 手机端 H5（P2 主页：信息流 + 按住说话 + 内容添加，共 6 页） |
| `cua-agent/` | 云桌面内运行的 CUA 执行体（Python，截屏→动作→自检） |
| `deploy/` | 一键部署脚本、systemd、nginx 配置 |
| `docs/` | 架构说明、部署手册、PRD 覆盖对照与上线清单 |

## 快速开始（本地，mock 模式，不需要任何 Key）

```bash
cd server
npm install
npm start            # 默认 :8620
```

打开：
- 电视端 → http://localhost:8620/tv/ （显示二维码与投屏码）
- 手机端 → 用手机扫电视二维码，或 http://localhost:8620/m/?d=<deviceId>&c=<投屏码>

mock 模式下意图识别走规则引擎、TTS 走浏览器本地音色，**全链路（看电影 / 上传讲解 / 打断问答 / 做 PPT 提纲）都能跑通**，可离线演示。填入 `.env` 里的豆包/火山/无影 Key 后自动切换到真实模型与云桌面。

## 测试

```bash
cd server
npm test             # node --test，E2E 覆盖 F-01/F-02/F-04/F-05 + 断线重连
```

## 接入真实能力

复制 `.env.example` 为 `.env`，按需填写（都不填 = mock 模式）：
- **主脑**：`ARK_API_KEY`（火山方舟豆包）或 `DASHSCOPE_API_KEY`（阿里）
- **语音**：`VOLC_TTS_*`（火山 TTS/ASR，真人化讲解音色）
- **云桌面**：`WUYING_*`（阿里云无影 EDS，CUA 执行体）

详见 `docs/DEPLOY.md`。

## 部署上线

```bash
# 服务器上（仓库 clone 到 /opt/lebo）
sudo bash deploy/bootstrap.sh
# 然后：填 .env → 配 nginx + HTTPS（麦克风与语音识别要求安全上下文）→ systemctl restart lebo
```

## PRD 对照

功能点与 PRD 章节的逐条对应见 `docs/PRD_COVERAGE.md`；上线前检查清单见 `docs/RELEASE_CHECKLIST.md`。
