// 会话与设备管理：电视注册 → 二维码 → 手机扫码绑定 → 多人控制权（PRD 6.3.4）。
// 电视端状态由云端会话状态机决定（唯一真相源，PRD 6.7.4），断线重连按云端状态恢复。
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { config } from './config.js';
import { uid } from './store.js';
import { track } from './metrics.js';
import { log } from './log.js';

const devices = new Map(); // deviceId -> device
const sessions = new Map(); // sessionId -> session

function castCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

const secret = () => crypto.randomBytes(24).toString('base64url');

// 投屏码只有 6 位，可被暴力枚举；绑定必须凭二维码里的一次性 bindToken。
// 投屏码保留仅用于人工报码的兜底场景，并施加尝试频率限制。
const BIND_TOKEN_TTL = 10 * 60 * 1000;
const codeAttempts = new Map(); // ip -> {count, resetAt}

export function rateLimitCode(ip) {
  const now = Date.now();
  let r = codeAttempts.get(ip);
  if (!r || now > r.resetAt) { r = { count: 0, resetAt: now + 10 * 60 * 1000 }; codeAttempts.set(ip, r); }
  r.count++;
  return r.count <= 10; // 10 分钟内最多 10 次凭码绑定尝试
}

// 电视端注册：deviceSecret 只在注册响应里下发一次，电视端本地保存，用于 WS 鉴权。
// 已注册设备再次调用需带上原 deviceSecret，防止他人凭 deviceId 重置设备。
export async function registerDevice({ deviceId, name, deviceSecret }) {
  let dev = deviceId && devices.get(deviceId);
  if (dev && dev.deviceSecret !== deviceSecret) {
    // 设备存在但密钥不符：视为新设备，不允许劫持既有设备
    dev = null;
    deviceId = null;
  }
  if (!dev) {
    dev = {
      deviceId: uid('tv'),
      deviceSecret: secret(),
      name: name || '客厅的电视',
      castCode: castCode(),
      tvSocket: null,
      lastTvCommand: null, // 幂等重放：重连恢复画面
      sessionId: null,
      screen: 'S0',
    };
    devices.set(dev.deviceId, dev);
  }
  dev.name = name || dev.name;
  // 一次性绑定令牌：二维码每次刷新即轮换，扫码绑定后作废（E-01 码刷新）
  dev.bindToken = secret();
  dev.bindTokenExp = Date.now() + BIND_TOKEN_TTL;

  const joinUrl = `${config.publicBaseUrl}/m/?d=${encodeURIComponent(dev.deviceId)}&t=${dev.bindToken}`;
  const qrDataUrl = await QRCode.toDataURL(joinUrl, { margin: 1, scale: 8 });
  track('entry', 'qr_issued', { deviceId: dev.deviceId });
  return {
    deviceId: dev.deviceId, deviceSecret: dev.deviceSecret, name: dev.name,
    castCode: dev.castCode, joinUrl, qrDataUrl, bindTokenExpiresIn: BIND_TOKEN_TTL,
  };
}

export function getDevice(deviceId) { return devices.get(deviceId); }

export function findDeviceByCastCode(code) {
  for (const d of devices.values()) if (d.castCode === String(code)) return d;
  return null;
}

// 手机扫码绑定：优先凭二维码里的一次性 bindToken；无 token 时才回退到投屏码（受频率限制）。
export function bindPhone({ deviceId, bindToken, castCode: code, nickname, ip }) {
  let dev = null;
  if (bindToken) {
    const d = devices.get(deviceId);
    if (d && d.bindToken && d.bindToken === bindToken && Date.now() < d.bindTokenExp) dev = d;
    else return { error: 'bind_token_invalid' }; // 过期/伪造：让电视刷新二维码重扫
  } else if (code) {
    if (ip && !rateLimitCode(ip)) return { error: 'too_many_attempts' };
    dev = findDeviceByCastCode(code);
  }
  if (!dev) return { error: 'device_not_found' };
  let sess = dev.sessionId && sessions.get(dev.sessionId);
  if (!sess) {
    sess = {
      sessionId: uid('sess'),
      deviceId: dev.deviceId,
      users: new Map(), // userId -> {nickname, socket}
      controllerId: null, // 最后一个发起有效指令的人（6.3.4）
      presenterId: null, // 讲解中主讲人优先
      packageIds: [],
      activeTask: null,
      present: null, // 讲解会话（present/engine）
      createdAt: Date.now(),
    };
    sessions.set(sess.sessionId, sess);
    dev.sessionId = sess.sessionId;
  }
  const userId = uid('u');
  sess.users.set(userId, { userId, nickname: nickname || '手机用户', socket: null });
  track('entry', 'scan_bind', { deviceId: dev.deviceId, sessionId: sess.sessionId, userId });
  log.info('phone bound', dev.deviceId, userId);
  return { sessionId: sess.sessionId, userId, deviceId: dev.deviceId, deviceName: dev.name };
}

export function getSession(sessionId) { return sessions.get(sessionId); }

export function sessionOfDevice(deviceId) {
  const dev = devices.get(deviceId);
  return dev?.sessionId ? sessions.get(dev.sessionId) : null;
}

// 控制权：最后一个发起有效指令的人持有；讲解中主讲人优先（PRD 6.3.4）
export function takeControl(sess, userId) {
  if (sess.present && sess.present.state === 'PRESENTING' && sess.presenterId && sess.presenterId !== userId) {
    return false; // 讲解中他人只能提问，不能抢走讲解流程控制权
  }
  sess.controllerId = userId;
  return true;
}

// ---- 消息下发 ----
// 断线重连恢复画面时，只回放"定义屏幕状态"的指令；overlay(TTS/静音) 是瞬时叠加层，不作为恢复点。
const SCREEN_COMMANDS = new Set(['render', 'play_local', 'stream_desktop', 'reset']);
export function sendToTv(dev, cmd) {
  if (SCREEN_COMMANDS.has(cmd.command)) dev.lastTvCommand = cmd;
  if (dev.tvSocket && dev.tvSocket.readyState === 1) dev.tvSocket.send(JSON.stringify(cmd));
}

export function sendToUser(sess, userId, msg) {
  const u = sess.users.get(userId);
  if (u?.socket && u.socket.readyState === 1) u.socket.send(JSON.stringify(msg));
}

export function broadcastUsers(sess, msg) {
  for (const u of sess.users.values())
    if (u.socket && u.socket.readyState === 1) u.socket.send(JSON.stringify(msg));
}

// 电视端 WS 接入必须持注册时下发的 deviceSecret，防止凭 deviceId 顶替真电视
export function attachTvSocket(deviceId, socket, deviceSecret) {
  const dev = devices.get(deviceId);
  if (!dev) return null;
  if (dev.deviceSecret !== deviceSecret) return { error: 'bad_secret' };
  dev.tvSocket = socket;
  // 断线重连：用最后一条 tv_command 恢复画面（协议幂等性要求）
  if (dev.lastTvCommand) socket.send(JSON.stringify(dev.lastTvCommand));
  return dev;
}

export function attachUserSocket(sessionId, userId, socket) {
  const sess = sessions.get(sessionId);
  const u = sess?.users.get(userId);
  if (!u) return null;
  u.socket = socket;
  return sess;
}
