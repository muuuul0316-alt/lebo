// 阿里云 RPC 风格 OpenAPI 客户端（纯 Node 实现 HMAC-SHA1 签名，不引 SDK）。
// 支持无影云电脑（ecd，2020-09-30）与无影云手机（eds-aic，2023-09-30）。
// 接口定义来源：docs/api-meta/*.json（由 Actions 从阿里云官方元数据抓取）。
//
// 为什么用 POST：官方元数据标注这些接口为 post，且 RunCommand 的 CommandContent
// 经 Base64 后可达 16KB —— 走 GET 查询串必然触发 414 URI Too Long。
import crypto from 'node:crypto';
import { config } from '../config.js';

const pctEncode = (s) => encodeURIComponent(s)
  .replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~');

export const PRODUCTS = {
  ecd: { version: '2020-09-30', host: (r) => `ecd.${r}.aliyuncs.com` },          // 云电脑
  'eds-aic': { version: '2023-09-30', host: (r) => `eds-aic.${r}.aliyuncs.com` }, // 云手机
};

// 数组参数展开为阿里云 RPC 约定的 Name.1 / Name.2 …
export function expandArray(name, values) {
  const out = {};
  (Array.isArray(values) ? values : [values]).forEach((v, i) => {
    if (v !== undefined && v !== null && v !== '') out[`${name}.${i + 1}`] = v;
  });
  return out;
}

/**
 * 调用阿里云 RPC 接口。
 * @param {'ecd'|'eds-aic'} product
 * @param {string} action  接口名，如 DescribeDesktops
 * @param {object} params  业务参数（数组请先用 expandArray 展开）
 * @param {object} creds   {accessKeyId, accessKeySecret, region}，默认取 config.wuying
 */
export async function rpcCall(product, action, params = {}, creds = {}) {
  const p = PRODUCTS[product];
  if (!p) throw new Error(`未知产品 ${product}`);
  const accessKeyId = creds.accessKeyId || config.wuying.accessKeyId;
  const accessKeySecret = creds.accessKeySecret || config.wuying.accessKeySecret;
  const region = creds.region || config.wuying.region;
  if (!accessKeyId || !accessKeySecret) throw new Error('aliyun_credentials_missing');

  const all = {
    Action: action,
    Format: 'JSON',
    Version: p.version,
    AccessKeyId: accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    RegionId: region,
    ...params,
  };
  // 去掉空值，避免签名与实际发送不一致
  for (const k of Object.keys(all)) {
    if (all[k] === undefined || all[k] === null || all[k] === '') delete all[k];
  }

  const canonical = Object.keys(all).sort()
    .map((k) => `${pctEncode(k)}=${pctEncode(String(all[k]))}`).join('&');
  const signature = crypto.createHmac('sha1', accessKeySecret + '&')
    .update(`POST&${pctEncode('/')}&${pctEncode(canonical)}`).digest('base64');

  const body = `${canonical}&Signature=${pctEncode(signature)}`;
  const res = await fetch(`https://${p.host(region)}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(creds.timeoutMs || 30000),
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`${action} 返回非 JSON (HTTP ${res.status}): ${text.slice(0, 200)}`); }

  // 阿里云错误响应带 Code + Message（HTTP 状态也非 2xx）
  if (!res.ok || (data.Code && data.Code !== 'Success' && data.Message)) {
    throw new Error(`${action} 失败 [${data.Code || res.status}]: ${data.Message || text.slice(0, 200)}`);
  }
  return data;
}

// 兼容旧调用点：ecd 产品的快捷方式
export const ecdCall = (action, params = {}) => rpcCall('ecd', action, params);
