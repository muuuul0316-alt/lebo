# 让 Claude 自动部署（你只需点几下网页）

## 为什么需要这一步

Claude 的开发沙箱有网络出口白名单，**只放行 GitHub / npm 等开发必需域名**。实测结果：

| 目标 | 结果 |
|---|---|
| 你的服务器 `42.193.216.98:22` | ❌ 被阻断（代理明确回复 `Host not in allowlist`） |
| 阿里云 `ecd.*.aliyuncs.com`（云电脑/云手机） | ❌ 403 策略拒绝 |
| 火山方舟 `ark.cn-beijing.volces.com`（豆包/Seedream） | ❌ 403 策略拒绝 |
| GitHub / api.github.com | ✅ 可达 |

所以 Claude **在沙箱里够不到**你的服务器与国内 API。解决办法是走 **GitHub Actions**：
runner 有完整公网权限，能连你的服务器、阿里云、火山。Claude 可以远程触发 Actions
并读取运行日志，因此只要凭据到位，后续部署与云资源操作都能自动完成。

**唯一需要你做的事**：把凭据存进 GitHub Secrets（Claude 没有创建 Secret 的权限，实测 403）。

## 一、添加 Secrets（约 2 分钟）

打开 👉 https://github.com/muuuul0316-alt/lebo/settings/secrets/actions
点 **New repository secret**，逐个添加（值都在你给的材料里）：

### 必填（部署用）

| Name | 值 |
|---|---|
| `SERVER_HOST` | `42.193.216.98` |
| `SERVER_PASSWORD` | 材料里那台服务器的 root 密码 |

### 强烈建议（否则语音不可用）

| Name | 值 |
|---|---|
| `DEPLOY_DOMAIN` | 你解析到该服务器的域名。**没有域名就不填**——浏览器只在 HTTPS 下开放麦克风，不填则只能打字 |

### 选填（接真实 AI 与云资源）

| Name | 值 |
|---|---|
| `ARK_API_KEY` | 火山方舟 Key（豆包主脑 + Seedream 生图） |
| `VOLC_TTS_APP_ID` / `VOLC_TTS_ACCESS_TOKEN` | 火山语音（真人化讲解音色、语音识别） |
| `WUYING_ACCESS_KEY_ID` / `WUYING_ACCESS_KEY_SECRET` | 阿里云无影 RAM AccessKey |
| `WUYING_DESKTOP_ID` | 云电脑实例 ID（材料里那台） |
| `WUYING_END_USER_ID` / `WUYING_DESKTOP_PASSWORD` | 云电脑账号密码（取串流凭证用） |
| `PHONE_INSTANCE_ID` | 云手机实例 ID（材料里那台） |

> 全部不填也能跑：服务会以 mock 演示模式启动，扫码、看电影、上传讲解、打断问答的完整链路都能走通。

## 二、告诉 Claude「加好了」

Claude 会触发部署 workflow，然后把 **H5 地址**给你。也可以自己点：
Actions → **部署到服务器** → Run workflow。

跑完在 Summary 里就是地址：
- 电视端 `https://你的域名/tv/`（电视浏览器打开，显示二维码）
- 手机端 `https://你的域名/m/`（扫码即用）

## 三、云桌面与云手机（你要的「业务放云上跑」）

Actions → **云桌面与生图** → Run workflow，选动作：

| 动作 | 作用 |
|---|---|
| `desktop-status` / `desktop-start` | 查询 / 启动无影云电脑 |
| `desktop-run` | 在云电脑内执行 PowerShell（可拉起浏览器、Office、下载文件） |
| `phone-status` / `phone-start` / `phone-run` | 云手机查询 / 开机 / 执行命令（跑只有 App 才有的内容） |
| `gen-assets` | 用 Seedream 生成品牌视觉，自动提交回仓库 |
| `fetch-api-meta` | 抓阿里云官方 API 元数据（已跑过，见 `docs/api-meta/`） |

## 备选方案：你自己在服务器上跑一条命令

不想配 Secrets 也可以，效果完全一样：

```bash
sudo git clone -b claude/lobster-2kl0yz https://github.com/muuuul0316-alt/lebo.git /opt/lebo
cd /opt/lebo
sudo DOMAIN=你的域名 bash deploy/oneclick.sh    # 无域名就去掉 DOMAIN=
```

脚本会逐步校验并在**真正可访问时**才打印地址；任何一步失败都会明确告诉你失败在哪、怎么修
（不会出现"显示成功但打不开"）。

## 安全提醒

材料里的密钥已出现在对话中，建议上线后在阿里云 / 火山控制台**轮换一遍**，并按最小权限重建 RAM 用户。
仓库本身不含任何明文密钥（已扫描确认）。
