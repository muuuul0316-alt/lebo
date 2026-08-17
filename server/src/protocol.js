// 端间通信协议（PRD 6.9）与显示编排协议（PRD 6.10）。
// 三端消息必须结构化、可埋点、可重放；tv_command 幂等，断线重连用最后一条恢复画面。

export const LAYOUTS = ['L1', 'L2_MAIN_SIDE', 'L2_EQUAL', 'L3', 'L6'];
export const PANE_KINDS = ['image', 'video', 'doc_page', 'table', 'web', 'text_card'];

// 云端 → 手机（PRD 6.9.2）
export function agentEvent(sessionId, event, payload = {}, taskId = null) {
  return { type: 'agent_event', session_id: sessionId, event, task_id: taskId, payload, ts: Date.now() };
}

// 云端 → 电视（PRD 6.9.3）。command: render | play_local | stream_desktop | overlay | reset
export function tvCommand(deviceId, command, fields = {}) {
  return { type: 'tv_command', device_id: deviceId, command, ...fields, ts: Date.now() };
}

// 布局 DSL（PRD 6.10）。证据素材必须带 source_label（D-04 证据必标来源）。
export function layout(name, panes, opts = {}) {
  if (!LAYOUTS.includes(name)) name = 'L1';
  return {
    layout: name,
    panes: panes.map((p) => ({
      slot: p.slot || 'main',
      content: {
        kind: PANE_KINDS.includes(p.kind) ? p.kind : 'text_card',
        ...(p.assetId ? { asset_id: p.assetId } : {}),
        ...(p.url ? { url: p.url } : {}),
        ...(p.text ? { text: p.text } : {}),
        ...(p.title ? { title: p.title } : {}),
        ...(p.focus ? { focus: p.focus } : {}),
        ...(p.sourceLabel ? { source_label: p.sourceLabel } : {}),
      },
    })),
    subtitle: { enabled: opts.subtitle !== false, max_lines: 2 },
    transition: { type: opts.transition || 'crossfade', duration_ms: 300 },
  };
}

export function textCard(title, text) {
  return layout('L1', [{ slot: 'main', kind: 'text_card', title, text }]);
}
