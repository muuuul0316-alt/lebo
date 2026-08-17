// 任务拆解引擎（PRD 6.14）：意图 → 任务树 DSL。
// executor 四选一：cua | brain | tv_player | content_engine，与路由表（5.3.2）一一对应。
// user_visible_steps 与内部动作解耦：用户永远只看到 2–4 个人话步骤。

export function planFor(intentResult, ctx = {}) {
  const { intent, slots = {} } = intentResult;
  switch (intent) {
    case 'play_video':
      return {
        intent, slots,
        speak_now: intentResult.speak_now,
        tasks: [
          { id: 'T1', name: '找片源', executor: 'brain', op: 'find_media', timeout_ms: 12000, retry: 1 },
          { id: 'T2', name: '起播', executor: 'tv_player', op: 'play_local', depends_on: ['T1'], timeout_ms: 8000 },
        ],
        user_visible_steps: ['正在找片源', '正在起播'],
        success_criteria: '电视端出现画面且持续播放',
      };
    case 'control_playback':
      // 铁律（7.4）：播放控制不经 CUA，直接下发本地播放器指令
      return { intent, slots, tasks: [{ id: 'T1', name: '播放控制', executor: 'tv_player', op: slots.op || 'resume', timeout_ms: 2000 }], user_visible_steps: [] };
    case 'ask_info':
      // 能不启云桌面就不启（拆解规则 30）：纯问答走主脑
      return {
        intent, slots, speak_now: intentResult.speak_now,
        tasks: [{ id: 'T1', name: '查询', executor: 'brain', op: 'answer', timeout_ms: 15000 }],
        user_visible_steps: ['正在查'],
      };
    case 'cast_content':
      return { intent, slots, tasks: [{ id: 'T1', name: '投屏', executor: 'content_engine', op: 'cast', timeout_ms: 5000 }], user_visible_steps: ['正在投上去'] };
    case 'explain_content':
      return {
        intent, slots, speak_now: intentResult.speak_now,
        tasks: [{ id: 'T1', name: '讲解', executor: 'content_engine', op: 'explain', timeout_ms: 60000 }],
        user_visible_steps: ['正在备课'],
      };
    case 'make_content':
      // 先大纲后成品（5.6.1 大纲闸门）；云桌面制作段由 CUA 承接
      return {
        intent, slots, speak_now: intentResult.speak_now,
        tasks: [
          { id: 'T0', name: '列提纲', executor: 'brain', op: 'outline', timeout_ms: 30000 },
          { id: 'T1', name: '云桌面制作', executor: 'cua', op: 'make_pptx', depends_on: ['T0'], gated_on: 'outline_confirm', timeout_ms: 480000 },
        ],
        user_visible_steps: ['正在想结构', '正在制作'],
      };
    case 'control_session':
      return { intent, slots, tasks: [{ id: 'T1', name: '讲解控制', executor: 'content_engine', op: slots.op || 'resume', timeout_ms: 2000 }], user_visible_steps: [] };
    case 'control_layout':
      return { intent, slots, tasks: [{ id: 'T1', name: '布局调整', executor: 'tv_player', op: 'layout', timeout_ms: 1000 }], user_visible_steps: [] };
    default:
      return { intent: 'unknown', slots, tasks: [], user_visible_steps: [] };
  }
}
