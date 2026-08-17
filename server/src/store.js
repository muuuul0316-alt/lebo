// 轻量 JSON 持久化：包/Skill/埋点落盘，会话态在内存。
// 第一阶段单机部署够用；后续量级上来换 Redis/MySQL 时只动这一层。
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

function fileOf(name) { return path.join(config.dataDir, `${name}.json`); }

export function loadJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(fileOf(name), 'utf8')); }
  catch { return fallback; }
}

export function saveJson(name, value) {
  const tmp = fileOf(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, fileOf(name));
}

export function appendJsonl(name, obj) {
  fs.appendFileSync(path.join(config.dataDir, `${name}.jsonl`), JSON.stringify(obj) + '\n');
}

export const uid = (prefix) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
