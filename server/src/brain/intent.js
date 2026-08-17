// 意图识别与槽位（PRD 5.3.1）。六大意图类：播放/投屏/理解讲解/信息查询/布局控制/会话控制。
// LLM 通道：豆包结构化输出；mock 通道：规则匹配，覆盖演示与测试集的常见指令。
import { llmAvailable, chatJson } from './llm.js';
import { log } from '../log.js';

export const INTENTS = [
  'play_video',      // 看电影/放动画片/换一集/快进（播放控制归 control_playback）
  'cast_content',    // 把这张照片/视频/文件投上去
  'explain_content', // 讲一下这个 PPT / 你来讲 / 讲讲这张照片
  'make_content',    // 把材料做成 PPT / 写个文档（5.6）
  'ask_info',        // 几点了/天气/股票/知识问答
  'control_playback',// 暂停/快进/换一集/关掉
  'control_layout',  // 放大/并排显示/回到刚才那页
  'control_session', // 停/继续/重讲/慢一点/换个说法
  'unknown',
];

const RULES = [
  [/^(暂停|停一下|快进|快退|倒回|换一集|下一集|上一集|关掉|停止播放|从头播|接着播|继续播)/, 'control_playback'],
  // 停止类短句必须在其它规则之前命中，否则会被当成提问（用户叫不停）
  [/^(停|停下|停下来|先停|别讲了?|不要讲了?|不讲了|别说了|闭嘴|安静|结束讲解|停止讲解)$/, 'control_session'],
  [/(重讲|换个讲法|换个说法|慢一点|快一点|继续讲|接着讲|开始讲|你来讲|讲下一段|上一段|结束讲解)/, 'control_session'],
  [/(放大|缩小|并排|分屏|全屏|回到刚才)/, 'control_layout'],
  [/(做成|帮我做|生成).*(ppt|PPT|演示|文档|表格)|做一份/, 'make_content'],
  [/(讲讲|讲一下|讲解|说说|解释|教一下|什么意思|发生了什么)/, 'explain_content'],
  [/(投上去|投到电视|投个|投屏|放到电视|传到电视)/, 'cast_content'],
  [/(几点|天气|股票|汇率|新闻|是什么|为什么|怎么|查一下|搜一下)/, 'ask_info'],
  [/(看|放|播)(个|一部|一个)?.*(电影|电视剧|动画|视频|新闻|《)|^看《|想看/, 'play_video'],
  // 兜底：「看个X/放一部X/播集X」——X 为片名（ask_info 的天气/股票等已在前面拦截）
  [/^(看|放|播)(个|一部|一个|部|集)\s*\S/, 'play_video'],
];

function mockClassify(text, ctx) {
  for (const [re, intent] of RULES) {
    if (re.test(text)) return withSlots(intent, text, ctx);
  }
  // 有已上传内容时，默认往讲解意图靠（PRD：由龙虾脑做意图分流）
  if (ctx.hasPackage && /讲|开会/.test(text)) return withSlots('explain_content', text, ctx);
  return { intent: 'unknown', slots: {}, confidence: 0.3, speak_now: '' };
}

function withSlots(intent, text, _ctx) {
  const slots = {};
  if (intent === 'play_video') {
    const m = text.match(/《(.+?)》/) || text.match(/(?:看|放|播)(?:个|一部|一个)?(.+?)(?:吧|。|$)/);
    if (m) slots.title = m[1].trim();
  }
  if (intent === 'control_playback') {
    if (/暂停|停一下/.test(text)) slots.op = 'pause';
    else if (/快进/.test(text)) slots.op = 'seek_forward';
    else if (/快退|倒回/.test(text)) slots.op = 'seek_back';
    else if (/换一集|下一集/.test(text)) slots.op = 'next_episode';
    else if (/关掉|停止播放/.test(text)) slots.op = 'stop';
    else if (/从头播/.test(text)) slots.op = 'restart';
    else slots.op = 'resume';
    const mm = text.match(/(\d+)\s*分/);
    if (mm) slots.seconds = Number(mm[1]) * 60;
  }
  if (intent === 'control_session') {
    if (/你来讲|开始讲/.test(text)) slots.op = 'start_present';
    else if (/继续|接着/.test(text)) slots.op = 'resume';
    else if (/重讲/.test(text)) slots.op = 'restart';
    else if (/^(停|停下|停下来|先停|别讲|不要讲|不讲了|别说|闭嘴|安静)|结束|停止/.test(text)) slots.op = 'stop';
    else if (/下一段/.test(text)) slots.op = 'next';
    else if (/上一段/.test(text)) slots.op = 'prev';
    else slots.op = 'style';
  }
  return { intent, slots, confidence: 0.9, speak_now: ackFor(intent) };
}

// 即时反馈话术（D-01 一秒内必有回应；话术库 C-02/C-03）
function ackFor(intent) {
  switch (intent) {
    case 'play_video': return '好嘞，我去找';
    case 'make_content': return '好嘞，我先列个提纲';
    case 'explain_content': return '好嘞，我先看一遍';
    case 'ask_info': return '我看看';
    case 'cast_content': return '好嘞';
    default: return '好嘞，我去办';
  }
}

const SYS_PROMPT = `你是"小乐"，乐播龙虾脑的意图理解模块。把用户对电视说的一句话解析为 JSON：
{"intent": "<${INTENTS.join('|')}>", "slots": {...}, "confidence": 0~1, "speak_now": "≤8字的即时口头回应"}
槽位约定：play_video→{title,episode}；control_playback→{op:pause|resume|seek_forward|seek_back|next_episode|stop|restart, seconds}；
control_session→{op:start_present|resume|restart|stop|next|prev|style}；make_content→{format:ppt|doc|table, audience, length, style}；
ask_info→{query}；explain_content→{target}。
speak_now 风格：干练不啰嗦，如"好嘞，我去找"。只输出 JSON。`;

export async function classify(text, ctx = {}) {
  if (!llmAvailable()) return mockClassify(text, ctx);
  try {
    const out = await chatJson([
      { role: 'system', content: SYS_PROMPT },
      { role: 'user', content: JSON.stringify({ text, context: { hasPackage: !!ctx.hasPackage, screen: ctx.screen, presenting: !!ctx.presenting } }) },
    ], { maxTokens: 300, temperature: 0, meta: ctx.meta });
    if (!INTENTS.includes(out.intent)) out.intent = 'unknown';
    out.speak_now = out.speak_now || ackFor(out.intent);
    return out;
  } catch (e) {
    log.warn('llm classify failed, fallback to rules:', e.message);
    return mockClassify(text, ctx);
  }
}
