// 会话与设备管理：电视注册 → 二维码 → 手机扫码绑定 → 多人控制权（PRD 6.3.4）。
// 电视端状态由云端会话状态机决定（唯一真相源，PRD 6.7.4），断线重连按云端状态恢复。
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

export async function registerDevice({ deviceId, name }) {
  let dev = deviceId && devices.get(deviceId);
  if (!dev) {
    dev = {
      deviceId: deviceId || uid('tv'),
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
  const joinUrl = `${config.publicBaseUrl}/m/?d=${encodeURIComponent(dev.deviceId)}&c=${dev.castCode}`;
  const qrDataUrl = await QRCode.toDataURL(joinUrl, { margin: 1, scale: 8 });
  track('entry', 'qr_issued', { deviceId: dev.deviceId });
  return { deviceId: dev.deviceId, name: dev.name, castCode: dev.castCode, joinUrl, qrDataUrl };
}

export function getDevice(deviceId) { return devices.get(deviceId); }

export function findDeviceByCastCode(code) {
  for (const d of devices.values()) if (d.castCode === String(code)) return d;
  return null;
}

// 手机扫码绑定：无注册流程，身份即昵称（H5 版；小程序版换 openid）
export function bindPhone({ deviceId, castCode: code, nickname }) {
  const dev = devices.get(deviceId) || findDeviceByCastCode(code);
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

export function attachTvSocket(deviceId, socket) {
  const dev = devices.get(deviceId);
  if (!dev) return null;
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
