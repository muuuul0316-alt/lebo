// 手机 H5 逻辑：扫码绑定 → 按住说话（浏览器 ASR 实时回显，兜底录音上传）→ 信息流。
// 第一版用 H5 替代小程序（用户已确认）：不依赖微信授权，扫码即用。
(() => {
  const $ = (id) => document.getElementById(id);
  const qp = new URLSearchParams(location.search);
  let deviceId = qp.get('d') || localStorage.getItem('lebo_last_device');
  let castCode = qp.get('c') || '';
  let sessionId = null, userId = null, ws = null, wsRetry = 0;
  let presenting = false;

  // ============ 连接 ============
  async function bind() {
    $('connect-status').textContent = '正在连接电视…';
    try {
      const res = await fetch('/api/phone/bind', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, castCode, nickname: $('nickname').value.trim() }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'bind_failed');
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

  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?role=phone&session=${sessionId}&user=${userId}`);
    ws.onopen = () => { wsRetry = 0; };
    ws.onmessage = (e) => handle(JSON.parse(e.data));
    ws.onclose = () => { setTimeout(connectWs, Math.min(1000 * ++wsRetry, 5000)); };
    ws.onerror = () => ws.close();
    setInterval(() => ws?.readyState === 1 && ws.send(JSON.stringify({ type: 'ping' })), 25000);
  }
  const send = (m) => ws?.readyState === 1 && ws.send(JSON.stringify(m));

  let greeted = false;
  function greet() {
    if (greeted) return; greeted = true;
    // 话术库 C-01
    addMsg('xiaole', '我是小乐。手机里的东西我都能投到电视上；你想在电视上显示什么，只要你说得出来，我就做得到。');
  }

  // ============ 信息流渲染 ============
  const feed = $('feed');
  function addMsg(role, text, opts = {}) {
    const el = document.createElement('div');
    el.className = 'msg ' + role;
    if (text) el.textContent = text;
    if (opts.html) el.innerHTML = opts.html;
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
        addMsg('result', p.speech, { html: p.failures?.length ? `<div class="evidence">${p.failures.map((f) => `⚠ ${f.file}：${f.reason}`).join('<br>')}</div>` : `<div class="outline-list">共 ${p.sections} 段，约 ${p.estMinutes} 分钟。说"你来讲"就开始。</div>` });
        break;
      case 'outline':
        addMsg('result', p.speech, { html: outlineHtml(p.outline) });
        break;
      case 'presenting':
        presenting = true; showPresentCtl(p);
        break;
      case 'answer':
        addMsg('xiaole', p.speech + (p.source_label ? '' : ''));
        if (p.source_label) feed.lastChild.innerHTML += `<div class="evidence">📎 ${p.source_label}</div>`;
        break;
      case 'present_done':
        presenting = false; $('present-ctl').classList.add('hidden');
        addMsg('result', p.speech, { html: resultHtml(p) });
        break;
    }
  }

  function renderStatus(p) {
    const stepsHtml = (p.steps || []).map((s) => `<div class="step ${s.status}"><span class="dot"></span>${s.name}</div>`).join('');
    const html = `${p.speech ? esc(p.speech) : '处理中'}<div class="status-steps">${stepsHtml}</div>`;
    if (!statusEl) statusEl = addMsg('status', '', { html });
    else statusEl.innerHTML = html;
    feed.scrollTop = feed.scrollHeight;
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
    else ingestEl.innerHTML = html;
    feed.scrollTop = feed.scrollHeight;
  }

  function resultHtml(p) {
    const labels = { pause: '暂停', restart: '从头播', stop: '关掉', replay: '重播', next_one: '换一个',
      explain: '让它讲', start_present: '你来讲', restart_present: '重讲', export_notes: '导出要点',
      confirm_outline: '就这么做', resume_present: '继续讲' };
    const btns = (p.actions || []).map((a) => `<button data-action="${a}">${labels[a] || a}</button>`).join('');
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
  function startWebSpeech() {
    usingWebSpeech = true; liveText = '';
    recog = new SR(); recog.lang = 'zh-CN'; recog.interimResults = true; recog.continuous = true;
    recog.onresult = (ev) => {
      let t = '';
      for (let i = 0; i < ev.results.length; i++) t += ev.results[i][0].transcript;
      liveText = t;
    };
    recog.onerror = () => {};
    recog.onend = () => { if (liveText.trim()) sendText(liveText.trim()); recognizing = false; };
    try { recog.start(); recognizing = true; } catch { startRecorder(); }
  }

  async function startRecorder() {
    usingWebSpeech = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recorder = new MediaRecorder(stream); chunks = [];
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        await uploadAsr(blob);
      };
      recorder.start();
    } catch {
      addMsg('xiaole', '没拿到麦克风权限。点右边键盘图标打字，一样能用。');
    }
  }

  async function uploadAsr(blob) {
    const fmt = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('webm') ? 'ogg' : 'wav';
    const fd = new FormData(); fd.append('audio', blob, 'a.' + fmt); fd.append('format', fmt);
    const tip = addMsg('status', '识别中…');
    try {
      const r = await fetch('/api/asr', { method: 'POST', body: fd });
      const d = await r.json(); tip.remove();
      if (d.ok && d.text) sendText(d.text);
      else addMsg('xiaole', '没听清，再说一次？'); // C-10
    } catch { tip.remove(); addMsg('xiaole', '没听清，再说一次？'); }
  }

  talk.addEventListener('touchstart', (e) => { e.preventDefault(); startTalk(); });
  talk.addEventListener('touchend', (e) => { e.preventDefault(); endTalk(); });
  talk.addEventListener('mousedown', startTalk);
  talk.addEventListener('mouseup', endTalk);
  talk.addEventListener('mouseleave', () => { if (talk.classList.contains('recording')) endTalk(); });

  // ============ 内容添加 P2-a ============
  function openAdd() { $('add-panel').classList.remove('hidden'); }
  function closeAdd() { $('add-panel').classList.add('hidden'); selected = []; renderSelected(); }
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
  $('add-text').onclick = () => { $('add-panel').classList.add('hidden'); $('text-modal').classList.remove('hidden'); };
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
