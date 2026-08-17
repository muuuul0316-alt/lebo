// 云资源命令行：在有公网出口的环境（GitHub Actions runner / 你的服务器）操作阿里云无影云桌面。
// 复用 server/src/cua/aliyun.js 的签名实现，不引 SDK。
//
// 用法：
//   node tools/cloud-cli.mjs status                  查询云桌面状态
//   node tools/cloud-cli.mjs start                   启动云桌面（已运行则跳过）
//   node tools/cloud-cli.mjs run "powershell 命令"    在云桌面内执行 PowerShell 并取回输出
//   node tools/cloud-cli.mjs bootstrap-agent <wss地址> <token>   在云桌面内部署并拉起 CUA 执行体
//
// 环境变量：WUYING_ACCESS_KEY_ID / WUYING_ACCESS_KEY_SECRET / WUYING_REGION / WUYING_DESKTOP_ID

import crypto from 'node:crypto';

const AK = process.env.WUYING_ACCESS_KEY_ID;
const SK = process.env.WUYING_ACCESS_KEY_SECRET;
const REGION = process.env.WUYING_REGION || 'cn-shenzhen';
const DESKTOP = process.env.WUYING_DESKTOP_ID;

if (!AK || !SK || !DESKTOP) {
  console.error('缺少环境变量：WUYING_ACCESS_KEY_ID / WUYING_ACCESS_KEY_SECRET / WUYING_DESKTOP_ID');
  process.exit(1);
}

const pctEncode = (s) => encodeURIComponent(s)
  .replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~');

async function ecd(action, params = {}) {
  const common = {
    Action: action, Format: 'JSON', Version: '2020-09-30',
    AccessKeyId: AK, SignatureMethod: 'HMAC-SHA1', SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    RegionId: REGION, ...params,
  };
  const canonical = Object.keys(common).sort()
    .map((k) => `${pctEncode(k)}=${pctEncode(String(common[k]))}`).join('&');
  const sig = crypto.createHmac('sha1', SK + '&')
    .update(`GET&%2F&${pctEncode(canonical)}`).digest('base64');
  const res = await fetch(`https://ecd.${REGION}.aliyuncs.com/?${canonical}&Signature=${pctEncode(sig)}`, {
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json();
  if (data.Code && data.Code !== 'Success') {
    throw new Error(`${action} 失败 [${data.Code}]: ${data.Message || ''}`);
  }
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function status() {
  const d = await ecd('DescribeDesktops', { 'DesktopId.1': DESKTOP });
  const dk = d.Desktops?.[0];
  if (!dk) throw new Error(`未找到云桌面 ${DESKTOP}（检查 RegionId=${REGION} 是否正确）`);
  return { id: dk.DesktopId, name: dk.DesktopName, status: dk.DesktopStatus, os: dk.OsType, ip: dk.DesktopIp };
}

async function start() {
  const s = await status();
  if (s.status === 'Running') { console.log('云桌面已在运行'); return s; }
  console.log(`当前状态 ${s.status}，正在启动…`);
  await ecd('StartDesktops', { 'DesktopId.1': DESKTOP });
  for (let i = 0; i < 40; i++) {
    await sleep(5000);
    const cur = await status();
    process.stdout.write(`  ${cur.status}\r`);
    if (cur.status === 'Running') { console.log('\n云桌面已启动'); return cur; }
  }
  throw new Error('启动超时（3分钟）');
}

async function runPowerShell(script, timeoutS = 300) {
  const inv = await ecd('RunCommand', {
    'DesktopId.1': DESKTOP,
    Type: 'RunPowerShellScript',
    CommandContent: Buffer.from(script, 'utf8').toString('base64'),
    ContentEncoding: 'Base64',
    Timeout: timeoutS,
  });
  const invokeId = inv.InvokeId;
  console.log('已下发命令 InvokeId=', invokeId);
  for (let i = 0; i < Math.ceil(timeoutS / 5); i++) {
    await sleep(5000);
    const q = await ecd('DescribeInvocations', { InvokeId: invokeId, IncludeOutput: true });
    const task = q.Invocations?.[0]?.InvokeDesktops?.[0];
    if (!task) continue;
    if (['Success', 'Failed', 'Stopped', 'Timeout'].includes(task.InvocationStatus)) {
      const out = task.Output ? Buffer.from(task.Output, 'base64').toString('utf8') : '';
      return { status: task.InvocationStatus, exitCode: task.ExitCode, output: out };
    }
    process.stdout.write(`  ${task.InvocationStatus}\r`);
  }
  return { status: 'Timeout', output: '' };
}

// 在云桌面内装好依赖并把 CUA 执行体跑起来（让云桌面能接管浏览器/Office 等真实软件）
async function bootstrapAgent(wsUrl, token) {
  const ps = `
$ErrorActionPreference='Continue'
$dir="$env:USERPROFILE\\lebo-cua"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
# 取 CUA 执行体
$url="https://raw.githubusercontent.com/${process.env.GITHUB_REPOSITORY || 'muuuul0316-alt/lebo'}/claude/lobster-2kl0yz/cua-agent/agent.py"
Invoke-WebRequest -Uri $url -OutFile "$dir\\agent.py" -UseBasicParsing
# 确认 python
$py = (Get-Command python -ErrorAction SilentlyContinue)
if (-not $py) { Write-Output "NO_PYTHON: 云桌面内未安装 Python，请先安装"; exit 1 }
python -m pip install --quiet pyautogui pillow websocket-client 2>&1 | Out-Null
# 后台拉起
Start-Process -WindowStyle Hidden python -ArgumentList "$dir\\agent.py","--server","${wsUrl}","--token","${token}","--desktop","${DESKTOP}"
Start-Sleep -Seconds 3
Write-Output "AGENT_STARTED"
`;
  return runPowerShell(ps, 300);
}

const [cmd, ...args] = process.argv.slice(2);
try {
  switch (cmd) {
    case 'status':
      console.log(JSON.stringify(await status(), null, 2));
      break;
    case 'start':
      console.log(JSON.stringify(await start(), null, 2));
      break;
    case 'run': {
      if (!args[0]) throw new Error('用法: node tools/cloud-cli.mjs run "<powershell>"');
      await start();
      const r = await runPowerShell(args[0]);
      console.log(`\n状态: ${r.status}  退出码: ${r.exitCode ?? '-'}`);
      console.log('--- 输出 ---');
      console.log(r.output || '(无输出)');
      if (r.status !== 'Success') process.exit(1);
      break;
    }
    case 'bootstrap-agent': {
      if (!args[0] || !args[1]) throw new Error('用法: node tools/cloud-cli.mjs bootstrap-agent <wss地址> <token>');
      await start();
      const r = await bootstrapAgent(args[0], args[1]);
      console.log(`\n状态: ${r.status}`);
      console.log(r.output || '(无输出)');
      if (!r.output?.includes('AGENT_STARTED')) process.exit(1);
      break;
    }
    default:
      console.log('可用命令: status | start | run "<powershell>" | bootstrap-agent <wss> <token>');
      process.exit(1);
  }
} catch (e) {
  console.error('错误:', e.message);
  process.exit(1);
}
