# 架构说明

## 四端职责（PRD 4.2）

| 端 | 角色 | 代码 |
|---|---|---|
| 电视端 | 显示器 + 播放器 | `tv/`（S0–S5 屏，布局引擎渲染布局 DSL） |
| 手机端 | 麦克风 + 上传口 + 遥控器 | `phone/`（H5，按住说话 + 信息流 + 上传） |
| 云桌面 | 手 + 环境 | 阿里云无影 Windows 实例 + `cua-agent/agent.py` |
| 云端主脑 | 脑 | `server/`（意图/拆解/路由/讲解/编排） |

## 端间协议（PRD 6.9–6.11）

冻结在 `server/src/protocol.js`：

- **手机 → 云端** `user_input`：语音/文字/文件统一入口，带 `is_interrupt` 打断标志。
- **云端 → 手机** `agent_event`：`ack | task_progress | task_result | ingest_* | presenting | answer | outline | error`。
- **云端 → 电视** `tv_command`：`render | play_local | player_ctl | stream_desktop | overlay | reset`，携带布局 DSL 与 TTS。
- **布局 DSL**：`L1 | L2_MAIN_SIDE | L2_EQUAL | L3 | L6`，证据素材强制带 `source_label`（D-04）。

所有 `tv_command` 幂等；断线重连时电视端用最后一条**屏幕态指令**恢复画面（overlay 等瞬时叠加不作为恢复点）。

## 请求主干（PRD 6.13 七阶段）

```
① 按住说话(手机)  → ② ASR+理解(云) → ③ 意图+槽位(云) → [≤1s 即时反馈] →
④ 任务拆解(云)   → ⑤ 路由(云)     → ⑥ 执行(云桌面/播放器/主脑) → ⑦ 结果编排(云→电视)
```

代码路径：`gateway.js` 收 `user_input` → `brain/executor.handleUserText` →
`brain/intent.classify` → `brain/planner.planFor` → 按 executor 分派到
`tv_player`(播放) / `brain`(问答) / `content_engine`(讲解，`present/engine.js`) / `cua`(云桌面，`cua/wuying.js`)。

## 路由表（PRD 5.3.2）

| 任务类型 | executor | 说明 |
|---|---|---|
| 可直连影视 | `tv_player` | 本地播放器直连，**不走串流**（7.4 生死线） |
| 网页/软件操作 | `cua` | 云桌面，能力无天花板 |
| 纯信息问答 | `brain` | 主脑直答/联网，成本最低，不启云桌面 |
| 已上传内容讲解 | `content_engine` | 走已生成的讲解 Skill，避免重复解析 |

## 内容理解与讲解（PRD 5.5 / 7.2，核心差异化）

1. 上传 → `content/ingest.js` 解包/识别/理解（`content/parsers.js` 纯 Node 解析 PPTX/DOCX/XLSX/PDF/图片/视频）。
2. 素材**打散为独立单元**（不再有"页"的概念，5.5.2）。
3. 现场生成**讲解 Skill**（`content/skill.js`，结构见 PRD 6.11）：讲解路径 + 素材调用 + 问答索引。
4. `present/engine.js` 按 Skill 边讲边展示；打断 ≤500ms 静音 → 先查包内证据 → 未命中联网补证 → 查不到不瞎说（C-09）。
5. Skill 复用：同包二次讲解直接加载，Token 消耗大幅下降（7.2 目标 ≥70%）。

## 云端执行体：云电脑 + 云手机（PRD 4.2「手 + 环境」层）

两类执行体互补，共同支撑"你说得出来，我就做得到"：

| 执行体 | 产品 | 擅长 | 代码 |
|---|---|---|---|
| 云电脑（Windows） | 无影 ecd | 网页操作、Office 出成品、下载文件、跑桌面软件 | `cua/wuying.js` |
| 云手机（Android） | 无影 eds-aic | **只有 App 才有的内容与能力**（大量国内视频/音乐/生活服务无可用网页版） | `cua/cloudphone.js` |

两者共用签名层 `cua/aliyun.js`（HMAC-SHA1，已用阿里云官方示例校验），接口参数依据
`docs/api-meta/*.json`——由 GitHub Actions 从阿里云官方元数据抓取，避免凭记忆写错。

关键实现细节：
- **走 POST 而非 GET**：`RunCommand` 的脚本 Base64 后可达 16KB，GET 查询串必然 414 超长。
- 数组参数按阿里云 RPC 约定展开为 `Name.1 / Name.2`（`expandArray`）。
- 拉流到电视：云电脑 `GetConnectionTicket`、云手机 `BatchGetAcpConnectionTicket`，
  取到 Ticket 后交无影 Web SDK 建连（对应 TV-02）。

运维入口：`tools/cloud-cli.mjs`（status/start/run/ticket/phone-*），
可在服务器或 GitHub Actions（`.github/workflows/cloud.yml`）上执行。

## 模型与降级（PRD 7.1）

`brain/llm.js` 统一适配 OpenAI 兼容协议：主用豆包 ARK，备用 DashScope。
**未配置 Key → mock 模式**：规则意图 + 启发式备课 + 浏览器 TTS，全链路仍可跑通（开发/演示/测试）。
任一外部依赖不可用时降级为可用子集并人话告知（10.2 健壮性）。

## 成本控制（PRD 7.6）

- 路由优先级：能不启云桌面就不启，能本地播放就不串流。
- 上下文 Skill 化：削减重复 Token（7.2）。
- 埋点：`metrics.js` 按用户/任务落 `costs.jsonl`（token / 云桌面时长 / 带宽），支撑单用户成本核算与定价校准。
