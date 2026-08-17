// 无影云手机（eds-aic）控制层。
// 产品价值：云电脑负责 Windows 软件与网页，云手机负责**只有 App 才有的内容与能力**
// （国内大量视频/音乐/生活服务只有 App，没有可用网页版）。二者互补，共同支撑
// PRD 4.2「云桌面=手+环境」这一层，让"你说得出来我就做得到"覆盖 App 生态。
//
// 接口定义来源：docs/api-meta/eds-aic-2023-09-30.json（官方元数据）。
import { rpcCall, expandArray } from './aliyun.js';
import { config } from '../config.js';
import { track } from '../metrics.js';
import { log } from '../log.js';

const P = 'eds-aic';

export function available() {
  return !!(config.wuying.accessKeyId && config.phone.instanceId);
}

const ids = () => expandArray('AndroidInstanceIds', [config.phone.instanceId]);

/** 查询云手机实例详情 */
export async function status(instanceId = config.phone.instanceId) {
  const d = await rpcCall(P, 'DescribeAndroidInstances', expandArray('AndroidInstanceIds', [instanceId]));
  const inst = d.InstanceModel?.[0] || d.Data?.[0] || d.AndroidInstances?.[0];
  if (!inst) return null;
  return {
    id: inst.AndroidInstanceId || instanceId,
    name: inst.AndroidInstanceName,
    status: inst.AndroidInstanceStatus || inst.Status,
    groupId: inst.InstanceGroupId,
    rate: inst.Rate,
  };
}

/** 开机（已在运行则跳过）；返回最终状态 */
export async function ensureRunning(instanceId = config.phone.instanceId) {
  const s = await status(instanceId);
  if (!s) throw new Error(`未找到云手机实例 ${instanceId}`);
  if (s.status === 'RUNNING' || s.status === 'Running') return s;
  log.info('启动云手机', instanceId, '当前状态', s.status);
  await rpcCall(P, 'StartAndroidInstance', expandArray('AndroidInstanceIds', [instanceId]));
  track('cua', 'phone_start', { instanceId });
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const cur = await status(instanceId);
    if (cur?.status === 'RUNNING' || cur?.status === 'Running') return cur;
  }
  throw new Error('云手机启动超时');
}

export async function stop(instanceId = config.phone.instanceId) {
  await rpcCall(P, 'StopAndroidInstance', expandArray('AndroidInstanceIds', [instanceId]));
  track('cua', 'phone_stop', { instanceId });
}

/**
 * 在云手机内执行命令（ADB shell 语义）。
 * 典型用途：am start 拉起某个 App 的指定页面、input tap/swipe 模拟操作。
 */
export async function runCommand(content, { instanceId = config.phone.instanceId, timeout = 60 } = {}) {
  const d = await rpcCall(P, 'RunCommand', {
    ...expandArray('InstanceIds', [instanceId]),
    CommandContent: content,
    ContentEncoding: 'PlainText',
    Timeout: timeout,
  });
  const invocationId = d.InvokeId || d.InvocationId;
  if (!invocationId) return { status: 'Unknown', output: '', raw: d };

  for (let i = 0; i < Math.ceil(timeout / 3) + 2; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const q = await rpcCall(P, 'DescribeInvocations', {
      ...expandArray('InstanceIds', [instanceId]),
      InvocationId: invocationId,
    });
    const inv = q.Data?.[0] || q.Invocations?.[0];
    const st = inv?.InvocationStatus || inv?.Status;
    if (st && !['Running', 'Pending', 'InProgress'].includes(st)) {
      let output = inv.Output || inv.OutputInfo || '';
      // 官方对输出做 Base64 的情况
      if (output && /^[A-Za-z0-9+/=\s]+$/.test(output) && output.length % 4 === 0) {
        try { output = Buffer.from(output, 'base64').toString('utf8'); } catch { /* 保留原文 */ }
      }
      return { status: st, output, raw: inv };
    }
  }
  return { status: 'Timeout', output: '' };
}

/** 拉起指定 App（可带 deeplink），用于"用 App 打开某内容" */
export async function launchApp(packageName, { activity, deeplink, instanceId } = {}) {
  const cmd = deeplink
    ? `am start -a android.intent.action.VIEW -d "${deeplink}"`
    : activity
      ? `am start -n ${packageName}/${activity}`
      : `monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`;
  return runCommand(cmd, { instanceId });
}

/** 安装应用（apk 需可公网下载或在 OSS） */
export async function installApp(appId, { instanceId = config.phone.instanceId } = {}) {
  return rpcCall(P, 'InstallApp', {
    ...expandArray('InstanceIdList', [instanceId]),
    ...expandArray('AppIdList', [appId]),
  });
}

/** 推文件进云手机（OSS 或公网直链） */
export async function sendFile(sourceUrl, targetPath, { instanceId = config.phone.instanceId } = {}) {
  return rpcCall(P, 'SendFile', {
    ...expandArray('AndroidInstanceIdList', [instanceId]),
    SourceFilePath: targetPath,
    UploadType: 'Url',
    UploadUrl: sourceUrl,
  });
}

/**
 * 取拉流凭证：把云手机画面投到电视端 H5（配合无影 Web SDK）。
 * 对应 PRD TV-02 串流接收，与云电脑的 GetConnectionTicket 并列。
 */
export async function connectionTicket({ instanceId = config.phone.instanceId, endUserId } = {}) {
  const d = await rpcCall(P, 'BatchGetAcpConnectionTicket', {
    ...expandArray('InstanceIds', [instanceId]),
    ...(endUserId ? { EndUserId: endUserId } : {}),
  });
  const t = d.InstanceConnectionModels?.[0] || d.Data?.[0];
  return t ? { instanceId: t.AndroidInstanceId || instanceId, ticket: t.Ticket, taskId: t.TaskId, appInstanceGroupId: t.AppInstanceGroupId } : null;
}
