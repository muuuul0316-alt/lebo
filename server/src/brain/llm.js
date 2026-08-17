// 大模型适配层：主用豆包 ARK（PRD 7.1 选型），备用 DashScope，均为 OpenAI 兼容协议。
// 未配置 Key 时进入 mock 模式：不出网也能跑通全链路（开发/演示/自动化测试）。
import { config, brainMode } from '../config.js';
import { trackCost } from '../metrics.js';
import { log } from '../log.js';

const providers = {
  ark: () => ({
    url: `${config.ark.baseUrl}/chat/completions`,
    key: config.ark.apiKey,
    model: config.ark.chatModel,
  }),
  dashscope: () => ({
    url: `${config.dashscope.baseUrl}/chat/completions`,
    key: config.dashscope.apiKey,
    model: config.dashscope.model,
  }),
};

export function llmAvailable() { return brainMode !== 'mock'; }

// messages: [{role, content}]；content 可为多模态数组（豆包 vision 格式）
export async function chat(messages, { json = false, maxTokens = 2048, temperature = 0.4, meta = {} } = {}) {
  if (!llmAvailable()) throw new Error('llm_unavailable_mock_mode');
  const p = providers[brainMode]();
  const body = {
    model: p.model,
    messages,
    max_tokens: maxTokens,
    temperature,
    ...(json ? { response_format: { type: 'json_object' } } : {}),
  };
  const res = await fetch(p.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`llm_http_${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const usage = data.usage || {};
  if (meta.userId) trackCost(meta.userId, meta.taskId || null, 'llm_tokens', (usage.total_tokens || 0), 'tokens');
  return data.choices?.[0]?.message?.content ?? '';
}

export async function chatJson(messages, opts = {}) {
  const raw = await chat(messages, { ...opts, json: true });
  try { return JSON.parse(raw); }
  catch {
    // 模型偶发包裹 ```json 围栏
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch { /* fallthrough */ } }
    log.warn('chatJson parse failed', raw.slice(0, 200));
    throw new Error('llm_bad_json');
  }
}
