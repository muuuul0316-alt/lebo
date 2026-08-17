// 多模态内容摄取（PRD 5.5.1）：PPTX/DOCX/XLSX 为 zip+xml，纯 Node 解析文本与图片；
// 图片/视频登记为素材单元，生产模式再由多模态模型补 understanding。
import AdmZip from 'adm-zip';
import path from 'node:path';
import fs from 'node:fs';

const IMG_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
const VID_EXT = ['.mp4', '.mov', '.webm', '.mkv', '.avi'];
const DOC_EXT = ['.pptx', '.ppt', '.docx', '.doc', '.pdf', '.xlsx', '.xls', '.txt', '.md'];

export function kindOf(filename) {
  const e = path.extname(filename).toLowerCase();
  if (IMG_EXT.includes(e)) return 'image';
  if (VID_EXT.includes(e)) return 'video';
  if (['.pptx', '.ppt'].includes(e)) return 'pptx';
  if (['.docx', '.doc'].includes(e)) return 'docx';
  if (['.xlsx', '.xls'].includes(e)) return 'xlsx';
  if (e === '.pdf') return 'pdf';
  if (['.txt', '.md'].includes(e)) return 'text';
  if (['.zip'].includes(e)) return 'zip';
  return 'other';
}

export function isSupported(filename) {
  const k = kindOf(filename);
  return k !== 'other';
}

const stripXml = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#\d+;/g, ' ').trim();

// PPTX：逐页提取文本 + 页内图片（PRD：逐页提取文本、图片、图表、备注）
export function parsePptx(filePath, extractDir) {
  const zip = new AdmZip(filePath);
  const slides = [];
  const entries = zip.getEntries().filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .sort((a, b) => Number(a.entryName.match(/\d+/)[0]) - Number(b.entryName.match(/\d+/)[0]));
  for (const e of entries) {
    const xml = e.getData().toString('utf8');
    const pageNo = Number(e.entryName.match(/\d+/)[0]);
    const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => stripXml(m[1])).filter(Boolean);
    // 页内引用的图片关系
    const relName = `ppt/slides/_rels/slide${pageNo}.xml.rels`;
    const rel = zip.getEntry(relName);
    const images = [];
    if (rel && extractDir) {
      const relXml = rel.getData().toString('utf8');
      for (const m of relXml.matchAll(/Target="\.\.\/media\/([^"]+)"/g)) {
        const mediaEntry = zip.getEntry(`ppt/media/${m[1]}`);
        if (mediaEntry && IMG_EXT.includes(path.extname(m[1]).toLowerCase())) {
          const out = path.join(extractDir, `p${pageNo}_${m[1]}`);
          fs.writeFileSync(out, mediaEntry.getData());
          images.push(out);
        }
      }
    }
    slides.push({ page: pageNo, title: texts[0] || `第 ${pageNo} 页`, texts, images });
  }
  return slides;
}

export function parseDocx(filePath) {
  const zip = new AdmZip(filePath);
  const doc = zip.getEntry('word/document.xml');
  if (!doc) return [];
  const xml = doc.getData().toString('utf8');
  const paras = [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)]
    .map((m) => stripXml(m[0].replace(/<w:tab\/>/g, ' ')))
    .filter((t) => t.length > 0);
  return paras;
}

export function parseXlsx(filePath) {
  const zip = new AdmZip(filePath);
  const sharedEntry = zip.getEntry('xl/sharedStrings.xml');
  const shared = sharedEntry
    ? [...sharedEntry.getData().toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => stripXml(m[1]))
    : [];
  const sheets = zip.getEntries().filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.entryName));
  const rows = [];
  for (const sheet of sheets.slice(0, 3)) {
    const xml = sheet.getData().toString('utf8');
    for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [...rm[1].matchAll(/<c[^>]*?(?:t="(\w+)")?[^>]*>(?:<f>[\s\S]*?<\/f>)?(?:<v>([\s\S]*?)<\/v>)?/g)]
        .map((cm) => (cm[1] === 's' ? shared[Number(cm[2])] ?? '' : cm[2] ?? ''));
      if (cells.some((c) => c !== '')) rows.push(cells);
      if (rows.length >= 60) break;
    }
  }
  return rows;
}

// PDF：v1 只做朴素文本抽取（未压缩文本对象）；扫描版/压缩版交由生产模式的多模态模型理解
export function parsePdfNaive(filePath) {
  const buf = fs.readFileSync(filePath);
  const s = buf.toString('latin1');
  const texts = [];
  for (const m of s.matchAll(/\(((?:[^()\\]|\\.){2,})\)\s*Tj/g)) {
    const t = m[1].replace(/\\(.)/g, '$1');
    if (/[一-龥a-zA-Z0-9]/.test(t)) texts.push(t);
    if (texts.length > 400) break;
  }
  return texts;
}

export function parseText(filePath) {
  return fs.readFileSync(filePath, 'utf8').split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
}
