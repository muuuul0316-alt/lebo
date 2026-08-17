// 手机 H5 逻辑：扫码绑定 → 按住说话（浏览器 ASR 实时回显，兜底录音上传）→ 信息流。
// 第一版用 H5 替代小程序（用户已确认）：不依赖微信授权，扫码即用。
(() => {
  const $ = (id) => document.getElementById(id);
  const qp = new URLSearchParams(location.search);
  let deviceId = qp.get('d') || localStorage.getItem('lebo_last_device');
  let bindToken = qp.get('t') || '';   // 二维码里的一次性绑定令牌
  let castCode = qp.get('c') || '';    // 人工报码兜底（服务端有频率限制）
  let sessionId = null, userId = null, ws = null, wsRetry = 0;
  let presenting = false;

  // ============ 连接 ============
  async function bind() {
    $('connect-status').textContent = '正在连接电视…';
    try {
      const res = await fetch('/api/phone/bind', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, bindToken, castCode, nickname: $('nickname').value.trim() }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))).error;
        if (err === 'bind_token_invalid') {
          $('connect-hint').textContent = '这个二维码过期了。看一眼电视，重新扫一次就行。';
          return;
        }
        if (err === 'too_many_attempts') {
          $('connect-hint').textContent = '试得太频繁了，等几分钟再试，或者直接扫电视上的码。';
          return;
        }
        throw new Error(err || 'bind_failed');
      }
      const info = await res.json();
      sessionId = info.sessionId; userId = info.userId; deviceId = info.deviceId;
      localStorage.setItem('lebo_last_device', deviceId);
      $('device-name').textContent = '● ' + (info.deviceName || '已连接');
      $('connect-view').classList.add('hidden');
      $('main-view').classList.remove('hidden');
      connectWs();
      greet();
    } catch (e) {
      $('connect-hint').textContent = '连接失败：电视没找到。确认电视上是这个二维码，或手动输投屏码。';
      console.error(e);
    }
  }

  let pingTimer = null;
  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?role=phone&session=${sessionId}&user=${userId}`);
    ws.onopen = () => { wsRetry = 0; };
    ws.onmessage = (e) => handle(JSON.parse(e.data));
    ws.onclose = (ev) => {
      // 服务重启后会话已不存在：重连无意义，提示回到扫码
      if (ev.code === 4004) {
        addMsg('xiaole', '跟电视断开了。看一眼电视上的二维码，重新扫一下。');
        return;
      }
      setTimeout(connectWs, Math.min(1000 * ++wsRetry, 5000));
    };
    ws.onerror = () => ws.close();
    clearInterval(pingTimer); // 每次重连都新建 interval 会不断叠加心跳
    pingTimer = setInterval(() => ws?.readyState === 1 && ws.send(JSON.stringify({ type: 'ping' })), 25000);
  }
  // 微信/移动浏览器切后台常断连，回前台时主动检查
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && sessionId && (!ws || ws.readyState > 1)) connectWs();
  });
  const send = (m) => ws?.readyState === 1 && ws.send(JSON.stringify(m));

  let greeted = false;
  function greet() {
    if (greeted) return; greeted = true;
    // 话术库 C-01
    const el = addMsg('xiaole', '我是小乐。手机里的东西我都能投到电视上；你想在电视上显示什么，只要你说得出来，我就做得到。');
    // 首条气泡挂小乐头像（Seedream 生成时启用）
    probeImg('assets/xiaole-avatar.png', (src) => {
      if (el.querySelector('.msg-avatar')) return;
      const av = document.createElement('img'); av.className = 'msg-avatar'; av.src = src; el.prepend(av);
      document.body.classList.add('has-avatar');
    });
    // 空状态插画（信息流仅有问候时）
    probeImg('assets/empty.png', (src) => {
      if (feed.querySelector('.empty-illust') || feed.querySelectorAll('.msg').length > 1) return;
      const im = document.createElement('img'); im.className = 'empty-illust'; im.src = src;
      feed.appendChild(im);
    });
  }
  // Seedream 视觉探测：有图用图、无图回落
  function probeImg(src, onOk) { const im = new Image(); im.onload = () => onOk(src); im.src = src; }
  probeImg('assets/bg.png', (src) => { document.body.style.setProperty('--phone-bg', `url(${src})`); document.body.classList.add('has-bg'); });

  // ============ 信息流渲染 ============
  const feed = $('feed');
  function addMsg(role, text, opts = {}) {
    if (role === 'me') feed.querySelector('.empty-illust')?.remove(); // 用户开口后收起空状态插画
    const el = document.createElement('div');
    el.className = 'msg ' + role;
    // 正文与富内容并存：早前版本用 innerHTML 覆盖 textContent，导致带按钮的结果卡
    // 把小乐说的话整段吞掉（违反"过程可见"）。
    if (text) {
      const p = document.createElement('div');
      p.className = 'msg-text';
      p.textContent = text; // 始终按纯文本插入，杜绝注入
      el.appendChild(p);
    }
    if (opts.html) {
      const x = document.createElement('div');
      x.className = 'msg-extra';
      x.innerHTML = opts.html; // 仅承载本地生成的结构，其中的外来字段一律已过 esc()
      el.appendChild(x);
    }
    feed.appendChild(el);
    feed.scrollTop = feed.scrollHeight;
    return el;
  }

  let statusEl = null;
  function handle(msg) {
    if (msg.type === 'hello' || msg.type === 'pong') return;
    if (msg.type !== 'agent_event') return;
    const p = msg.payload || {};
    switch (msg.event) {
      case 'ack':
        if (p.speech) addMsg('xiaole', p.speech);
        break;
      case 'task_progress':
        renderStatus(p);
        break;
      case 'task_result':
        if (statusEl) { markStepsDone(); statusEl = null; }
        if (!p.silent && p.speech) addMsg('result', p.speech, { html: resultHtml(p) });
        else if (p.actions?.length) addMsg('result', p.speech || '完成', { html: resultHtml(p) });
        break;
      case 'clarify':
      case 'error':
        if (p.speech) addMsg('xiaole', p.speech);
        break;
      case 'ingest_progress':
        renderIngest(p);
        break;
      case 'ingest_done':
        if (ingestEl) { ingestEl.remove(); ingestEl = null; }
        // 文件名来自用户上传、且会广播给同会话所有人，必须转义（否则构成跨用户存储型 XSS）
        addMsg('result', p.speech, {
          html: p.failures?.length
            ? `<div class="evidence">${p.failures.map((f) => `⚠ ${esc(f.file)}：${esc(f.reason)}`).join('<br>')}</div>`
            : `<div class="outline-list">共 ${Number(p.sections) || 0} 段，约 ${Number(p.estMinutes) || 1} 分钟。说“你来讲”就开始。</div>`,
        });
        break;
      case 'outline':
        addMsg('result', p.speech, { html: outlineHtml(p.outline) });
        break;
      case 'presenting':
        presenting = true; showPresentCtl(p);
        break;
      case 'answer':
        // 来源标签可能含模型输出或文件名，同样转义（D-04 要求必标来源，但不能因此引入注入）
        addMsg('xiaole', p.speech, {
          html: p.source_label ? `<div class="evidence">📎 ${esc(p.source_label)}</div>` : '',
        });
        break;
      case 'present_done':
        presenting = false; $('present-ctl').classList.add('hidden');
        addMsg('result', p.speech, { html: resultHtml(p) });
        break;
    }
  }

  function renderStatus(p) {
    const stepsHtml = (p.steps || []).map((s) =>
      `<div class="step ${esc(s.status || '')}"><span class="dot"></span>${esc(s.name || '')}</div>`).join('');
    const html = `${p.speech ? esc(p.speech) : '处理中'}<div class="status-steps">${stepsHtml}</div>`;
    if (!statusEl) statusEl = addMsg('status', '', { html });
    else setExtra(statusEl, html);
    feed.scrollTop = feed.scrollHeight;
  }
  // addMsg 生成的是 .msg-text + .msg-extra 两段结构，更新时只替换富内容那段
  function setExtra(el, html) {
    let x = el.querySelector('.msg-extra');
    if (!x) { x = document.createElement('div'); x.className = 'msg-extra'; el.appendChild(x); }
    x.innerHTML = html;
  }
  function markStepsDone() {
    statusEl?.querySelectorAll('.step').forEach((s) => { s.className = 'step done'; });
  }

  let ingestEl = null;
  function renderIngest(p) {
    const stages = ['解包', '识别', '理解', '备课'];
    const idx = stages.indexOf(p.stage);
    const html = `正在学习你的材料<div class="status-steps">${stages.map((s, i) => `<div class="step ${i < idx ? 'done' : i === idx ? 'running' : ''}"><span class="dot"></span>${s}${i === idx && p.detail ? '：' + esc(p.detail) : ''}</div>`).join('')}</div>`;
    if (!ingestEl) ingestEl = addMsg('status', '', { html });
    else setExtra(ingestEl, html);
    feed.scrollTop = feed.scrollHeight;
  }

  function resultHtml(p) {
    const labels = { pause: '暂停', restart: '从头播', stop: '关掉', replay: '重播', next_one: '换一个',
      explain: '让它讲', start_present: '你来讲', restart_present: '重讲', export_notes: '导出要点',
      confirm_outline: '就这么做', resume_present: '继续讲' };
    const btns = (p.actions || []).map((a) => `<button data-action="${esc(a)}">${esc(labels[a] || a)}</button>`).join('');
    return `${p.card?.title ? esc(p.card.title) : ''}${btns ? `<div class="result-actions">${btns}</div>` : ''}`;
  }
  function outlineHtml(o) {
    if (!o) return '';
    return `<div class="outline-list">${o.sections.map((s, i) => `${i + 1}. <b>${esc(s.title)}</b> — ${esc(s.point)}`).join('<br>')}</div><div class="result-actions"><button data-action="confirm_outline">就这么做</button></div>`;
  }

  // 结果卡按钮 → 语义指令（说优先于点，6.1）
  feed.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const a = btn.dataset.action;
    if (a === 'confirm_outline') return send({ type: 'confirm_outline' });
    if (a === 'start_present' || a === 'restart_present' || a === 'resume_present') return send({ type: 'present_control', op: a === 'resume_present' ? 'resume' : a === 'restart_present' ? 'restart' : 'start_present' });
    const map = { pause: '暂停', restart: '从头播', stop: '关掉', replay: '重播', next_one: '换一个', explain: '讲讲这个', export_notes: '导出要点' };
    sendText(map[a] || a);
  });

  // ============ 讲解控制条 ============
  function showPresentCtl(p) {
    $('present-ctl').classList.remove('hidden');
    $('pc-title').textContent = '正在讲：' + (p.point || '');
    $('pc-progress').textContent = `${p.section}/${p.total} 段`;
    $('pc-fill').style.width = (p.section / p.total * 100) + '%';
  }
  $('present-ctl').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-op]'); if (!b) return;
    send({ type: 'present_control', op: b.dataset.op });
    if (b.dataset.op === 'stop') $('present-ctl').classList.add('hidden');
  });

  // ============ 发送指令 ============
  function sendText(text, { isInterrupt = false } = {}) {
    if (!text.trim()) return;
    addMsg('me', text);
    send({ type: 'user_input', session_id: sessionId, input: { modality: 'text', text, is_interrupt: isInterrupt || presenting }, context: {} });
  }

  // 快捷指令（MP-04）
  $('quickbar').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-cmd]'); if (!b) return;
    const cmd = b.dataset.cmd;
    if (['投照片', '投视频', '投文件'].includes(cmd)) return openAdd();
    sendText(cmd);
  });

  // ============ 按住说话（MP-02） ============
  const talk = $('talk-btn');
  let recog = null, recognizing = false, recorder = null, chunks = [], usingWebSpeech = false;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  function startTalk() {
    talk.classList.add('recording');
    $('talk-label').textContent = '松开 发送';
    $('wave').classList.remove('hidden');
    if (presenting) send({ type: 'user_input', input: { modality: 'voice', is_interrupt: true, asr_text: '' } }); // 立即打断（500ms 静音）
    if (SR) { startWebSpeech(); } else { startRecorder(); }
  }
  function endTalk() {
    talk.classList.remove('recording');
    $('talk-label').textContent = '按住 说话';
    $('wave').classList.add('hidden');
    if (usingWebSpeech && recog) { try { recog.stop(); } catch {} }
    else if (recorder && recorder.state === 'recording') recorder.stop();
  }

  let liveText = '';
  let speechFailed = false;
  function startWebSpeech() {
    usingWebSpeech = true; liveText = ''; speechFailed = false;
    recog = new SR(); recog.lang = 'zh-CN'; recog.interimResults = true; recog.continuous = true;
    recog.onresult = (ev) => {
      let t = '';
      for (let i = 0; i < ev.results.length; i++) t += ev.results[i][0].transcript;
      liveText = t;
    };
    // iOS Safari / 微信内置浏览器上 SpeechRecognition 往往存在但不可用（not-allowed /
    // service-not-allowed / network），错误是异步来的。吞掉它就会"按住说话全程没反应"，
    // 所以这里必须回退到录音上传。
    recog.onerror = (e) => {
      speechFailed = true;
      const fatal = ['not-allowed', 'service-not-allowed', 'audio-capture', 'network'].includes(e?.error);
      if (fatal && talk.classList.contains('recording')) {
        usingWebSpeech = false;
        try { recog.stop(); } catch {}
        startRecorder(); // 还按着，转录音兜底
      }
    };
    recog.onend = () => {
      recognizing = false;
      if (liveText.trim()) sendText(liveText.trim());
      else if (speechFailed && !usingWebSpeech) { /* 已转录音，等录音结果 */ }
      else if (speechFailed) addMsg('xiaole', '没听清，再说一次？');
    };
    try { recog.start(); recognizing = true; } catch { usingWebSpeech = false; startRecorder(); }
  }

  async function startRecorder() {
    usingWebSpeech = false;
    if (!navigator.mediaDevices?.getUserMedia) {
      addMsg('xiaole', location.protocol === 'https:'
        ? '这个浏览器不支持录音。点右边键盘图标打字，一样能用。'
        : '要用语音得走 https。现在先点右边键盘图标打字。');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // 异步授权期间用户可能已经松手：此时不该继续占用麦克风
      if (!talk.classList.contains('recording')) { stream.getTracks().forEach((t) => t.stop()); return; }
      recorder = new MediaRecorder(stream); chunks = [];
      recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop()); // 必须停轨，否则麦克风常亮
        if (!chunks.length) return;
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        await uploadAsr(blob);
      };
      recorder.start();
      if (!talk.classList.contains('recording')) { try { recorder.stop(); } catch {} } // 竞态兜底
    } catch {
      addMsg('xiaole', '没拿到麦克风权限。点右边键盘图标打字，一样能用。');
    }
  }

  async function uploadAsr(blob) {
    // 火山 ASR 按 format 解码，谎报格式必然识别失败。
    // MediaRecorder 实际产出：Chrome/Android→webm(opus)，iOS Safari→mp4(aac)。
    const mime = (blob.type || recorder?.mimeType || '').toLowerCase();
    const fmt = mime.includes('ogg') ? 'ogg'
      : mime.includes('webm') ? 'webm'
      : mime.includes('mp4') || mime.includes('aac') || mime.includes('m4a') ? 'mp4'
      : mime.includes('wav') ? 'wav' : 'webm';
    const fd = new FormData(); fd.append('audio', blob, 'a.' + fmt); fd.append('format', fmt);
    const tip = addMsg('status', '识别中…');
    try {
      const r = await fetch('/api/asr', { method: 'POST', body: fd });
      const d = await r.json(); tip.remove();
      if (d.ok && d.text) sendText(d.text);
      else addMsg('xiaole', '没听清，再说一次？'); // C-10
    } catch { tip.remove(); addMsg('xiaole', '没听清，再说一次？'); }
  }

  // 触屏设备上 touch 事件后会补发 mouse 事件，双绑定会导致重复触发；用标记隔离。
  let touchMode = false;
  talk.addEventListener('touchstart', (e) => { e.preventDefault(); touchMode = true; startTalk(); }, { passive: false });
  talk.addEventListener('touchend', (e) => { e.preventDefault(); endTalk(); }, { passive: false });
  talk.addEventListener('touchcancel', () => endTalk()); // 来电/通知打断时必须收尾，否则麦克风常亮
  talk.addEventListener('mousedown', () => { if (!touchMode) startTalk(); });
  talk.addEventListener('mouseup', () => { if (!touchMode) endTalk(); });
  talk.addEventListener('mouseleave', () => { if (!touchMode && talk.classList.contains('recording')) endTalk(); });

  // ============ 内容添加 P2-a ============
  function openAdd() { $('add-panel').classList.remove('hidden'); }
  function closeAdd() {
    $('add-panel').classList.add('hidden');
    selected = [];
    // 必须重置 input.value：否则再次选择"同一个文件"时 value 未变、不触发 change，
    // 用户会卡在面板里怎么点都没反应。
    for (const id of ['file-album', 'file-doc', 'file-vip']) { const el = $(id); if (el) el.value = ''; }
    renderSelected();
  }
  $('add-btn').onclick = openAdd;
  $('add-close').onclick = closeAdd;
  $('add-panel').querySelector('.panel-mask').onclick = closeAdd;

  let selected = [];
  function renderSelected() {
    const size = selected.reduce((s, f) => s + f.size, 0);
    $('add-selected').textContent = selected.length ? `已选 ${selected.length} 个 · ${(size / 1048576).toFixed(1)}MB` : '';
    $('start-learn').classList.toggle('hidden', !selected.length);
  }
  for (const id of ['file-album', 'file-doc', 'file-vip']) {
    $(id).addEventListener('change', (e) => { selected.push(...e.target.files); renderSelected(); });
  }
  $('start-learn').onclick = async () => {
    const fd = new FormData();
    fd.append('sessionId', sessionId); fd.append('userId', userId);
    for (const f of selected) fd.append('files', f);
    const n = selected.length;
    closeAdd();
    addMsg('me', `传了 ${n} 个文件`);
    try { await fetch('/api/content/upload', { method: 'POST', body: fd }); }
    catch { addMsg('xiaole', '上传没成功，检查下网络再试。'); }
  };

  // 文字入口
  $('add-text').onclick = () => { closeAdd(); $('text-modal').classList.remove('hidden'); };
  $('kb-btn').onclick = () => $('text-modal').classList.remove('hidden');
  $('text-close').onclick = () => $('text-modal').classList.add('hidden');
  $('text-modal').querySelector('.panel-mask').onclick = () => $('text-modal').classList.add('hidden');
  $('text-send').onclick = () => {
    const t = $('text-input').value.trim();
    $('text-input').value = ''; $('text-modal').classList.add('hidden');
    if (t) sendText(t);
  };

  // ============ 启动 ============
  $('connect-btn').onclick = bind;
  if (deviceId) bind(); // 扫码带参 → 直接连
  else $('connect-hint').textContent = '请扫电视上的二维码进入';

  const esc = (s) => String(s).replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
})();
