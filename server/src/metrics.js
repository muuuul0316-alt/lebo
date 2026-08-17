// 埋点体系（PRD 8.1）：核心链路埋点与功能同版本上线，不做后置补埋。
// 事件按域落 JSONL，数据侧可直接拉走进数仓；单任务成本核算字段预留（PRD 8.2）。
import { appendJsonl } from './store.js';

export function track(domain, event, props = {}) {
  appendJsonl('events', { ts: Date.now(), domain, event, ...props });
}

// 成本埋点：模型 token / 云桌面时长 / 带宽，按 user 维度聚合（PRD 7.6「单用户单任务成本核算」）
export function trackCost(userId, taskId, kind, amount, unit) {
  appendJsonl('costs', { ts: Date.now(), userId, taskId, kind, amount, unit });
}
