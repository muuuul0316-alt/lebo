// TTS 适配层：火山 TTS（PRD 7.1 选型；注意 Authorization: Bearer; 带分号）。
// 未配置时返回 null，电视端用 speechSynthesis 兜底（浏览器本地中文音色）。
import { randomUUID } from 'node:crypto';
import { config, ttsMode } from '../config.js';
import { log } from '../log.js';

// 讲稿时长估算：中文 ~4.2 字/秒，用于段落推进兜底计时
export function estimateMs(text, estSeconds) {
  const byText = Math.max(6000, Math.round((text || '').length / 4.2 * 1000) + 1200);
  if (estSeconds) return Math.min(byText, estSeconds * 1000 + 3000);
  return byText;
}

// 返回 base64 mp3；失败/未配置返回 null（电视端兜底）
export async function synthesize(text, { voice } = {}) {
  if (ttsMode !== 'volcano' || !text) return null;
  try {
    const body = {
      app: { appid: config.tts.appId, token: 'access_token', cluster: config.tts.cluster },
      user: { uid: 'lebo-longxianao' },
      audio: {
        voice_type: voice === 'B' ? config.tts.voiceB : config.tts.voice,
        encoding: 'mp3', speed_ratio: 1.0, volume_ratio: 1.0, pitch_ratio: 1.0,
      },
      request: { reqid: randomUUID(), text: text.slice(0, 1000), text_type: 'plain', operation: 'query' },
    };
    const res = await fetch('https://openspeech.bytedance.com/api/v1/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer; ${config.tts.accessToken}` }, // 火山特色分号
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const data = await res.json();
    if (data.code !== 3000) { log.warn('tts failed code=', data.code, data.message); return null; }
    return data.data; // base64 mp3
  } catch (e) {
    log.warn('tts error:', e.message);
    return null;
  }
}
