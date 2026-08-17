// 执行器：一句话 → 意图 → 任务树 → 路由执行 → 电视显示 + 手机状态卡（PRD 6.13 七阶段）。
// 铁律：≤1s 即时反馈（D-01）；视频以 tv_player 收尾（7.4）；过程可见（D-02）。
import { classify } from './intent.js';
import { planFor } from './planner.js';
import { chat, llmAvailable } from './llm.js';
import { agentEvent, tvCommand, layout, textCard } from '../protocol.js';
import { getDevice, sendToTv, sendToUser, broadcastUsers, takeControl } from '../sessions.js';
import { synthesize } from '../speech/tts.js';
import { track } from '../metrics.js';
import { uid } from '../store.js';
import { config } from '../config.js';
import { log } from '../log.js';
import * as present from '../present/engine.js';
import * as content from '../content/ingest.js';
import * as cua from '../cua/wuying.js';

// 演示片源（合法内容；正式片源体系见 PRD Q-09，由内容合作方接入）
const DEFAULT_MEDIA = [
  { title: '大雄兔', keywords: ['大雄兔', 'big buck bunny', '兔子', '动画'], url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4' },
  { title: 'Sintel', keywords: ['sintel', '辛特尔', '龙'], url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4' },
  { title: '钢铁之泪', keywords: ['钢铁之泪', 'tears of steel', '科幻'], url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4' },
];

function mediaLibrary() {
  return config.demoMedia.length ? config.demoMedia : DEFAULT_MEDIA;
}

function findMedia(title) {
  const lib = mediaLibrary();
  if (!title) return lib[0];
  const t = title.toLowerCase();
  return lib.find((m) => m.title.toLowerCase().includes(t) || (m.keywords || []).some((k) => t.includes(k.toLowerCase()) || k.toLowerCase().includes(t)))
    || lib[0]; // 找不到给最接近的（E-16 推荐相近内容）
}

async function speakOnTv(dev, text, { voice } = {}) {
  if (!text) return;
  const audio = await synthesize(text, { voice }); // null 时电视端用本地 speechSynthesis 兜底
  sendToTv(dev, tvCommand(dev.deviceId, 'overlay', { tts: { text, audio_b64: audio, voice: voice || 'xiaole_main' } }));
}

function progress(sess, userId, taskId, steps, speech) {
  sendToUser(sess, userId, agentEvent(sess.sessionId, 'task_progress', { steps, speech }, taskId));
}

// ============ 主入口：一句话进来 ============
export async function handleUserText(sess, userId, text, { isInterrupt = false } = {}) {
  const dev = getDevice(sess.deviceId);
  const taskId = uid('task');
  const t0 = Date.now();
  track('interaction', 'user_input', { sessionId: sess.sessionId, userId, len: text.length, isInterrupt });

  // 讲解中被打断：≤500ms 静音让位（5.5.5），随后按"提问 or 控制"分流
  if (sess.present && sess.present.state === 'PRESENTING' && isInterrupt) {
    present.interrupt(sess);
  }

  const ctx = {
    hasPackage: sess.packageIds.length > 0,
    screen: dev?.screen,
    presenting: sess.present?.state === 'PRESENTING' || sess.present?.state === 'ANSWERING',
    meta: { userId, taskId },
  };
  const intentResult = await classify(text, ctx);
  track('intent', 'classified', { taskId, intent: intentResult.intent, confidence: intentResult.confidence });

  // 讲解态下的自由提问 → 问答通道（先查包内证据，再联网，PRD 6.19）
  if (ctx.presenting && !['control_session', 'control_playback', 'control_layout'].includes(intentResult.intent)) {
    return present.ask(sess, userId, text);
  }

  // 控制权：最后一个发起有效指令的人持有（6.3.4）
  if (intentResult.intent !== 'unknown') takeControl(sess, userId);

  // ≤1s 即时反馈（手机 + 电视双通道）
  const ack = intentResult.speak_now || '好嘞';
  sendToUser(sess, userId, agentEvent(sess.sessionId, 'ack', { speech: ack, echo: text }, taskId));
  if (dev && !['control_playback', 'control_layout', 'control_session'].includes(intentResult.intent)) {
    speakOnTv(dev, ack).catch(() => {});
  }

  const plan = planFor(intentResult, ctx);
  track('route', 'planned', { taskId, intent: plan.intent, executors: plan.tasks.map((t) => t.executor) });

  try {
    await execute(sess, userId, dev, taskId, plan, text);
    track('exec', 'task_done', { taskId, intent: plan.intent, ms: Date.now() - t0 });
  } catch (e) {
    log.error('task failed', taskId, e.message);
    track('exec', 'task_failed', { taskId, intent: plan.intent, reason: e.message });
    // 人话解释，不暴露技术错误码（LB-03）
    sendToUser(sess, userId, agentEvent(sess.sessionId, 'error', { speech: '这个我暂时做不了。要不试试这样——换个说法，或者点下面的快捷指令。' }, taskId));
  }
}

async function execute(sess, userId, dev, taskId, plan, rawText) {
  const { intent, slots } = plan;
  switch (intent) {
    case 'play_video': return execPlay(sess, userId, dev, taskId, slots);
    case 'control_playback': return execPlayback(sess, userId, dev, taskId, slots);
    case 'ask_info': return execAnswer(sess, userId, dev, taskId, slots, rawText);
    case 'cast_content': return execCast(sess, userId, dev, taskId, slots);
    case 'explain_content': return execExplain(sess, userId, dev, taskId, slots, rawText);
    case 'control_session': return execSessionCtl(sess, userId, dev, taskId, slots);
    case 'control_layout': return execLayout(sess, userId, dev, taskId, slots);
    case 'make_content': return execMake(sess, userId, dev, taskId, slots, rawText);
    default:
      sendToUser(sess, userId, agentEvent(sess.sessionId, 'clarify', {
        speech: '没听懂想做什么。可以说"看个电影"、"讲讲我传的文件"，或者点下面的快捷指令。',
      }, taskId));
  }
}

// ---- 播放：找片源 → 本地播放器直连（7.4 生死线） ----
async function execPlay(sess, userId, dev, taskId, slots) {
  progress(sess, userId, taskId, [{ name: '找片源', status: 'running' }], null);
  const media = findMedia(slots.title);
  progress(sess, userId, taskId, [{ name: '找片源', status: 'done' }, { name: '起播', status: 'running' }], null);
  sendToTv(dev, tvCommand(dev.deviceId, 'play_local', {
    play: { url: media.url, start_at_ms: 0, title: media.title },
  }));
  dev.screen = 'S2';
  sess.activeTask = { taskId, kind: 'play', media };
  track('play', 'play_start', { taskId, title: media.title, source: 'local' });
  const note = slots.title && media.title !== slots.title ? `没找到《${slots.title}》，先放个《${media.title}》` : '开始了';
  sendToUser(sess, userId, agentEvent(sess.sessionId, 'task_result', {
    speech: note,
    card: { kind: 'playing', title: media.title },
    actions: ['pause', 'restart', 'stop'],
  }, taskId));
}

async function execPlayback(sess, userId, dev, taskId, slots) {
  const op = slots.op || 'resume';
  sendToTv(dev, tvCommand(dev.deviceId, 'player_ctl', { ctl: { op, seconds: slots.seconds || 600 } }));
  if (op === 'stop') { dev.screen = 'S0'; sess.activeTask = null; }
  track('play', 'player_ctl', { taskId, op });
  sendToUser(sess, userId, agentEvent(sess.sessionId, 'task_result', { speech: '', silent: true }, taskId));
}

// ---- 纯问答：主脑联网/直答 → 电视大字卡 + TTS（3.2 维度②） ----
async function execAnswer(sess, userId, dev, taskId, slots, rawText) {
  let answer;
  if (/几点/.test(rawText)) {
    const now = new Date(Date.now() + 8 * 3600e3); // 北京时间
    answer = `现在是北京时间 ${now.getUTCHours()} 点 ${String(now.getUTCMinutes()).padStart(2, '0')} 分`;
  } else if (llmAvailable()) {
    answer = await chat([
      { role: 'system', content: '你是电视上的语音助手小乐。回答要口语化、简短（≤120字）、适合读出来给一屋子人听。不确定就直说"这个我没查到，我不瞎说"。' },
      { role: 'user', content: rawText },
    ], { maxTokens: 400, meta: { userId, taskId } });
  } else {
    answer = '这个问题要联网查，等接上大模型我就能答了。现在可以试试"看个电影"或者传个文件让我讲。';
  }
  sendToTv(dev, tvCommand(dev.deviceId, 'render', { layout: textCard('小乐', answer) }));
  dev.screen = 'S3';
  await speakOnTv(dev, answer);
  sendToUser(sess, userId, agentEvent(sess.sessionId, 'task_result', { speech: answer }, taskId));
}

// ---- 投屏：已上传素材直接铺上电视（3.2 维度③） ----
async function execCast(sess, userId, dev, taskId) {
  const assets = content.latestAssets(sess, 6);
  if (!assets.length) {
    sendToUser(sess, userId, agentEvent(sess.sessionId, 'clarify', { speech: '先点"+"把照片或文件传给我，我就能投上去。' }, taskId));
    return;
  }
  const lay = assets.length === 1
    ? layout('L1', [{ slot: 'main', kind: assets[0].kind === 'video' ? 'video' : 'image', url: assets[0].url, title: assets[0].caption }])
    : layout('L6', assets.map((a, i) => ({ slot: `p${i}`, kind: a.kind === 'video' ? 'video' : 'image', url: a.url, title: a.caption })));
  sendToTv(dev, tvCommand(dev.deviceId, 'render', { layout: lay }));
  dev.screen = assets.length === 1 ? 'S1' : 'S4';
  track('content', 'cast', { taskId, count: assets.length });
  sendToUser(sess, userId, agentEvent(sess.sessionId, 'task_result', { speech: '投上去了', actions: ['explain'] }, taskId));
}

// ---- 讲解：转交内容理解与讲解引擎（5.5 核心差异化） ----
async function execExplain(sess, userId, dev, taskId, slots, rawText) {
  if (!sess.packageIds.length) {
    sendToUser(sess, userId, agentEvent(sess.sessionId, 'clarify', { speech: '先把要讲的东西传给我：点"+"，选文件或 VIP 包。' }, taskId));
    return;
  }
  await present.startPresentation(sess, userId, { taskId, request: rawText });
}

async function execSessionCtl(sess, userId, dev, taskId, slots) {
  await present.control(sess, userId, slots.op || 'resume');
  sendToUser(sess, userId, agentEvent(sess.sessionId, 'task_result', { silent: true }, taskId));
}

async function execLayout(sess, userId, dev, taskId, slots) {
  sendToTv(dev, tvCommand(dev.deviceId, 'layout_ctl', { ctl: slots }));
  sendToUser(sess, userId, agentEvent(sess.sessionId, 'task_result', { silent: true }, taskId));
}

// ---- 内容生产：先大纲后成品（5.6.1）。云桌面制作段由 CUA 承接，未配云桌面时降级为讲稿产物 ----
async function execMake(sess, userId, dev, taskId, slots, rawText) {
  progress(sess, userId, taskId, [{ name: '正在想结构', status: 'running' }], null);
  const outline = await content.makeOutline(sess, rawText, { userId, taskId });
  sess.activeTask = { taskId, kind: 'make', outline, confirmed: false };
  // 大纲闸门：电视端全屏铺开，等待用户确认（禁止跳过直接出成品）
  sendToTv(dev, tvCommand(dev.deviceId, 'render', {
    layout: layout('L1', [{ slot: 'main', kind: 'text_card', title: outline.title, text: outline.sections.map((s, i) => `${i + 1}. ${s.title} —— ${s.point}`).join('\n') }]),
  }));
  dev.screen = 'S3';
  await speakOnTv(dev, `提纲列好了，一共 ${outline.sections.length} 页。要改就说，比如"第三页删掉"；说"就这么做"我就开工。`);
  sendToUser(sess, userId, agentEvent(sess.sessionId, 'outline', {
    speech: `提纲好了，共 ${outline.sections.length} 页`,
    outline, actions: ['confirm_outline'],
  }, taskId));

  if (cua.available()) {
    // 确认后由 CUA 在云桌面逐页制作（confirm 指令走 confirmOutline）
  }
}

export async function confirmOutline(sess, userId) {
  const t = sess.activeTask;
  if (!t || t.kind !== 'make') return;
  t.confirmed = true;
  const dev = getDevice(sess.deviceId);
  if (cua.available()) {
    await cua.makePptxOnDesktop(sess, userId, t.outline);
  } else {
    // 未接云桌面：降级为结构化讲稿 + 可直接开讲（产物交付通道 5.6.4 之"直接开讲"）
    const pkg = await content.outlineToPackage(sess, t.outline);
    sess.packageIds.push(pkg.packageId);
    await speakOnTv(dev, '做好了。云桌面还没接上，先给你一份可以直接开讲的版本，说"你来讲"就开始。');
    broadcastUsers(sess, agentEvent(sess.sessionId, 'task_result', {
      speech: `做好了，${t.outline.sections.length} 页。说"你来讲"我就开讲。`,
      actions: ['start_present'],
    }, t.taskId));
  }
}
