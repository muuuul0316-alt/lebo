// 乐播·龙虾脑 服务端入口。
// HTTP：设备注册/二维码、扫码绑定、内容上传、静态资源（电视端 + 手机 H5）。
// WS：/ws 三端实时通道。
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import { config, brainMode, ttsMode } from './config.js';
import { log } from './log.js';
import { attachGateway } from './gateway.js';
import { registerDevice, bindPhone, getSession, getDevice } from './sessions.js';
import { ingest } from './content/ingest.js';
import { recognize, asrAvailable } from './speech/asr.js';
import * as wuying from './cua/wuying.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(ROOT, '..');
const app = express();
app.use(express.json({ limit: '2mb' }));

// ---- 静态资源 ----
app.use('/uploads', express.static(config.uploadDir, { maxAge: '1h' }));
app.use('/tv', express.static(path.join(REPO, 'tv')));
app.use('/m', express.static(path.join(REPO, 'phone')));

app.get('/favicon.ico', (_req, res) => res.status(204).end());

// 健康检查（部署探活）
app.get('/health', (_req, res) => res.json({
  ok: true, brainMode, ttsMode, asr: asrAvailable(), cua: wuying.available(), ts: Date.now(),
}));

// ---- 电视端：注册并取二维码（TV-01） ----
app.post('/api/tv/register', async (req, res) => {
  try {
    const info = await registerDevice({ deviceId: req.body.deviceId, name: req.body.name });
    res.json(info);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- 手机 H5：扫码绑定（MP-01；H5 版无需微信授权，用户已确认第一版用 H5） ----
app.post('/api/phone/bind', (req, res) => {
  const out = bindPhone({ deviceId: req.body.deviceId, castCode: req.body.castCode, nickname: req.body.nickname });
  if (out.error) return res.status(404).json(out);
  res.json(out);
});

// ---- 内容上传（MP-05 / LB-08）：多文件 + VIP 包 ----
const upload = multer({ dest: config.uploadDir, limits: { fileSize: 600 * 1024 * 1024, files: 50 } });
app.post('/api/content/upload', upload.array('files', 50), async (req, res) => {
  const sess = getSession(req.body.sessionId);
  if (!sess) return res.status(404).json({ error: 'session_not_found' });
  if (!req.files?.length) return res.status(400).json({ error: 'no_files' });
  res.json({ ok: true, accepted: req.files.length }); // 立即回执，解析异步推进（进度走 WS）
  ingest(sess, req.body.userId, req.files).catch((e) => log.error('ingest error', e.message));
});

// ---- 文字输入（MP-05 文字入口 / 无麦场景） ----
// 走 WS user_input 即可；此处仅保留 ASR 上传兜底

// ---- ASR 兜底：H5 录音上传（浏览器不支持 SpeechRecognition 时） ----
app.post('/api/asr', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_audio' });
  const fmt = (req.body.format || 'mp3').toLowerCase();
  const buf = fs.readFileSync(req.file.path);
  const out = await recognize(buf, fmt);
  fs.unlink(req.file.path, () => {});
  res.json(out);
});

// ---- 云桌面状态（运维/联调用） ----
app.get('/api/cua/status', async (_req, res) => {
  if (!wuying.available()) return res.json({ configured: false });
  try { res.json({ configured: true, desktop: await wuying.desktopStatus() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 根路径：引导页
app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html><html lang="zh"><meta charset="utf8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>乐播·龙虾脑</title>
<body style="font-family:system-ui;background:#0b1020;color:#eaf0ff;display:grid;place-items:center;height:100vh;margin:0;text-align:center">
<div><h1>乐播 · 龙虾脑</h1>
<p>扫一个码，承载一切</p>
<p style="opacity:.7">电视端 → <a style="color:#6cf" href="/tv/">/tv/</a>　手机端 → <a style="color:#6cf" href="/m/">/m/</a></p>
<p style="opacity:.5;font-size:13px">主脑：${brainMode} · 语音：${ttsMode} · 云桌面：${wuying.available() ? '已接' : '未接'}</p>
</div></body></html>`);
});

const server = http.createServer(app);
attachGateway(server);
server.listen(config.port, () => {
  log.info(`乐播·龙虾脑 服务端启动 :${config.port}  brain=${brainMode} tts=${ttsMode} cua=${wuying.available()}`);
  log.info(`电视端 ${config.publicBaseUrl}/tv/   手机端 ${config.publicBaseUrl}/m/`);
});

export { app, server };
