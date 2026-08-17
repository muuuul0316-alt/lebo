// 私人素材的访问控制（PRD 10.4 安全与隐私）。
// 用户上传的照片、视频、文档属高敏感数据，不能靠"路径难猜"来保护——
// 素材 URL 带 HMAC 签名，未签名或签名不符一律拒绝，杜绝目录枚举与直链外泄。
import crypto from 'node:crypto';
import path from 'node:path';
import { config } from './config.js';

export function signAsset(relPath) {
  return crypto.createHmac('sha256', config.assetSecret).update(relPath).digest('base64url').slice(0, 22);
}

export function assetUrl(relPath) {
  const enc = relPath.split('/').map(encodeURIComponent).join('/');
  return `${config.publicBaseUrl}/uploads/${enc}?s=${signAsset(relPath)}`;
}

// Express 中间件：校验签名 + 阻断可执行内容在同源下渲染
export function guardUploads(req, res, next) {
  const rel = decodeURIComponent(req.path.replace(/^\//, ''));
  if (!rel || rel.includes('..')) return res.status(400).end();

  const sig = req.query.s;
  if (typeof sig !== 'string' || sig.length !== 22) return res.status(403).end();
  const expect = signAsset(rel);
  // 定长比较，避免时序侧信道
  if (sig.length !== expect.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) {
    return res.status(403).end();
  }

  // 上传内容一律不作为 HTML/脚本在本域渲染，避免存储型 XSS 与同源钓鱼页
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; media-src 'self'; img-src 'self'");
  const ext = path.extname(rel).toLowerCase();
  if (!['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.mp4', '.mov', '.webm', '.mkv'].includes(ext)) {
    res.setHeader('Content-Disposition', 'attachment');
  }
  next();
}
