// 验收探针：模拟真实用户路径，观察实际得到什么
process.env.PORT = '8711';
process.env.PUBLIC_BASE_URL = 'http://localhost:8711';
process.env.DATA_DIR = './data-probe';
process.env.UPLOAD_DIR = './uploads-probe';

import http from 'node:http';
import { WebSocket } from 'ws';

const BASE = 'http://localhost:8711';
await import('/home/user/lebo/server/src/index.js');
await new Promise((r) => setTimeout(r, 500));

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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (p, text, extra = {}) => p.send(JSON.stringify({ type: 'user_input', input: { modality: 'text', text, ...extra } }));

async function setup(withTv = true) {
  const { json: dev } = await postJson(`${BASE}/api/tv/register`, { name: '客厅的电视' });
  let tv = null;
  if (withTv) tv = await openWs(`ws://localhost:8711/ws?role=tv&device=${dev.deviceId}`);
  const { json: bind } = await postJson(`${BASE}/api/phone/bind`, { deviceId: dev.deviceId, castCode: dev.castCode, nickname: '爸爸' });
  const phone = await openWs(`ws://localhost:8711/ws?role=phone&session=${bind.sessionId}&user=${bind.userId}`);
  return { dev, tv, phone, bind };
}
function dump(tag, ws) {
  console.log(`\n--- ${tag} ---`);
  for (const m of ws.msgs) {
    if (m.type === 'pong' || m.type === 'hello') continue;
    console.log(JSON.stringify(m).slice(0, 400));
  }
}

// ============ A. 电视没连时手机发指令 ============
console.log('\n\n########## A. 电视浏览器没打开/断线时，手机说「看个电影」 ##########');
{
  const { phone } = await setup(false); // TV 从未连 WS
  say(phone, '看个电影');
  await wait(1200);
  dump('手机收到', phone);
  phone.close();
}

// ============ B. 「看个电影」的片名匹配 ============
console.log('\n\n########## B. 泛指「看个电影」的文案 ##########');
{
  const { tv, phone } = await setup();
  say(phone, '看个电影');
  await wait(1000);
  dump('手机收到', phone);
  dump('电视收到', tv);
  tv.close(); phone.close();
}

// ============ C. 手机端「按住说话」在讲解中发出的真实打断消息 ============
console.log('\n\n########## C. 讲解中按住说话按钮（phone/m.js startTalk 真实发出的消息） ##########');
{
  const { tv, phone, bind } = await setup();
  const boundary = '----probe';
  const body = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="sessionId"\r\n\r\n${bind.sessionId}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="userId"\r\n\r\n${bind.userId}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="材料.txt"\r\nContent-Type: text/plain\r\n\r\n第一段内容讲的是背景。\n\n第二段讲方案。\n\n第三段讲数据，2026年60万日活。\r\n` +
    `--${boundary}--\r\n`, 'utf8');
  await new Promise((resolve, reject) => {
    const req = http.request(`${BASE}/api/content/upload`, { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length } }, (res) => { res.on('data', () => {}); res.on('end', resolve); });
    req.on('error', reject); req.write(body); req.end();
  });
  await wait(1500);
  say(phone, '你来讲');
  await wait(800);
  tv.msgs.length = 0;
  // 这是 phone/m.js startTalk() 真实发出的第一条消息
  const t0 = Date.now();
  phone.send(JSON.stringify({ type: 'user_input', input: { modality: 'voice', is_interrupt: true, asr_text: '' } }));
  await wait(1000);
  const mute = tv.msgs.find((m) => m.command === 'overlay' && m.ctl?.op === 'mute_tts');
  console.log('按下说话键后 1s 内电视是否收到静音指令:', mute ? `是 (${Date.now() - t0}ms)` : '否 —— 电视继续讲');
  dump('电视收到（按下说话键后）', tv);
  tv.close(); phone.close();
}

// ============ D. mock 模式讲稿质量 + 多页截断 ============
console.log('\n\n########## D. 上传一份 12 段的材料，看 mock 备课产出 ##########');
{
  const { tv, phone, bind } = await setup();
  const paras = Array.from({ length: 12 }, (_, i) => `第${i + 1}章标题行。\n这是第${i + 1}章的正文，讲了要点甲、要点乙和要点丙。还有第二句补充说明。`).join('\n\n');
  const boundary = '----probe2';
  const body = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="sessionId"\r\n\r\n${bind.sessionId}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="年度汇报.txt"\r\nContent-Type: text/plain\r\n\r\n${paras}\r\n` +
    `--${boundary}--\r\n`, 'utf8');
  await new Promise((resolve, reject) => {
    const req = http.request(`${BASE}/api/content/upload`, { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': Buffer.byteLength(body) } }, (res) => { res.on('data', () => {}); res.on('end', resolve); });
    req.on('error', reject); req.write(body); req.end();
  });
  await wait(2000);
  const done = phone.msgs.find((m) => m.event === 'ingest_done');
  console.log('ingest_done:', JSON.stringify(done?.payload).slice(0, 300));
  const { getPackage } = await import('/home/user/lebo/server/src/content/ingest.js');
  const pkgId = done.payload.packageId;
  const pkg = getPackage(pkgId);
  console.log(`素材单元数: ${pkg.assets.length}`);
  console.log(`讲解段落数: ${pkg.skill.outline.length}`);
  console.log('\n>>> 实际讲稿全文（电视会念出来的内容）:');
  for (const o of pkg.skill.outline) {
    console.log(`  [第${o.section}段] 标题: ${o.point}`);
    console.log(`             讲稿: ${o.narration}`);
  }
  tv.close(); phone.close();
}

// ============ E. 讲解中用户离开（关手机页），讲解是否继续/能否停 ============
console.log('\n\n########## E. 超大文件上传（超 multer 限制）时手机看到什么 ##########');
{
  const { phone, bind } = await setup();
  const big = Buffer.alloc(1024 * 1024, 65); // 只做小样本，见下方对 multer 限制的说明
  const boundary = '----probe3';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="sessionId"\r\n\r\n${bind.sessionId}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="x.txt"\r\nContent-Type: text/plain\r\n\r\n`, 'utf8');
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const body = Buffer.concat([head, big, tail]);
  const resp = await new Promise((resolve, reject) => {
    const req = http.request(`${BASE}/api/content/upload`, { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b.slice(0, 200) }));
    });
    req.on('error', reject); req.write(body); req.end();
  });
  console.log('1MB 上传响应:', resp.status, resp.body.slice(0, 120));
  phone.close();
}

// ============ F. 未绑定 session（服务重启后手机重连） ============
console.log('\n\n########## F. 服务重启后手机 WS 重连（sessionId 已失效） ##########');
{
  const ws = new WebSocket('ws://localhost:8711/ws?role=phone&session=sess_dead&user=u_dead');
  const closed = await new Promise((r) => { ws.on('close', (code, reason) => r({ code, reason: reason.toString() })); ws.on('error', () => {}); });
  console.log('服务端关闭 WS:', closed, '→ 手机端 m.js onclose 只会无限重连，UI 无任何提示');
}

process.exit(0);
