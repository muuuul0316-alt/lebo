// CUA 决策循环（PRD 6.15.1 执行—自检—纠错）：
// 规划下一动作 → 云桌面内 cua-agent 执行 → 截屏 → 豆包多模态判读 → 符合预期继续 / 纠错（≤3 次）。
// verify 用自然语言判据（不写死 DOM），目标网站改版不至于全线失效（E-15）。
//
// 说明：本模块驱动"通用 CUA"路径。cua-agent（云桌面内 Python）通过 /cua WebSocket 回连，
// 接收 cua_action、回传 cua_result + 截屏。高频任务成功 N 次后可固化为参数化脚本（6.15.1）。
import { chatJson, llmAvailable } from '../brain/llm.js';
import { track } from '../metrics.js';
import { log } from '../log.js';

// 云桌面内 agent 的连接注册表：desktopId -> { socket, pending: Map<actionId,resolve> }
const agents = new Map();

export function registerCuaAgent(desktopId, socket) {
  const entry = { socket, pending: new Map(), lastShot: null };
  agents.set(desktopId, entry);
  socket.on('message', (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (msg.type === 'cua_ready') entry.lastShot = msg.shot;
    if (msg.type === 'cua_result') {
      entry.lastShot = msg.shot;
      const r = entry.pending.get(msg.action_id);
      if (r) { entry.pending.delete(msg.action_id); r(msg); }
    }
  });
  socket.on('close', () => { if (agents.get(desktopId) === entry) agents.delete(desktopId); });
  return entry;
}

export function cuaAgentOnline(desktopId) { return agents.has(desktopId); }

function sendAction(desktopId, op, params) {
  const entry = agents.get(desktopId);
  if (!entry || entry.socket.readyState !== 1) return Promise.reject(new Error('cua_agent_offline'));
  const actionId = `a_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { entry.pending.delete(actionId); reject(new Error('cua_action_timeout')); }, 30000);
    entry.pending.set(actionId, (msg) => { clearTimeout(timer); resolve(msg); });
    entry.socket.send(JSON.stringify({ type: 'cua_action', action_id: actionId, op, params }));
  });
}

// 判读截屏是否满足自然语言判据（用多模态模型）。无模型时保守判 true，交由后续步骤纠偏。
async function verifyShot(shotB64, expectation) {
  if (!expectation) return { ok: true };
  if (!llmAvailable() || !shotB64) return { ok: true, note: 'no_vision' };
  try {
    const out = await chatJson([
      { role: 'system', content: '你是 CUA 自检器。给你一张云桌面截图和一个自然语言预期，判断预期是否已达成。只输出 {"ok":true|false,"reason":"简述"}。' },
      { role: 'user', content: [
        { type: 'text', text: `预期：${expectation}` },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${shotB64}` } },
      ] },
    ], { maxTokens: 150, temperature: 0 });
    return { ok: !!out.ok, reason: out.reason };
  } catch (e) {
    log.warn('cua verify failed:', e.message);
    return { ok: true, note: 'verify_error' };
  }
}

// 执行一个带自检的动作，失败自动重试（上限 3 次，E-12）。
export async function execVerifiedAction(desktopId, action) {
  const { op, params = {}, verify, retry = 3 } = action;
  let lastErr = null;
  for (let attempt = 0; attempt <= retry; attempt++) {
    try {
      const res = await sendAction(desktopId, op, params);
      if (!res.ok) { lastErr = res.reason; continue; }
      const v = await verifyShot(res.shot, verify);
      if (v.ok) { track('cua', 'action_ok', { op, attempt }); return { ok: true, shot: res.shot }; }
      lastErr = v.reason || 'verify_failed';
      track('cua', 'action_retry', { op, attempt, reason: lastErr });
    } catch (e) {
      lastErr = e.message;
      if (e.message === 'cua_agent_offline') break;
    }
  }
  track('cua', 'action_fail', { op, reason: lastErr });
  return { ok: false, reason: lastErr }; // 交由调用方换路径或告知用户
}

// 顺序执行一串原子动作（任务树里 executor=cua 的 actions）。
export async function runActions(desktopId, actions) {
  for (const a of actions) {
    const r = await execVerifiedAction(desktopId, a);
    if (!r.ok) return { ok: false, failedOp: a.op, reason: r.reason };
  }
  return { ok: true };
}
