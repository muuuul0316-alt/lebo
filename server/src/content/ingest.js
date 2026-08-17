// 内容管线：上传 → 解包 → 识别 → 理解 → 备课（P2-b 四阶段可视化）。
// 素材打散为独立单元（5.5.2 打散页码逻辑），产出讲解 Skill（6.11）。
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { config } from '../config.js';
import { uid, loadJson, saveJson } from '../store.js';
import { track } from '../metrics.js';
import { log } from '../log.js';
import { agentEvent } from '../protocol.js';
import { broadcastUsers } from '../sessions.js';
import * as parsers from './parsers.js';
import { generateSkill, makeOutlineLLM } from './skill.js';

const packages = loadJson('packages', {}); // packageId -> pkg（含 assets 与 skill）
function persist() { saveJson('packages', packages); }

export function getPackage(id) { return packages[id]; }

export function latestAssets(sess, n = 6) {
  for (let i = sess.packageIds.length - 1; i >= 0; i--) {
    const pkg = packages[sess.packageIds[i]];
    if (pkg?.assets?.length) {
      const media = pkg.assets.filter((a) => ['image', 'video'].includes(a.kind));
      return (media.length ? media : pkg.assets).slice(0, n);
    }
  }
  return [];
}

function assetUrl(relPath) { return `${config.publicBaseUrl}/uploads/${relPath}`; }

function stage(sess, packageId, stageName, detail) {
  broadcastUsers(sess, agentEvent(sess.sessionId, 'ingest_progress', { packageId, stage: stageName, detail }));
}

// files: [{originalname, path}]（multer 落盘后）
export async function ingest(sess, userId, files) {
  const packageId = uid('pkg');
  const pkgDir = path.join(config.uploadDir, packageId);
  fs.mkdirSync(pkgDir, { recursive: true });
  const t0 = Date.now();
  const pkg = { packageId, userId, createdAt: t0, files: [], assets: [], failures: [], skill: null };
  packages[packageId] = pkg;

  // ① 解包：zip（VIP 包）展开，其余文件平移
  stage(sess, packageId, '解包', '');
  const flat = [];
  for (const f of files) {
    const name = Buffer.from(f.originalname, 'latin1').toString('utf8'); // multer 中文名修正
    if (parsers.kindOf(name) === 'zip') {
      try {
        const zip = new AdmZip(f.path);
        for (const e of zip.getEntries()) {
          if (e.isDirectory || e.entryName.startsWith('__MACOSX')) continue;
          const base = path.basename(e.entryName);
          if (!parsers.isSupported(base)) continue;
          const out = path.join(pkgDir, `${flat.length}_${base}`);
          fs.writeFileSync(out, e.getData());
          flat.push({ name: base, path: out });
        }
      } catch (e) {
        pkg.failures.push({ file: name, reason: '压缩包打不开，可能损坏或加密' }); // E-21
      }
    } else {
      const out = path.join(pkgDir, `${flat.length}_${path.basename(name)}`);
      fs.renameSync(f.path, out);
      flat.push({ name, path: out });
    }
  }
  pkg.files = flat.map((f) => f.name);

  // ② 识别 + ③ 理解：逐文件解析为素材单元
  for (const f of flat) {
    stage(sess, packageId, '理解', f.name);
    try {
      await parseOne(pkg, pkgDir, f);
    } catch (e) {
      log.warn('parse failed', f.name, e.message);
      pkg.failures.push({ file: f.name, reason: '没读懂这个文件，其余继续' }); // E-21 不阻断
    }
  }

  // ④ 备课：生成讲解 Skill（6.11）
  stage(sess, packageId, '备课', '');
  pkg.skill = await generateSkill(pkg, { userId });
  persist();
  sess.packageIds.push(packageId);

  const counts = summarize(pkg);
  track('content', 'ingest_done', { packageId, files: flat.length, assets: pkg.assets.length, ms: Date.now() - t0, failures: pkg.failures.length });
  // 话术库 C-04
  broadcastUsers(sess, agentEvent(sess.sessionId, 'ingest_done', {
    packageId,
    speech: `已学完，可以开始了。我看了${counts}`,
    failures: pkg.failures,
    sections: pkg.skill.outline.length,
    estMinutes: Math.max(1, Math.round(pkg.skill.outline.reduce((s, o) => s + (o.est_duration_s || 60), 0) / 60)),
  }));
  return pkg;
}

function summarize(pkg) {
  const c = { doc: 0, image: 0, video: 0, table: 0 };
  for (const a of pkg.assets) {
    if (a.kind === 'image') c.image++;
    else if (a.kind === 'video') c.video++;
    else if (a.kind === 'table') c.table++;
    else c.doc++;
  }
  const parts = [];
  if (c.doc) parts.push(` ${c.doc} 份文档`);
  if (c.image) parts.push(` ${c.image} 张图`);
  if (c.video) parts.push(` ${c.video} 段视频`);
  if (c.table) parts.push(` ${c.table} 张表`);
  return parts.join('、') || '这些内容';
}

async function parseOne(pkg, pkgDir, f) {
  const kind = parsers.kindOf(f.name);
  const rel = (p) => path.relative(config.uploadDir, p).split(path.sep).join('/');

  if (kind === 'image' || kind === 'video') {
    pkg.assets.push({
      id: uid('as'), kind, from: f.name, url: assetUrl(rel(f.path)),
      caption: f.name.replace(/\.[^.]+$/, ''),
      understanding: null, // 生产模式由多模态模型回填（5.5.1 视频质量标杆）
    });
    return;
  }
  if (kind === 'pptx') {
    const slides = parsers.parsePptx(f.path, pkgDir);
    for (const s of slides) {
      pkg.assets.push({
        id: uid('as'), kind: 'doc_page', from: `${f.name}#p${s.page}`,
        caption: s.title, text: s.texts.join('\n'),
        images: s.images.map((p) => assetUrl(rel(p))),
      });
    }
    return;
  }
  if (kind === 'docx') {
    const paras = parsers.parseDocx(f.path);
    chunk(paras, 6).forEach((c, i) => pkg.assets.push({
      id: uid('as'), kind: 'doc_page', from: `${f.name}#s${i + 1}`,
      caption: c[0].slice(0, 30), text: c.join('\n'),
    }));
    return;
  }
  if (kind === 'xlsx') {
    const rows = parsers.parseXlsx(f.path);
    if (rows.length) pkg.assets.push({ id: uid('as'), kind: 'table', from: f.name, caption: f.name, rows: rows.slice(0, 30) });
    return;
  }
  if (kind === 'pdf') {
    const texts = parsers.parsePdfNaive(f.path);
    pkg.assets.push({ id: uid('as'), kind: 'doc_page', from: f.name, caption: f.name, text: texts.join('\n').slice(0, 4000) || '(扫描版 PDF，接入多模态模型后可理解)' });
    return;
  }
  if (kind === 'text') {
    const paras = parsers.parseText(f.path);
    chunk(paras, 8).forEach((c, i) => pkg.assets.push({
      id: uid('as'), kind: 'doc_page', from: `${f.name}#s${i + 1}`, caption: c[0].slice(0, 30), text: c.join('\n'),
    }));
  }
}

const chunk = (arr, n) => arr.length ? Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n)) : [];

// ---- 内容生产（5.6）：口述/素材 → 大纲 ----
export async function makeOutline(sess, request, meta) {
  const pkg = sess.packageIds.length ? packages[sess.packageIds.at(-1)] : null;
  return makeOutlineLLM(request, pkg, meta);
}

// 大纲 → 可直接开讲的包（云桌面未接入时的降级产物，5.6.4 直接开讲通道）
export async function outlineToPackage(sess, outline) {
  const packageId = uid('pkg');
  const pkg = {
    packageId, createdAt: Date.now(), files: [], failures: [],
    assets: outline.sections.map((s, i) => ({ id: uid('as'), kind: 'doc_page', from: `outline#${i + 1}`, caption: s.title, text: `${s.title}\n${s.point}\n${(s.details || []).join('\n')}` })),
    skill: null,
  };
  pkg.skill = await generateSkill(pkg, {});
  packages[packageId] = pkg;
  persist();
  return pkg;
}
