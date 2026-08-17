// ASR 适配层：火山一句话流式识别（openspeech /api/v1/asr）。
// H5 端优先用浏览器 SpeechRecognition 实时回显；不支持的浏览器录音上传走这里。
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { log } from '../log.js';

export function asrAvailable() { return !!config.tts.accessToken; } // 与 TTS 同一套凭证

// audioBuffer: Buffer；format: 'mp3'|'wav'|'ogg'（H5 MediaRecorder 常见 webm/ogg-opus）
export async function recognize(audioBuffer, format = 'mp3') {
  if (!asrAvailable()) return { ok: false, reason: 'asr_not_configured' };
  try {
    const body = {
      app: { appid: config.tts.appId, token: config.tts.accessToken, cluster: 'volcengine_streaming_common' },
      user: { uid: 'lebo-longxianao' },
      audio: { format, data: audioBuffer.toString('base64'), language: 'zh-CN' },
      request: {
        reqid: randomUUID(), sequence: -1, nbest: 1,
        workflow: 'audio_in,resample,partition,vad,fe,decode',
        result_type: 'full', show_utterances: 'true',
      },
    };
    const res = await fetch('https://openspeech.bytedance.com/api/v1/asr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer; ${config.tts.accessToken}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const data = await res.json();
    if (data.code !== 1000) { log.warn('asr failed code=', data.code); return { ok: false, reason: `asr_code_${data.code}` }; }
    return { ok: true, text: data.result?.[0]?.text || '' };
  } catch (e) {
    log.warn('asr error:', e.message);
    return { ok: false, reason: e.message };
  }
}
