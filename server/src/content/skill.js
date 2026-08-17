// 讲解 Skill 生成（PRD 6.11 / 7.2）：一次解析，成型固化；讲解与问答围绕 Skill 执行，不重复喂全量原文。
// LLM 通道：按底层逻辑重组讲解路径（打散页码，5.5.2）；mock 通道：结构化启发式，保证离线可跑。
import { llmAvailable, chatJson } from '../brain/llm.js';
import { uid } from '../store.js';
import { log } from '../log.js';

const SKILL_PROMPT = `你是"小乐"的备课引擎。给你一批素材单元（打散后的图/表/文档段/视频），产出讲解 Skill JSON：
{
 "outline":[{"section":1,"point":"本段核心论点(口语化标题)","narration":"该段完整讲稿，口语化、讲底层逻辑、不要照念原文，120-260字",
   "show":["素材id"...],"est_duration_s":秒数}...],
 "qa_index":[{"q_pattern":"正则或关键词|分隔","evidence":["素材id"],"answer_hint":"回答要点"}...]
}
硬性要求（PRD 5.5.7 讲解质量标准）：
- 不按素材原顺序平铺，先讲结论与逻辑，再用素材佐证；
- 讲稿像行业专家口头讲，禁止"本页展示了…"这类念稿腔；
- 每段 show 里只放最相关素材 id；4-8 段为宜。只输出 JSON。`;

export async function generateSkill(pkg, meta = {}) {
  const assetBrief = pkg.assets.map((a) => ({
    id: a.id, kind: a.kind, caption: a.caption,
    text: (a.text || '').slice(0, 600), rows: a.rows ? a.rows.slice(0, 5) : undefined,
  }));

  let outline = null, qaIndex = [];
  if (llmAvailable() && assetBrief.length) {
    try {
      const out = await chatJson([
        { role: 'system', content: SKILL_PROMPT },
        { role: 'user', content: JSON.stringify({ assets: assetBrief }) },
      ], { maxTokens: 4000, temperature: 0.5, meta });
      outline = out.outline;
      qaIndex = out.qa_index || [];
    } catch (e) {
      log.warn('skill llm failed, fallback heuristic:', e.message);
    }
  }
  if (!outline || !outline.length) ({ outline, qaIndex } = heuristicSkill(pkg));

  return {
    skill_id: uid('sk'),
    package_id: pkg.packageId,
    generated_at: new Date().toISOString(),
    outline,
    qa_index: qaIndex,
    fallback: { search_web: llmAvailable(), must_label_source: true, max_latency_ms: 8000 },
  };
}

// mock/兜底备课：按素材类型编排「结论先行 → 素材佐证」的讲解路径
function heuristicSkill(pkg) {
  const docs = pkg.assets.filter((a) => a.kind === 'doc_page');
  const media = pkg.assets.filter((a) => ['image', 'video'].includes(a.kind));
  const tables = pkg.assets.filter((a) => a.kind === 'table');
  const outline = [];
  let sec = 1;

  const opening = docs[0] || media[0] || tables[0];
  if (opening) {
    outline.push({
      section: sec++, point: '先说结论：这份材料想讲什么',
      narration: firstSentences(opening.text, 3) || `这组材料一共 ${pkg.assets.length} 个素材。我先带着大家把主线过一遍，再逐个看细节。有问题随时打断我。`,
      show: [opening.id], est_duration_s: 45,
    });
  }
  for (const d of docs.slice(1, 6)) {
    outline.push({
      section: sec++, point: d.caption || `第 ${sec} 部分`,
      narration: firstSentences(d.text, 4) || `${d.caption}，这一段的要点在屏幕上。`,
      show: [d.id], est_duration_s: 60,
    });
  }
  for (const m of media.slice(0, 3)) {
    outline.push({
      section: sec++, point: m.kind === 'video' ? `看一段视频：${m.caption}` : `看一张图：${m.caption}`,
      narration: m.understanding || `${m.caption}。${m.kind === 'video' ? '我们直接看画面，看完我说说里面的关键点。' : '注意画面里的细节，这张图是这一段的关键证据。'}`,
      show: [m.id], est_duration_s: m.kind === 'video' ? 90 : 40,
    });
  }
  for (const t of tables.slice(0, 2)) {
    outline.push({
      section: sec++, point: `数据说话：${t.caption}`,
      narration: '这张表是硬数据。结论都要能落到这张表上，等会儿谁要问"数据哪来的"，就是它。',
      show: [t.id], est_duration_s: 50,
    });
  }
  if (!outline.length) {
    outline.push({ section: 1, point: '内容已收到', narration: '内容我收下了，不过没解析出可讲的素材。换个文件试试，或者直接问我。', show: [], est_duration_s: 15 });
  }
  const qaIndex = [
    ...(tables.length ? [{ q_pattern: '数据|来源|哪来|多少', evidence: [tables[0].id], answer_hint: '引用表格数据回答' }] : []),
    ...(media.length ? [{ q_pattern: '图|视频|画面|照片', evidence: [media[0].id], answer_hint: '调出对应素材' }] : []),
  ];
  return { outline, qaIndex };
}

function firstSentences(text, n) {
  if (!text) return '';
  const parts = text.replace(/\n+/g, '。').split(/(?<=[。！？!?])/).map((s) => s.trim()).filter((s) => s.length > 3);
  return parts.slice(0, n).join('');
}

// ---- 内容生产的大纲（5.6.1 ②）----
const OUTLINE_PROMPT = `你是"小乐"的内容生产模块。用户要把素材做成一份 PPT/文档。产出 JSON：
{"title":"标题","format":"ppt","sections":[{"title":"页标题","point":"一句话要点","details":["要点明细"...]}...]}
按用户说的篇幅来（默认 8-10 页）；优先使用用户素材里的信息，不要编造数据。只输出 JSON。`;

export async function makeOutlineLLM(request, pkg, meta = {}) {
  if (llmAvailable()) {
    try {
      return await chatJson([
        { role: 'system', content: OUTLINE_PROMPT },
        { role: 'user', content: JSON.stringify({ request, assets: (pkg?.assets || []).map((a) => ({ caption: a.caption, text: (a.text || '').slice(0, 400) })) }) },
      ], { maxTokens: 2500, temperature: 0.5, meta });
    } catch (e) { log.warn('outline llm failed:', e.message); }
  }
  // mock：用已有素材标题拼一份提纲
  const secs = (pkg?.assets || []).slice(0, 8).map((a) => ({ title: a.caption || '要点', point: firstSentences(a.text, 1) || '见素材', details: [] }));
  return {
    title: '汇报提纲', format: 'ppt',
    sections: secs.length ? secs : [
      { title: '背景与问题', point: '为什么要做这件事', details: [] },
      { title: '方案', point: '我们打算怎么做', details: [] },
      { title: '计划与节奏', point: '什么时候做到什么程度', details: [] },
    ],
  };
}
