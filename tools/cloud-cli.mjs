// 云资源命令行：在有公网出口的环境（GitHub Actions runner / 你的服务器）操作阿里云无影
// 云电脑（ecd）与云手机（eds-aic）。接口参数依据 docs/api-meta/ 的官方元数据。
//
// 云电脑（Windows：网页/Office/下载）：
//   node tools/cloud-cli.mjs status                  查询云电脑状态
//   node tools/cloud-cli.mjs start                   启动云电脑（已运行则跳过）
//   node tools/cloud-cli.mjs run "powershell 命令"    在云电脑内执行 PowerShell 并取回输出
//   node tools/cloud-cli.mjs ticket                  取云电脑串流连接凭证
//   node tools/cloud-cli.mjs bootstrap-agent <wss> <token>   部署并拉起 CUA 执行体
//
// 云手机（Android：只有 App 才有的内容与能力）：
//   node tools/cloud-cli.mjs phone-status            查询云手机状态
//   node tools/cloud-cli.mjs phone-start             启动云手机
//   node tools/cloud-cli.mjs phone-run "adb shell 命令"
//   node tools/cloud-cli.mjs phone-launch <包名> [deeplink]  拉起 App
//   node tools/cloud-cli.mjs phone-ticket            取云手机拉流凭证
//
// 环境变量：WUYING_ACCESS_KEY_ID / WUYING_ACCESS_KEY_SECRET / WUYING_REGION
//           WUYING_DESKTOP_ID（云电脑） / PHONE_INSTANCE_ID（云手机）

import crypto from 'node:crypto';

const AK = process.env.WUYING_ACCESS_KEY_ID;
const SK = process.env.WUYING_ACCESS_KEY_SECRET;
const REGION = process.env.WUYING_REGION || 'cn-shenzhen';
const DESKTOP = process.env.WUYING_DESKTOP_ID;
const PHONE = process.env.PHONE_INSTANCE_ID;

if (!AK || !SK) {
  console.error('缺少环境变量：WUYING_ACCESS_KEY_ID / WUYING_ACCESS_KEY_SECRET');
  process.exit(1);
}

const PRODUCTS = {
  ecd: { version: '2020-09-30', host: `ecd.${REGION}.aliyuncs.com` },
  'eds-aic': { version: '2023-09-30', host: `eds-aic.${REGION}.aliyuncs.com` },
};

const pctEncode = (s) => encodeURIComponent(s)
  .replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~');

const arr = (name, values) => Object.fromEntries(
  (Array.isArray(values) ? values : [values]).filter(Boolean).map((v, i) => [`${name}.${i + 1}`, v])
);

// 走 POST：RunCommand 的 Base64 脚本可达 16KB，GET 查询串会 414 超长
async function rpc(product, action, params = {}) {
  const p = PRODUCTS[product];
  const all = {
    Action: action, Format: 'JSON', Version: p.version,
    AccessKeyId: AK, SignatureMethod: 'HMAC-SHA1', SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    RegionId: REGION, ...params,
  };
  for (const k of Object.keys(all)) if (all[k] === undefined || all[k] === null || all[k] === '') delete all[k];
  const canonical = Object.keys(all).sort()
    .map((k) => `${pctEncode(k)}=${pctEncode(String(all[k]))}`).join('&');
  const sig = crypto.createHmac('sha1', SK + '&')
    .update(`POST&${pctEncode('/')}&${pctEncode(canonical)}`).digest('base64');
  const res = await fetch(`https://${p.host}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `${canonical}&Signature=${pctEncode(sig)}`,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`${action} 返回非 JSON (HTTP ${res.status}): ${text.slice(0, 200)}`); }
  if (!res.ok || (data.Code && data.Code !== 'Success' && data.Message)) {
    throw new Error(`${action} 失败 [${data.Code || res.status}]: ${data.Message || text.slice(0, 200)}`);
  }
  return data;
}

const ecd = (action, params) => rpc('ecd', action, params);
const aic = (action, params) => rpc('eds-aic', action, params);
const needDesktop = () => { if (!DESKTOP) { console.error('缺少 WUYING_DESKTOP_ID'); process.exit(1); } };
const needPhone = () => { if (!PHONE) { console.error('缺少 PHONE_INSTANCE_ID'); process.exit(1); } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function status() {
  needDesktop();
  const d = await ecd('DescribeDesktops', arr('DesktopId', [DESKTOP]));
  const dk = d.Desktops?.[0];
  if (!dk) throw new Error(`未找到云桌面 ${DESKTOP}（检查 RegionId=${REGION} 是否正确）`);
  return { id: dk.DesktopId, name: dk.DesktopName, status: dk.DesktopStatus, os: dk.OsType, ip: dk.DesktopIp };
}

async function start() {
  const s = await status();
  if (s.status === 'Running') { console.log('云桌面已在运行'); return s; }
  console.log(`当前状态 ${s.status}，正在启动…`);
  await ecd('StartDesktops', arr('DesktopId', [DESKTOP]));
  for (let i = 0; i < 40; i++) {
    await sleep(5000);
    const cur = await status();
    process.stdout.write(`  ${cur.status}\r`);
    if (cur.status === 'Running') { console.log('\n云桌面已启动'); return cur; }
  }
  throw new Error('启动超时（3分钟）');
}

async function runPowerShell(script, timeoutS = 300) {
  needDesktop();
  const inv = await ecd('RunCommand', {
    ...arr('DesktopId', [DESKTOP]),
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

// ---------------- 云手机（eds-aic） ----------------
async function phoneStatus() {
  needPhone();
  const d = await aic('DescribeAndroidInstances', arr('AndroidInstanceIds', [PHONE]));
  const inst = d.InstanceModel?.[0] || d.Data?.[0] || d.AndroidInstances?.[0];
  if (!inst) throw new Error(`未找到云手机 ${PHONE}（检查 RegionId=${REGION}）`);
  return {
    id: inst.AndroidInstanceId || PHONE,
    name: inst.AndroidInstanceName,
    status: inst.AndroidInstanceStatus || inst.Status,
    groupId: inst.InstanceGroupId,
  };
}

async function phoneStart() {
  const s = await phoneStatus();
  if (/RUNNING/i.test(s.status || '')) { console.log('云手机已在运行'); return s; }
  console.log(`当前状态 ${s.status}，正在启动…`);
  await aic('StartAndroidInstance', arr('AndroidInstanceIds', [PHONE]));
  for (let i = 0; i < 36; i++) {
    await sleep(5000);
    const cur = await phoneStatus();
    process.stdout.write(`  ${cur.status}\r`);
    if (/RUNNING/i.test(cur.status || '')) { console.log('\n云手机已启动'); return cur; }
  }
  throw new Error('云手机启动超时');
}

async function phoneRun(command, timeout = 60) {
  needPhone();
  const d = await aic('RunCommand', {
    ...arr('InstanceIds', [PHONE]),
    CommandContent: command,
    ContentEncoding: 'PlainText',
    Timeout: timeout,
  });
  const invId = d.InvokeId || d.InvocationId;
  console.log('已下发命令 InvocationId=', invId);
  if (!invId) return { status: 'Unknown', output: JSON.stringify(d).slice(0, 300) };
  for (let i = 0; i < Math.ceil(timeout / 3) + 3; i++) {
    await sleep(3000);
    const q = await aic('DescribeInvocations', { ...arr('InstanceIds', [PHONE]), InvocationId: invId });
    const inv = q.Data?.[0] || q.Invocations?.[0];
    const st = inv?.InvocationStatus || inv?.Status;
    if (st && !/Running|Pending|InProgress/i.test(st)) {
      let out = inv.Output || inv.OutputInfo || '';
      if (out && /^[A-Za-z0-9+/=\s]+$/.test(out) && out.length % 4 === 0) {
        try { out = Buffer.from(out, 'base64').toString('utf8'); } catch { /* 保留原文 */ }
      }
      return { status: st, output: out };
    }
    process.stdout.write(`  ${st || '执行中'}\r`);
  }
  return { status: 'Timeout', output: '' };
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
    case 'ticket': {
      needDesktop();
      const d = await ecd('GetConnectionTicket', {
        DesktopId: DESKTOP,
        EndUserId: process.env.WUYING_END_USER_ID,
        Password: process.env.WUYING_DESKTOP_PASSWORD,
      });
      console.log(JSON.stringify({ ticket: d.Ticket, taskId: d.TaskId, taskStatus: d.TaskStatus }, null, 2));
      break;
    }
    case 'phone-status':
      console.log(JSON.stringify(await phoneStatus(), null, 2));
      break;
    case 'phone-start':
      console.log(JSON.stringify(await phoneStart(), null, 2));
      break;
    case 'phone-run': {
      if (!args[0]) throw new Error('用法: node tools/cloud-cli.mjs phone-run "<命令>"');
      await phoneStart();
      const r = await phoneRun(args[0]);
      console.log(`\n状态: ${r.status}`);
      console.log('--- 输出 ---');
      console.log(r.output || '(无输出)');
      break;
    }
    case 'phone-launch': {
      if (!args[0]) throw new Error('用法: node tools/cloud-cli.mjs phone-launch <包名> [deeplink]');
      await phoneStart();
      const c = args[1]
        ? `am start -a android.intent.action.VIEW -d "${args[1]}"`
        : `monkey -p ${args[0]} -c android.intent.category.LAUNCHER 1`;
      const r = await phoneRun(c);
      console.log(`\n状态: ${r.status}\n${r.output || ''}`);
      break;
    }
    case 'phone-ticket': {
      needPhone();
      const d = await aic('BatchGetAcpConnectionTicket', arr('InstanceIds', [PHONE]));
      console.log(JSON.stringify(d.InstanceConnectionModels || d.Data || d, null, 2));
      break;
    }
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
      console.log('云电脑: status | start | run "<powershell>" | ticket | bootstrap-agent <wss> <token>');
      console.log('云手机: phone-status | phone-start | phone-run "<命令>" | phone-launch <包名> [deeplink] | phone-ticket');
      process.exit(1);
  }
} catch (e) {
  console.error('错误:', e.message);
  process.exit(1);
}
