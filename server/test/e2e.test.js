// E2E（mock 模式，不出网）：验证关键流程 F-01/F-02/F-04/F-05。
// 起真实 HTTP+WS 服务，用 ws 客户端模拟电视端与手机端，断言端间协议消息。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

process.env.PORT = '8699';
process.env.PUBLIC_BASE_URL = 'http://localhost:8699';
process.env.DATA_DIR = './data-test';
process.env.UPLOAD_DIR = './uploads-test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://localhost:8699';
let server;

before(async () => {
  ({ server } = await import('../src/index.js'));
  await new Promise((r) => setTimeout(r, 400));
});
after(() => {
  server?.close();
  for (const d of ['data-test', 'uploads-test']) fs.rmSync(path.join(__dirname, '..', d), { recursive: true, force: true });
});

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(b || '{}') }));
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.msgs = [];
    ws.on('message', (b) => ws.msgs.push(JSON.parse(b.toString())));
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
const waitFor = async (ws, pred, ms = 4000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const m = ws.msgs.find(pred);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('timeout waiting for ' + pred.toString());
};

const bindTokenOf = (joinUrl) => new URL(joinUrl).searchParams.get('t');

async function setup() {
  const { json: dev } = await postJson(`${BASE}/api/tv/register`, { name: '测试电视' });
  // 电视端 WS 需持注册下发的 deviceSecret
  const tv = await openWs(`ws://localhost:8699/ws?role=tv&device=${dev.deviceId}&secret=${encodeURIComponent(dev.deviceSecret)}`);
  // 手机凭二维码里的一次性 bindToken 绑定
  const { json: bind } = await postJson(`${BASE}/api/phone/bind`, {
    deviceId: dev.deviceId, bindToken: bindTokenOf(dev.joinUrl), nickname: '测试',
  });
  const phone = await openWs(`ws://localhost:8699/ws?role=phone&session=${bind.sessionId}&user=${bind.userId}`);
  return { dev, tv, phone, bind };
}
const say = (phone, text, extra = {}) => phone.send(JSON.stringify({ type: 'user_input', input: { modality: 'text', text, ...extra } }));

// F-01：扫码 → 连接 → 首条指令有反馈
test('F-01 扫码连接并收到即时反馈（≤1s ack）', async () => {
  const { tv, phone } = await setup();
  assert.ok(await waitFor(tv, (m) => m.type === 'hello'));
  const t0 = Date.now();
  say(phone, '现在几点了');
  const ack = await waitFor(phone, (m) => m.event === 'ack');
  assert.ok(Date.now() - t0 < 1000, '即时反馈应 ≤1s');
  assert.ok(ack.payload.speech, 'ack 必须带口头反馈');
  tv.close(); phone.close();
});

// F-02：看电影 → 本地播放器起播（7.4 铁律：play_local，不走串流）
test('F-02 看电影下发 play_local 到电视', async () => {
  const { tv, phone } = await setup();
  say(phone, '看个大雄兔');
  const cmd = await waitFor(tv, (m) => m.type === 'tv_command' && m.command === 'play_local');
  assert.match(cmd.play.url, /^https?:\/\//);
  assert.ok(cmd.play.title);
  const result = await waitFor(phone, (m) => m.event === 'task_result');
  assert.ok(result.payload.actions.includes('pause'));
  tv.close(); phone.close();
});

// 播放控制不经 CUA，直接 player_ctl
test('F-02b 快进走本地 player_ctl', async () => {
  const { tv, phone } = await setup();
  say(phone, '看个电影');
  await waitFor(tv, (m) => m.command === 'play_local');
  say(phone, '快进十分钟');
  const ctl = await waitFor(tv, (m) => m.command === 'player_ctl');
  assert.equal(ctl.ctl.op, 'seek_forward');
  assert.equal(ctl.ctl.seconds, 600);
  tv.close(); phone.close();
});

// F-04：上传内容 → 解析完成 → 你来讲 → 讲解屏 + 段落进度
test('F-04 上传解析并开始讲解（边讲边展示）', async () => {
  const { tv, phone, bind } = await setup();
  // 造一个文本素材直接上传
  const boundary = '----lebotest';
  const filePart = (name, content) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n`;
  const body = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="sessionId"\r\n\r\n${bind.sessionId}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="userId"\r\n\r\n${bind.userId}\r\n` +
    filePart('方案.txt', '电视 OS 被厂商锁死是根本问题。\n\n云桌面是唯一能脱离电视系统的路径。\n\n第一阶段先在 APK 内验证核心链路。') +
    `--${boundary}--\r\n`, 'utf8');
  await new Promise((resolve, reject) => {
    const req = http.request(`${BASE}/api/content/upload`, { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length } }, (res) => { res.on('data', () => {}); res.on('end', resolve); });
    req.on('error', reject); req.write(body); req.end();
  });
  const done = await waitFor(phone, (m) => m.event === 'ingest_done', 8000);
  assert.match(done.payload.speech, /已学完/);
  assert.ok(done.payload.sections >= 1);

  say(phone, '你来讲');
  const render = await waitFor(tv, (m) => m.type === 'tv_command' && m.command === 'render' && m.presenting, 6000);
  assert.ok(render.presenting.total >= 1);
  const presenting = await waitFor(phone, (m) => m.event === 'presenting');
  assert.ok(presenting.payload.point);
  tv.close(); phone.close();
});

// F-05：讲解中打断提问 → 静音 + 证据（包内命中）
test('F-05 讲解中打断提问，包内证据展示', async () => {
  const { tv, phone, bind } = await setup();
  const boundary = '----lebotest2';
  const body = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="sessionId"\r\n\r\n${bind.sessionId}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="userId"\r\n\r\n${bind.userId}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="数据.txt"\r\nContent-Type: text/plain\r\n\r\n数据来源：2026 年 APK 有 60 万日活用户，200 万月活。这些数据由数据侧统计口径给出。\r\n` +
    `--${boundary}--\r\n`, 'utf8');
  await new Promise((resolve, reject) => {
    const req = http.request(`${BASE}/api/content/upload`, { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length } }, (res) => { res.on('data', () => {}); res.on('end', resolve); });
    req.on('error', reject); req.write(body); req.end();
  });
  await waitFor(phone, (m) => m.event === 'ingest_done', 8000);
  say(phone, '你来讲');
  await waitFor(phone, (m) => m.event === 'presenting');

  // 打断提问
  const t0 = Date.now();
  say(phone, '这个数据哪来的', { is_interrupt: true });
  const mute = await waitFor(tv, (m) => m.type === 'tv_command' && m.command === 'overlay' && m.ctl?.op === 'mute_tts', 2000);
  assert.ok(Date.now() - t0 < 800, '打断静音应快速');
  const ans = await waitFor(phone, (m) => m.event === 'answer', 6000);
  assert.ok(ans.payload.speech);
  assert.ok(ans.payload.source_label, '证据必标来源（D-04）');
  tv.close(); phone.close();
});

// 断线重连：电视端重连恢复最后一条画面（协议幂等）
test('电视端重连恢复最后画面', async () => {
  const { dev, tv, phone } = await setup();
  say(phone, '看个电影');
  await waitFor(tv, (m) => m.command === 'play_local');
  tv.close();
  await new Promise((r) => setTimeout(r, 100));
  const tv2 = await openWs(`ws://localhost:8699/ws?role=tv&device=${dev.deviceId}&secret=${encodeURIComponent(dev.deviceSecret)}`);
  const restored = await waitFor(tv2, (m) => m.type === 'tv_command' && m.command === 'play_local', 2000);
  assert.ok(restored.play.url);
  tv2.close(); phone.close();
});

// 讲解中必须叫得停（原本"停"被当成提问，用户喊破喉咙也停不下来）
test('讲解中说「停」立刻停止讲解', async () => {
  const { tv, phone, bind } = await setup();
  const boundary = '----lebostop';
  const body = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="sessionId"\r\n\r\n${bind.sessionId}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="userId"\r\n\r\n${bind.userId}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="讲稿.txt"\r\nContent-Type: text/plain\r\n\r\n第一段内容。\n\n第二段内容。\n\n第三段内容。\r\n` +
    `--${boundary}--\r\n`, 'utf8');
  await new Promise((resolve, reject) => {
    const req = http.request(`${BASE}/api/content/upload`, { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length } }, (res) => { res.on('data', () => {}); res.on('end', resolve); });
    req.on('error', reject); req.write(body); req.end();
  });
  await waitFor(phone, (m) => m.event === 'ingest_done', 8000);
  say(phone, '你来讲');
  await waitFor(phone, (m) => m.event === 'presenting', 6000);

  // 带标点的「停。」也必须生效（火山 ASR 默认返回带标点文本）
  say(phone, '停。');
  const done = await waitFor(phone, (m) => m.event === 'present_done', 3000);
  assert.ok(done, '说“停”后必须结束讲解');
  const muted = await waitFor(tv, (m) => m.command === 'overlay' && m.ctl?.op === 'mute_tts', 2000);
  assert.ok(muted, '必须先静音');
  tv.close(); phone.close();
});

// 起播失败必须回传手机，不能电视黑屏而手机说"开始了"
test('起播失败时手机收到明确告知', async () => {
  const { tv, phone } = await setup();
  say(phone, '看个电影');
  await waitFor(tv, (m) => m.command === 'play_local');
  tv.send(JSON.stringify({ type: 'play_event', event: 'play_fail', reason: 'NotAllowedError' }));
  const err = await waitFor(phone, (m) => m.event === 'error' && /没放起来/.test(m.payload?.speech || ''), 3000);
  assert.ok(err.payload.actions.includes('next_one'), '应提供换一个的出路');
  tv.close(); phone.close();
});

// ---- 安全回归：鉴权必须真的拦得住 ----
test('安全：伪造 bindToken 无法绑定他人电视', async () => {
  const { json: dev } = await postJson(`${BASE}/api/tv/register`, { name: '别人家的电视' });
  const bad = await postJson(`${BASE}/api/phone/bind`, {
    deviceId: dev.deviceId, bindToken: 'forged-token-aaaaaaaaaaaaaaaaaaa', nickname: '入侵者',
  });
  assert.equal(bad.status, 401, '伪造 token 必须被拒');
  assert.equal(bad.json.error, 'bind_token_invalid');
});

test('安全：无 deviceSecret 无法冒充电视接管画面', async () => {
  const { json: dev } = await postJson(`${BASE}/api/tv/register`, { name: '别人家的电视' });
  const ws = new WebSocket(`ws://localhost:8699/ws?role=tv&device=${dev.deviceId}`); // 不带 secret
  const code = await new Promise((resolve) => {
    ws.on('close', (c) => resolve(c));
    ws.on('error', () => {});
  });
  assert.ok(code === 4003 || code === 4004, `应被拒绝，实际 close code=${code}`);
});

test('安全：私人素材未签名不可直链访问', async () => {
  const res = await new Promise((resolve) => {
    http.get(`${BASE}/uploads/some/private.jpg`, (r) => { r.resume(); resolve(r.statusCode); });
  });
  assert.equal(res, 403, '未签名的素材直链必须 403');
});
