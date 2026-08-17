// 服务端配置：从环境变量与 .env 读取。真实密钥只存在于部署机的 .env，不进 Git。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv() {
  for (const p of [path.join(ROOT, '.env'), path.resolve(ROOT, '..', '.env')]) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  }
}
loadDotEnv();

const env = (k, d = '') => process.env[k] ?? d;

export const config = {
  port: Number(env('PORT', '8620')),
  publicBaseUrl: env('PUBLIC_BASE_URL', `http://localhost:${env('PORT', '8620')}`),
  dataDir: path.resolve(ROOT, env('DATA_DIR', './data')),
  uploadDir: path.resolve(ROOT, env('UPLOAD_DIR', './uploads')),

  ark: {
    apiKey: env('ARK_API_KEY'),
    baseUrl: env('ARK_BASE_URL', 'https://ark.cn-beijing.volces.com/api/v3'),
    chatModel: env('ARK_CHAT_MODEL', 'doubao-seed-1-6-250615'),
    visionModel: env('ARK_VISION_MODEL', 'doubao-seed-1-6-250615'),
  },
  dashscope: {
    apiKey: env('DASHSCOPE_API_KEY'),
    baseUrl: env('DASHSCOPE_BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1'),
    model: env('DASHSCOPE_MODEL', 'qwen-long'),
  },
  tts: {
    appId: env('VOLC_TTS_APP_ID'),
    accessToken: env('VOLC_TTS_ACCESS_TOKEN'),
    cluster: env('VOLC_TTS_CLUSTER', 'volcano_tts'),
    voice: env('VOLC_TTS_VOICE', 'BV001_streaming'),
    voiceB: env('VOLC_TTS_VOICE_B', 'BV002_streaming'),
  },
  wuying: {
    accessKeyId: env('WUYING_ACCESS_KEY_ID'),
    accessKeySecret: env('WUYING_ACCESS_KEY_SECRET'),
    region: env('WUYING_REGION', 'cn-shenzhen'),
    desktopId: env('WUYING_DESKTOP_ID'),
    officeSiteId: env('WUYING_OFFICE_SITE_ID'),
  },
  cuaAgentToken: env('CUA_AGENT_TOKEN', 'change-me'),
  demoMedia: (() => {
    try { return JSON.parse(env('DEMO_MEDIA_JSON', '[]')); } catch { return []; }
  })(),
};

// mock 模式：没配主脑 Key 就用规则引擎跑通全链路（本地演示/自动化测试用）
export const brainMode = config.ark.apiKey ? 'ark' : (config.dashscope.apiKey ? 'dashscope' : 'mock');
export const ttsMode = config.tts.accessToken ? 'volcano' : 'browser'; // browser = 电视端用 speechSynthesis 兜底

for (const d of [config.dataDir, config.uploadDir]) fs.mkdirSync(d, { recursive: true });
