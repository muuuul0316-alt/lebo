// 讲解引擎：讲解会话状态机（PRD 6.8）+ 边讲边展示（5.5.4）+ 打断问答（5.5.5）。
// 讲到哪展示到哪：素材由讲稿驱动，不按页码翻；打断 ≤500ms 静音；证据必标来源（D-04）。
import { agentEvent, tvCommand, layout, textCard } from '../protocol.js';
import { getDevice, sendToTv, sendToUser, broadcastUsers } from '../sessions.js';
import { getPackage } from '../content/ingest.js';
import { synthesize, estimateMs } from '../speech/tts.js';
import { chat, llmAvailable } from '../brain/llm.js';
import { track } from '../metrics.js';
import { log } from '../log.js';

function assetPane(asset, slot = 'main', sourceLabel = null) {
  const base = { slot, sourceLabel };
  if (!asset) return { ...base, kind: 'text_card', text: '' };
  if (asset.kind === 'image') return { ...base, kind: 'image', url: asset.url, title: asset.caption };
  if (asset.kind === 'video') return { ...base, kind: 'video', url: asset.url, title: asset.caption };
  if (asset.kind === 'table') return { ...base, kind: 'table', title: asset.caption, text: (asset.rows || []).map((r) => r.join(' | ')).join('\n') };
  // doc_page：有图用图，没图用大字卡（6.7.2 无素材时呈现核心论点大字卡）
  if (asset.images?.length) return { ...base, kind: 'image', url: asset.images[0], title: asset.caption };
  return { ...base, kind: 'doc_page', title: asset.caption, text: (asset.text || '').slice(0, 500) };
}

function findAsset(pkg, id) { return pkg.assets.find((a) => a.id === id); }

// ============ 开始讲解 ============
export async function startPresentation(sess, userId, { taskId } = {}) {
  const pkg = getPackage(sess.packageIds.at(-1));
  if (!pkg?.skill) {
    sendToUser(sess, userId, agentEvent(sess.sessionId, 'error', { speech: '内容还没备好课，稍等一下或重新上传。' }, taskId));
    return;
  }
  // Skill 复用（6.11）：同一包再次讲解直接加载，二次讲解 Token 下降 ≥70%
  sess.present = {
    state: 'PRESENTING', pkg, skill: pkg.skill,
    section: 0, timer: null, taskId,
    startedAt: Date.now(), interrupts: 0,
  };
  sess.presenterId = userId; // 讲解中主讲人优先（6.3.4）
  track('present', 'start', { packageId: pkg.packageId, sections: pkg.skill.outline.length, reuse: !!pkg.skill._used });
  pkg.skill._used = true;
  await playSection(sess);
}

async function playSection(sess) {
  const p = sess.present;
  if (!p || p.state !== 'PRESENTING') return;
  const dev = getDevice(sess.deviceId);
  const sec = p.skill.outline[p.section];
  if (!sec) return finish(sess);

  // 边讲边展示：本段素材上屏（S3 讲解屏）
  const assets = (sec.show || []).map((id) => findAsset(p.pkg, id)).filter(Boolean);
  const lay = assets.length
    ? layout('L1', [assetPane(assets[0])])
    : layout('L1', [{ slot: 'main', kind: 'text_card', title: sec.point, text: '' }]);
  const narration = sec.narration || sec.point;
  const audio = await synthesize(narration);
  sendToTv(dev, tvCommand(dev.deviceId, 'render', {
    layout: lay,
    presenting: { section: p.section + 1, total: p.skill.outline.length, point: sec.point },
    tts: { text: narration, audio_b64: audio, sync_with: 'layout' },
  }));
  dev.screen = 'S3';

  // 手机端讲解控制条（P2-c）：段落进度
  broadcastUsers(sess, agentEvent(sess.sessionId, 'presenting', {
    section: p.section + 1, total: p.skill.outline.length, point: sec.point,
  }, p.taskId));

  // 段落推进：按 TTS 估时驱动；电视端 tts_done 事件可提前触发
  const ms = estimateMs(narration, sec.est_duration_s);
  clearTimeout(p.timer);
  p.timer = setTimeout(() => { p.section++; playSection(sess).catch((e) => log.error(e)); }, ms);
}

function finish(sess) {
  const p = sess.present;
  const dev = getDevice(sess.deviceId);
  p.state = 'DONE';
  clearTimeout(p.timer);
  track('present', 'done', { packageId: p.pkg.packageId, ms: Date.now() - p.startedAt, interrupts: p.interrupts });
  sendToTv(dev, tvCommand(dev.deviceId, 'render', {
    layout: textCard('讲完了', ''),
    tts: { text: '讲完了。' },
  }));
  broadcastUsers(sess, agentEvent(sess.sessionId, 'present_done', {
    speech: '讲完了。', actions: ['restart_present', 'export_notes'],
  }, p.taskId));
}

// ============ 打断（≤500ms 静音，C-05：立即闭嘴不说废话） ============
export function interrupt(sess) {
  const p = sess.present;
  if (!p) return;
  clearTimeout(p.timer);
  p.state = 'ANSWERING';
  p.interrupts++;
  const dev = getDevice(sess.deviceId);
  sendToTv(dev, tvCommand(dev.deviceId, 'overlay', { ctl: { op: 'mute_tts' } })); // 电视端立即静音
  track('present', 'interrupt', { packageId: p.pkg.packageId });
}

// ============ 打断提问：先包内证据，后联网，查不到不瞎说（6.19 分镜） ============
export async function ask(sess, userId, question) {
  const p = sess.present;
  const dev = getDevice(sess.deviceId);
  if (p.state === 'PRESENTING') interrupt(sess);
  p.state = 'ANSWERING';
  sendToUser(sess, userId, agentEvent(sess.sessionId, 'ack', { speech: '正在找证据…', echo: question }));

  // ① 包内命中：qa_index 匹配 → 证据位展开（≤2s）
  const hit = matchQa(p.skill, question) || searchAssets(p.pkg, question);
  if (hit) {
    const label = `来自你的包 · ${hit.asset.from || hit.asset.caption}`;
    const answer = await composeEvidenceAnswer(question, hit, { userId });
    const lay = layout('L2_MAIN_SIDE', [
      assetPane(currentAsset(p), 'main'),
      { ...assetPane(hit.asset, 'side'), sourceLabel: label },
    ]);
    const audio = await synthesize(answer);
    sendToTv(dev, tvCommand(dev.deviceId, 'render', { layout: lay, tts: { text: answer, audio_b64: audio } }));
    track('present', 'qa_hit_package', {});
    afterAnswer(sess, userId, answer, label);
    return;
  }

  // ② 包内未命中 → 联网/模型补证据（C-07/C-08）；查不到不编造（C-09 / E-25）
  if (llmAvailable()) {
    const answer = await chat([
      { role: 'system', content: '你是讲解助手小乐。回答听众的追问：简短口语化（≤120字）。如果你不掌握该事实，直接回答"这个数据我没查到，我不瞎说"。' },
      { role: 'user', content: `讲解主题相关素材：${p.skill.outline.map((o) => o.point).join('；')}\n听众问题：${question}` },
    ], { maxTokens: 400, meta: { userId } }).catch(() => null);
    const text = answer || '这个数据我没查到，我不瞎说。';
    const label = '来自全网检索';
    const audio = await synthesize(text);
    sendToTv(dev, tvCommand(dev.deviceId, 'render', {
      layout: layout('L2_MAIN_SIDE', [assetPane(currentAsset(p), 'main'), { slot: 'side', kind: 'text_card', title: '补充资料', text, sourceLabel: label }]),
      tts: { text, audio_b64: audio },
    }));
    track('present', 'qa_web', {});
    afterAnswer(sess, userId, text, label);
  } else {
    const text = '这个你没准备，我这边也没查到，我不瞎说。';
    const audio = await synthesize(text);
    sendToTv(dev, tvCommand(dev.deviceId, 'overlay', { tts: { text, audio_b64: audio } }));
    track('present', 'qa_miss', {});
    afterAnswer(sess, userId, text, null);
  }
}

function afterAnswer(sess, userId, answer, sourceLabel) {
  const p = sess.present;
  sendToUser(sess, userId, agentEvent(sess.sessionId, 'answer', {
    speech: answer, source_label: sourceLabel, actions: ['resume_present'],
  }));
  // 30s 无人应答自动续讲（E-27 的温和版：询问一次后续讲）
  clearTimeout(p.timer);
  p.timer = setTimeout(() => { if (p.state === 'ANSWERING') control(sess, userId, 'resume'); }, 30000);
}

function currentAsset(p) {
  const sec = p.skill.outline[p.section];
  const id = sec?.show?.[0];
  return id ? findAsset(p.pkg, id) : { kind: 'text_card', caption: sec?.point, text: '' };
}

function matchQa(skill, question) {
  for (const qa of skill.qa_index || []) {
    try {
      if (new RegExp(qa.q_pattern).test(question)) {
        const asset = findAsset({ assets: getPackage(skill.package_id)?.assets || [] }, qa.evidence?.[0]);
        if (asset) return { asset, hint: qa.answer_hint };
      }
    } catch { /* 坏正则跳过 */ }
  }
  return null;
}

// 朴素素材检索：提问关键词命中素材文本/标题
function searchAssets(pkg, question) {
  const words = question.replace(/[，。？！?,.!\s]/g, '').split('');
  let best = null, bestScore = 0;
  for (const a of pkg.assets) {
    const hay = `${a.caption || ''}${a.text || ''}`;
    if (!hay) continue;
    let score = 0;
    for (let i = 0; i < words.length - 1; i++) {
      if (hay.includes(words[i] + words[i + 1])) score++;
    }
    if (score > bestScore) { best = a; bestScore = score; }
  }
  // 阈值 1：一个实词二元组命中即可作为包内证据（mock 模式无 qa_index 时的兜底）
  return bestScore >= 1 ? { asset: best, hint: null } : null;
}

async function composeEvidenceAnswer(question, hit, meta) {
  // 话术库 C-06
  const base = `这个在你的材料里，${hit.asset.from || hit.asset.caption}，你看这里——`;
  if (!llmAvailable()) return base + (hit.hint ? ` ${hit.hint}` : '');
  const ans = await chat([
    { role: 'system', content: '你是讲解助手小乐。基于给定证据素材回答听众追问，口语化、≤100字、只依据素材内容不编造。开头用"这个在你的材料里——"' },
    { role: 'user', content: `证据素材：${JSON.stringify({ caption: hit.asset.caption, text: (hit.asset.text || '').slice(0, 800), rows: hit.asset.rows?.slice(0, 8) })}\n问题：${question}` },
  ], { maxTokens: 300, meta }).catch(() => null);
  return ans || base;
}

// ============ 讲解控制（P2-c 控制条 / control_session 意图） ============
export async function control(sess, userId, op) {
  const p = sess.present;
  const dev = getDevice(sess.deviceId);
  if (!p) {
    if (op === 'start_present') {
      const { startPresentation } = await import('./engine.js');
      return startPresentation(sess, userId, {});
    }
    return;
  }
  clearTimeout(p.timer);
  switch (op) {
    case 'start_present':
      if (p.state !== 'PRESENTING') { p.state = 'PRESENTING'; p.section = 0; await playSection(sess); }
      break;
    case 'resume':
      p.state = 'PRESENTING';
      await playSection(sess); // 从打断点续讲（5.5.5 ④）
      break;
    case 'pause':
      p.state = 'ANSWERING';
      sendToTv(dev, tvCommand(dev.deviceId, 'overlay', { ctl: { op: 'mute_tts' } }));
      break;
    case 'next':
      p.section = Math.min(p.section + 1, p.skill.outline.length);
      p.state = 'PRESENTING'; await playSection(sess); break;
    case 'prev':
      p.section = Math.max(p.section - 1, 0);
      p.state = 'PRESENTING'; await playSection(sess); break;
    case 'restart':
      p.section = 0; p.state = 'PRESENTING'; await playSection(sess); break;
    case 'stop':
      finish(sess); break;
    default:
      p.state = 'PRESENTING'; await playSection(sess);
  }
  track('present', 'control', { op });
}

// 电视端播完一段 TTS 主动上报，提前推进（比估时更准）
export function onTtsDone(sess) {
  const p = sess.present;
  if (p && p.state === 'PRESENTING') {
    clearTimeout(p.timer);
    p.timer = setTimeout(() => { p.section++; playSection(sess).catch(() => {}); }, 800);
  }
}
