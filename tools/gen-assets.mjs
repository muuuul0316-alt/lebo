// 视觉资源生成：调火山方舟 Seedream 文生图，产出品牌视觉资源到 tv/assets 与 phone/assets。
// 前端「有图用图、无图回落 CSS」，所以本脚本是可选增强，不生成也不影响功能。
//
// 为什么单独成脚本、不在服务进程里跑：生图是一次性的品牌资产制作，不是运行时依赖；
// 且需要能连通火山（部分受限网络/沙箱的出口代理会按策略封锁 ark 域名，需在放行环境执行）。
//
// 用法：
//   ARK_API_KEY=xxx node tools/gen-assets.mjs            # 全部生成
//   ARK_API_KEY=xxx SEEDREAM_MODEL=doubao-seedream-4-0-250920 node tools/gen-assets.mjs
//   ARK_API_KEY=xxx node tools/gen-assets.mjs hero-tv    # 只生成某一项
//
// 模型名以火山控制台实际开通为准（材料里已开通 doubao-seedream-3-0-t2i-250415；
// 4.0 / 5.0 Pro 等更高版本需在 ARK 控制台开通后把 SEEDREAM_MODEL 指过去）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_KEY = process.env.ARK_API_KEY;
const BASE = process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';
const MODEL = process.env.SEEDREAM_MODEL || 'doubao-seedream-3-0-t2i-250415';

if (!API_KEY) {
  console.error('缺少 ARK_API_KEY。用法：ARK_API_KEY=xxx node tools/gen-assets.mjs');
  process.exit(1);
}

// 统一品牌基调：龙虾橙红 + 深蓝夜色，扁平、克制、适合大屏与移动端。
const BRAND = '龙虾橙红(#ff6a3d)与深蓝夜色(#0a0e1a)为主色，扁平现代、克制不花哨、高级质感，无文字';

const ASSETS = [
  {
    key: 'hero-tv',
    out: 'tv/assets/hero-bg.png',
    size: '1920x1080',
    prompt: `电视大屏待机背景。极简深蓝夜色科技感氛围，中心留白放二维码，四周微弱的橙红光晕与柔和粒子。${BRAND}。氛围感、大气、留白充足`,
  },
  {
    key: 'mascot',
    out: 'tv/assets/xiaole.png',
    size: '1024x1024',
    prompt: `品牌吉祥物"小乐"：一只friendly的卡通龙虾与大脑意象结合的形象，圆润可爱又有科技感，象征"云端大模型主脑"。透明或纯色背景，正面半身。${BRAND}`,
  },
  {
    key: 'mascot-phone',
    out: 'phone/assets/xiaole-avatar.png',
    size: '512x512',
    prompt: `聊天助手头像"小乐"：一只圆润可爱的卡通龙虾脑袋图标，正面，简洁，适合做对话气泡头像。${BRAND}`,
  },
  {
    key: 'empty-feed',
    out: 'phone/assets/empty.png',
    size: '1024x1024',
    prompt: `手机 App 空状态插画：一只小龙虾对着一块电视大屏挥手，示意"说一句话就能投屏"，轻松友好，扁平插画风。${BRAND}`,
  },
  {
    key: 'phone-bg',
    out: 'phone/assets/bg.png',
    size: '1080x1920',
    prompt: `手机 App 深色背景：深蓝夜色，顶部有极淡的橙红渐变光晕，纯氛围无主体，适合叠加聊天信息流。${BRAND}`,
  },
];

async function genOne(a) {
  console.log(`生成 ${a.key} → ${a.out} (${MODEL}, ${a.size})`);
  const res = await fetch(`${BASE}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, prompt: a.prompt, size: a.size, n: 1, response_format: 'b64_json' }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const item = data.data?.[0];
  const outPath = path.join(ROOT, a.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  if (item?.b64_json) {
    fs.writeFileSync(outPath, Buffer.from(item.b64_json, 'base64'));
  } else if (item?.url) {
    const img = await fetch(item.url);
    fs.writeFileSync(outPath, Buffer.from(await img.arrayBuffer()));
  } else {
    throw new Error('返回中无图片数据：' + JSON.stringify(data).slice(0, 200));
  }
  console.log(`  ✓ 已写入 ${a.out}`);
}

const only = process.argv[2];
const list = only ? ASSETS.filter((a) => a.key === only) : ASSETS;
if (!list.length) { console.error('未知资源名。可选：', ASSETS.map((a) => a.key).join(', ')); process.exit(1); }

let ok = 0, fail = 0;
for (const a of list) {
  try { await genOne(a); ok++; }
  catch (e) { fail++; console.error(`  ✗ ${a.key} 失败：${e.message}`); }
  await new Promise((r) => setTimeout(r, 1500)); // 限流退避（材料提示偶发 429）
}
console.log(`\n完成：成功 ${ok}，失败 ${fail}。前端会自动使用已生成的图片，未生成的项回落到 CSS。`);
