// 无影云桌面适配层（PRD 5.4 云桌面 CUA 控制）。
// 职责：实例生命周期（7.5 调度）、PowerShell 命令下发（部署/驱动 cua-agent）、串流 Ticket。
// CUA 决策循环（截屏→模型判读→动作，6.15.1）由 agentLoop.js 驱动云桌面内的 cua-agent 完成。
import { config } from '../config.js';
import { ecdCall } from './aliyun.js';
import { track, trackCost } from '../metrics.js';
import { log } from '../log.js';
import { agentEvent, tvCommand } from '../protocol.js';
import { getDevice, sendToTv, broadcastUsers } from '../sessions.js';

export function available() {
  return !!(config.wuying.accessKeyId && config.wuying.desktopId);
}

export async function desktopStatus() {
  const data = await ecdCall('DescribeDesktops', { 'DesktopId.1': config.wuying.desktopId });
  const d = data.Desktops?.[0];
  return d ? { id: d.DesktopId, status: d.DesktopStatus, name: d.DesktopName } : null;
}

export async function ensureRunning() {
  const st = await desktopStatus();
  if (!st) throw new Error('desktop_not_found');
  if (st.status === 'Running') return st;
  if (st.status === 'Stopped') {
    await ecdCall('StartDesktops', { 'DesktopId.1': config.wuying.desktopId });
    track('cua', 'desktop_start', {});
    // 冷启动 ≤8s 是产品目标（10.1）；API 层轮询到 Running
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 4000));
      const s = await desktopStatus();
      if (s.status === 'Running') return s;
    }
    throw new Error('desktop_start_timeout');
  }
  return st;
}

// 在云桌面内执行 PowerShell（部署 cua-agent、取产物、应急操作）
export async function runPowerShell(script, { timeoutS = 120 } = {}) {
  const data = await ecdCall('RunCommand', {
    'DesktopId.1': config.wuying.desktopId,
    Type: 'RunPowerShellScript',
    CommandContent: Buffer.from(script, 'utf8').toString('base64'),
    ContentEncoding: 'Base64',
    Timeout: timeoutS,
  });
  const invokeId = data.InvokeId;
  for (let i = 0; i < Math.ceil(timeoutS / 3); i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const q = await ecdCall('DescribeInvocations', { InvokeId: invokeId, IncludeOutput: true });
    const inv = q.Invocations?.[0];
    const task = inv?.InvokeDesktops?.[0];
    if (task && ['Success', 'Failed', 'Stopped', 'Timeout'].includes(task.InvocationStatus)) {
      const output = task.Output ? Buffer.from(task.Output, 'base64').toString('utf8') : '';
      return { status: task.InvocationStatus, output };
    }
  }
  return { status: 'Timeout', output: '' };
}

// 串流 Ticket：电视端接入无影 Web SDK 拉流用（TV-02）。
// 说明：GetConnectionTicket 需要终端用户凭证体系配合，正式接入按无影 Web SDK 文档联调。
export async function getConnectionTicket(endUserId) {
  return ecdCall('GetConnectionTicket', {
    DesktopId: config.wuying.desktopId,
    EndUserId: endUserId,
  });
}

// ---- 内容生产（5.6.1 ④ 云桌面制作）：PowerShell + PowerPoint COM 自动化逐页生成 ----
// 电视端同时切到云桌面串流位（过程可见：一屋子人看着它一页页做出来）
export async function makePptxOnDesktop(sess, userId, outline) {
  const dev = getDevice(sess.deviceId);
  const t0 = Date.now();
  broadcastUsers(sess, agentEvent(sess.sessionId, 'task_progress', {
    steps: [{ name: '正在打开云桌面', status: 'running' }],
    speech: '好嘞，我到云电脑上做，电视上能看到过程。',
  }));
  await ensureRunning();
  sendToTv(dev, tvCommand(dev.deviceId, 'stream_desktop', {
    stream: { instance_id: config.wuying.desktopId, profile: 'smooth' },
  }));
  dev.screen = 'S1';

  const psSlides = outline.sections.map((s, i) => `
$slide = $pres.Slides.Add(${i + 1}, 2)
$slide.Shapes.Title.TextFrame.TextRange.Text = ${psq(s.title)}
$slide.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text = ${psq([s.point, ...(s.details || [])].join("`n"))}
`).join('\n');
  const script = `
$ErrorActionPreference = 'Stop'
$pp = New-Object -ComObject PowerPoint.Application
$pp.Visible = 1
$pres = $pp.Presentations.Add()
${psSlides}
$out = Join-Path $env:USERPROFILE 'Desktop\\汇报.pptx'
$pres.SaveAs($out)
Write-Output "SAVED:$out"
`;
  const result = await runPowerShell(script, { timeoutS: 300 });
  trackCost(userId, null, 'desktop_seconds', Math.round((Date.now() - t0) / 1000), 's');
  if (result.status === 'Success' && result.output.includes('SAVED:')) {
    track('cua', 'make_pptx_ok', { sections: outline.sections.length, ms: Date.now() - t0 });
    broadcastUsers(sess, agentEvent(sess.sessionId, 'task_result', {
      speech: `做好了，${outline.sections.length} 页，文件在云电脑桌面上。要我讲一遍吗？`,
      actions: ['start_present'],
    }));
  } else {
    log.warn('make pptx on desktop failed', result.status, result.output.slice(0, 300));
    track('cua', 'make_pptx_fail', { status: result.status });
    broadcastUsers(sess, agentEvent(sess.sessionId, 'error', {
      speech: '云电脑上没做成，我先给你一份可以直接开讲的版本。',
    }));
    throw new Error('cua_make_failed');
  }
}

const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;
