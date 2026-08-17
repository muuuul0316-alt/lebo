# PRD 覆盖对照

本表把《乐播·龙虾脑 PRD v1.1》的关键功能点映射到代码，并标注第一阶段实现状态。

状态图例：✅ 已实现可运行 · 🟡 已搭骨架/接口，接真实 Key 或云桌面后完整 · ⬜ 后续阶段（接口已预留）

## 电视端（5.1 / 6.7）

| 编号 | 功能 | 状态 | 代码 |
|---|---|---|---|
| TV-01 | 二维码承载页 + 投屏码 | ✅ | `tv/` S0，`sessions.registerDevice` 生成二维码 |
| TV-02 | 云桌面串流接收 | 🟡 | `tv.js streamDesktop`；串流拉流需接无影 Web SDK |
| TV-03 | 本地播放器接管（不走串流） | ✅ | `tv.js playLocal/playerCtl`，`executor.execPlay` |
| TV-04 | 多窗口 / 分屏 L1–L6 | ✅ | `tv.css .stage`，布局 DSL `protocol.layout` |
| TV-05 | 讲解 TTS + 字幕 + 打断静音 | ✅ | `tv.js speak/stopSpeak` |

## 手机端 H5（5.2 / 6.6）

| 编号 | 功能 | 状态 | 代码 |
|---|---|---|---|
| MP-01 | 扫码绑定（H5 版，无需微信授权） | ✅ | `phone/m.js bind`，`/api/phone/bind` |
| MP-02 | 按住说话 + 实时回显 + 打断 | ✅ | `m.js startTalk`（浏览器 ASR，兜底录音上传 `/api/asr`） |
| MP-03 | 信息流对话 + 状态卡 + 结果卡 | ✅ | `m.js handle/renderStatus` |
| MP-04 | 快捷指令条 | ✅ | `phone/index.html .quickbar` |
| MP-05 | 内容上传 + VIP 包 | ✅ | `m.js` P2-a，`/api/content/upload`，`content/ingest` 解 zip |
| MP-06 | 会员与收银台 | ⬜ | 复用已有收银台（PRD 明确为现成资产）；权益/额度页后续接入 |

## 龙虾脑主脑（5.3 / 6.13 / 6.14）

| 编号 | 功能 | 状态 | 代码 |
|---|---|---|---|
| LB-01 | 意图识别 + 任务拆解（六大意图类） | ✅ | `brain/intent.js`、`brain/planner.js` |
| LB-02 | 任务路由（四通道） | ✅ | `brain/planner` executor + `brain/executor` 分派 |
| LB-03 | 执行反馈与澄清（≤1s 即时反馈） | ✅ | `executor.handleUserText` ack |
| LB-04/05 | 云桌面实例 + CUA 原子动作集 | 🟡 | `cua/wuying.js` + `cua-agent/agent.py`（6.15.2 动作字典） |
| LB-06 | 网页扫码登录代理 | ⬜ | `handoff_qr` 动作已在字典中预留 |
| LB-07 | 影视搜索与起播 | ✅ | `executor.execPlay`（mock 演示片源；真实片源见 Q-09） |

## 内容理解与真人化讲解（5.5 / 6.8 / 6.11，核心差异化）

| 编号 | 功能 | 状态 | 代码 |
|---|---|---|---|
| LB-08 | 多模态内容摄取 | ✅ | `content/parsers.js`（PPTX/DOCX/XLSX/PDF/图/视频）；图/视频深度理解需多模态模型 |
| LB-09 | 打散 PPT 页码逻辑 | ✅ | `content/ingest` 素材单元化 + `skill.js` 按逻辑重组 |
| LB-10 | 讲解 Skill 现场生成 | ✅ | `content/skill.generateSkill`（结构=PRD 6.11） |
| LB-11 | 边讲边展示 | ✅ | `present/engine.playSection` 素材由讲稿驱动 |
| LB-12 | 打断 / 追问 / 补证据 | ✅ | `present/engine.interrupt/ask`（包内→联网→不瞎说） |
| LB-13 | 双人对话式讲解 | 🟡 | TTS 双音色已配置（`VOLC_TTS_VOICE_B`），模式切换后续接 |
| LB-14 | 讲解质量标准 | ✅ | `skill.js` 提示词约束"讲逻辑不念稿" |

## 内容生产（5.6）

| 编号 | 功能 | 状态 | 代码 |
|---|---|---|---|
| LB-14 | PPT 制作（先大纲后成品，过程可见） | 🟡 | `executor.execMake/confirmOutline` + `cua/wuying.makePptxOnDesktop`；未接云桌面时降级为讲稿产物 |
| LB-15 | 文档 / 表格生成 | ⬜ | 同一流水线，后续扩展 |
| LB-16b | 产物交付通道 | ✅ | 直接开讲通道已通；发手机/存网盘后续接 |

## 开放能力（5.7）

| 编号 | 功能 | 状态 |
|---|---|---|
| LB-17/18 | API / 多系统 SDK | ⬜ 第三阶段；`castCode` 投屏码体系已保留，鉴权/计量字段随埋点预留 |

## 异常设计（第 11 章）

已实现：E-01(码刷新)、E-04(退出续跑)、E-05(重连恢复画面)、E-06(没听清)、E-09(超能力直说)、
E-12(CUA 重试 3 次)、E-16(片源不存在推荐相近)、E-21(部分文件失败不阻断)、E-25(不编造)、E-26(冲突并列标源)、E-27(打断无人应答续讲)。
其余异常项接口与话术已在 `intent.js`/`present`/话术库中预留，子 PRD 阶段继续补齐。

## 关键铁律落地

- **D-01 一秒回应**：`executor` 收指令即发 ack（E2E 断言 <1s）。
- **7.4 视频不走串流**：`planner` 视频以 `tv_player` 收尾，播放控制走本地 `player_ctl`。
- **D-04 证据必标来源**：布局 DSL `source_label` 为强制字段，讲解问答均带来源。
- **6.7.4 唯一真相源**：电视端只渲染，断线按云端最后屏幕态恢复（E2E 已验证）。
