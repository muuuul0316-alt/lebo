// WebSocket 网关：电视端与手机端(H5)的实时通道。
// 手机 → 云端：user_input（PRD 6.9.1）；云端 → 手机/电视：agent_event / tv_command。
import { WebSocketServer } from 'ws';
import { URL } from 'node:url';
import { attachTvSocket, attachUserSocket, getSession } from './sessions.js';
import { handleUserText, confirmOutline } from './brain/executor.js';
import * as present from './present/engine.js';
import { registerCuaAgent } from './cua/agentLoop.js';
import { config } from './config.js';
import { track } from './metrics.js';
import { log } from './log.js';

export function attachGateway(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (socket, req) => {
    const params = new URL(req.url, 'http://x').searchParams;
    const role = params.get('role');

    if (role === 'tv') {
      const dev = attachTvSocket(params.get('device'), socket, params.get('secret'));
      // 4004 设备不存在（服务重启后内存态丢失）→ 电视端须重新注册，不能只重连
      if (!dev) return socket.close(4004, 'device_not_found');
      if (dev.error) return socket.close(4003, 'bad_secret');
      log.info('tv connected', dev.deviceId);
      socket.on('message', (buf) => onTvMessage(dev, buf));
      socket.on('close', () => { if (dev.tvSocket === socket) dev.tvSocket = null; });
      socket.send(JSON.stringify({ type: 'hello', role: 'tv', deviceId: dev.deviceId }));
      return;
    }

    if (role === 'cua') {
      // 云桌面内 cua-agent 回连（PRD 6.15）。共享令牌校验，防止未授权接入。
      if (params.get('token') !== config.cuaAgentToken) return socket.close(4003, 'bad_token');
      const desktop = params.get('desktop');
      registerCuaAgent(desktop, socket);
      log.info('cua-agent connected', desktop);
      socket.send(JSON.stringify({ type: 'hello', role: 'cua', desktop }));
      return;
    }

    if (role === 'phone') {
      const sessionId = params.get('session');
      const userId = params.get('user');
      const sess = attachUserSocket(sessionId, userId, socket);
      if (!sess) return socket.close(4004, 'session_not_found');
      log.info('phone connected', sessionId, userId);
      socket.on('message', (buf) => onPhoneMessage(sess, userId, buf));
      socket.on('close', () => { const u = sess.users.get(userId); if (u && u.socket === socket) u.socket = null; });
      socket.send(JSON.stringify({ type: 'hello', role: 'phone', sessionId, userId }));
      return;
    }

    socket.close(4000, 'bad_role');
  });

  log.info('ws gateway on /ws');
  return wss;
}

async function onPhoneMessage(sess, userId, buf) {
  let msg;
  try { msg = JSON.parse(buf.toString()); } catch { return; }
  try {
    switch (msg.type) {
      case 'user_input': {
        // 语音/文字/文件统一入口（6.9.1）
        const text = (msg.input?.asr_text || msg.input?.text || '').trim();
        const isInterrupt = !!msg.input?.is_interrupt;
        // 用户一按住说话就先发一个空文本的打断包：必须立刻静音（D-03 ≤500ms），
        // 不能因为"还没识别出文字"就把它丢掉——那样打断永远不会生效。
        if (!text) {
          if (isInterrupt) present.interrupt(sess);
          return;
        }
        await handleUserText(sess, userId, text, { isInterrupt });
        break;
      }
      case 'confirm_outline': // 大纲闸门确认（5.6.1 ③）
        await confirmOutline(sess, userId);
        break;
      case 'present_control': // 讲解控制条按钮（P2-c）
        await present.control(sess, userId, msg.op);
        break;
      case 'ping':
        sess.users.get(userId)?.socket?.send(JSON.stringify({ type: 'pong' }));
        break;
      default:
        log.warn('unknown phone msg', msg.type);
    }
  } catch (e) {
    log.error('phone msg error', e.message);
  }
}

function onTvMessage(dev, buf) {
  let msg;
  try { msg = JSON.parse(buf.toString()); } catch { return; }
  const sess = dev.sessionId && getSession(dev.sessionId);
  switch (msg.type) {
    case 'tts_done': // 电视端播完一段讲解 → 推进段落（比估时更准）
      if (sess) present.onTtsDone(sess, msg.epoch);
      break;
    case 'screen_changed':
      dev.screen = msg.screen;
      break;
    case 'play_event': // 起播成功/失败/结束
      track('play', msg.event, { deviceId: dev.deviceId });
      break;
    case 'ping':
      dev.tvSocket?.send(JSON.stringify({ type: 'pong' }));
      break;
    default:
      break;
  }
}
