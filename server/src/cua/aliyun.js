// 阿里云 OpenAPI RPC 客户端（纯 Node 实现 HMAC-SHA1 签名，不引 SDK）。
// 用于无影云电脑 EDS（ecd, 2020-09-30）：查询/启停云桌面、下发命令、取串流 Ticket。
import crypto from 'node:crypto';
import { config } from '../config.js';

const pctEncode = (s) => encodeURIComponent(s)
  .replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~');

export async function ecdCall(action, params = {}) {
  const { accessKeyId, accessKeySecret, region } = config.wuying;
  if (!accessKeyId) throw new Error('wuying_not_configured');
  const common = {
    Action: action,
    Format: 'JSON',
    Version: '2020-09-30',
    AccessKeyId: accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    RegionId: region,
    ...params,
  };
  const sorted = Object.keys(common).sort();
  const canonical = sorted.map((k) => `${pctEncode(k)}=${pctEncode(String(common[k]))}`).join('&');
  const strToSign = `GET&%2F&${pctEncode(canonical)}`;
  const signature = crypto.createHmac('sha1', accessKeySecret + '&').update(strToSign).digest('base64');
  const qs = `${canonical}&Signature=${pctEncode(signature)}`;
  const url = `https://ecd.${region}.aliyuncs.com/?${qs}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const data = await res.json();
  if (data.Code && data.Code !== 'Success') throw new Error(`ecd_${action}_${data.Code}: ${data.Message || ''}`);
  return data;
}
