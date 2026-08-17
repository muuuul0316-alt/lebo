// 抓取阿里云 OpenAPI 官方元数据（无影云电脑 ECD / 无影云手机 eds-aic），存到 docs/api-meta/。
// 目的：让云桌面与云手机的控制代码基于官方准确的 Action 名与参数定义，而不是凭记忆。
// 在有公网出口的环境执行（GitHub Actions runner）；开发沙箱访问不到 aliyun 域名。
//
// 用法：node tools/fetch-cloud-api.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'api-meta');
fs.mkdirSync(OUT, { recursive: true });

const META = 'https://next.api.aliyun.com/meta/v1';

// 只保留我们关心的 Action，避免把几百个接口全量落盘
const KEEP = {
  ecd: [
    'DescribeDesktops', 'StartDesktops', 'StopDesktops', 'RebootDesktops',
    'RunCommand', 'DescribeInvocations', 'GetConnectionTicket',
    'CreateDesktops', 'DeleteDesktops', 'DescribeDesktopTypes',
    'DescribeOfficeSites', 'DescribeUserConnectionRecords', 'ModifyDesktopSpec',
  ],
  'eds-aic': [
    'DescribeAndroidInstances', 'StartAndroidInstance', 'StopAndroidInstance',
    'RebootAndroidInstance', 'RunCommand', 'DescribeInvocations',
    'BatchGetAcpConnectionTicket', 'CreateAndroidInstanceGroup',
    'DescribeAndroidInstanceGroups', 'InstallApp', 'UninstallApp',
    'SendFile', 'FetchFile', 'DescribeTasks', 'ModifyAndroidInstance',
  ],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 阿里云元数据接口有限流，失败按指数退避重试
async function getJson(url, retries = 4) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(30000),
        headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 lebo-api-fetch' },
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i < retries) await sleep(1500 * Math.pow(2, i)); // 1.5s→3s→6s→12s
    }
  }
  throw lastErr;
}

async function versionsOf(product) {
  // 官方元数据接口在不同时期路径略有差异，逐个尝试
  const candidates = [
    `${META}/products/${product}/versions.json`,
    `${META}/products/${product}.json`,
  ];
  for (const u of candidates) {
    try {
      const d = await getJson(u);
      const vs = Array.isArray(d) ? d : (d.versions || d.apiVersions || []);
      const list = vs.map((v) => (typeof v === 'string' ? v : v.version || v.apiVersion)).filter(Boolean);
      if (list.length) return list;
    } catch { /* 换下一个 */ }
  }
  return [];
}

async function fetchProduct(product, knownVersions) {
  console.log(`\n=== ${product} ===`);
  let versions = await versionsOf(product);
  if (!versions.length) versions = knownVersions;
  console.log('版本候选:', versions.join(', ') || '(无)');

  for (const ver of versions) {
    const url = `${META}/products/${product}/versions/${ver}/api-docs.json`;
    try {
      const doc = await getJson(url);
      const apis = doc.apis || {};
      const names = Object.keys(apis);
      if (!names.length) { console.log(`  ${ver}: 无 apis 字段，跳过`); continue; }
      console.log(`  ${ver}: 共 ${names.length} 个接口`);

      const keep = KEEP[product] || [];
      const picked = {};
      for (const n of names) {
        if (!keep.length || keep.includes(n)) {
          const a = apis[n];
          picked[n] = {
            summary: a.summary || a.title || '',
            method: a.methods?.[0] || a.method || 'GET',
            path: a.path || '/',
            parameters: (a.parameters || []).map((p) => ({
              name: p.name,
              in: p.in,
              required: !!p.schema?.required || !!p.required,
              type: p.schema?.type,
              description: (p.schema?.description || p.description || '').slice(0, 200),
              example: p.schema?.example,
            })),
          };
        }
      }
      const out = {
        product,
        version: ver,
        endpoint_pattern: doc.directories?.endpoint || `${product}.{region}.aliyuncs.com`,
        style: doc.info?.style || doc.style || 'RPC',
        total_apis: names.length,
        picked_count: Object.keys(picked).length,
        apis: picked,
        all_api_names: names,
      };
      const f = path.join(OUT, `${product}-${ver}.json`);
      fs.writeFileSync(f, JSON.stringify(out, null, 1));
      console.log(`  ✓ 已保存 ${path.relative(ROOT, f)}（精选 ${out.picked_count} 个）`);
      await sleep(2000);
    } catch (e) {
      console.log(`  ${ver}: 抓取失败 ${e.message}`);
    }
  }
}

await fetchProduct('ecd', ['2020-09-30']);
await fetchProduct('eds-aic', ['2023-09-30', '2024-01-01']);

const files = fs.readdirSync(OUT).filter((f) => f.endsWith('.json'));
console.log(`\n完成，共 ${files.length} 个元数据文件：`, files.join(', '));
if (!files.length) {
  console.error('未能抓到任何元数据（可能被限流）。稍后重跑本 workflow 即可。');
  process.exit(1);
}
