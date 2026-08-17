// 电视端逻辑：注册取二维码 → WS 接 tv_command → 渲染 S0–S5。
// 电视端只做渲染（唯一真相源在云端，6.7.4）；播放控制走本地播放器，讲解 TTS 优先火山音频、兜底 speechSynthesis。
(() => {
  const $ = (id) => document.getElementById(id);
  const screens = ['s0', 's1', 's2', 's3'];
  let deviceId = localStorage.getItem('lebo_tv_device') || null;
  let ws = null, wsRetry = 0;

  const EXAMPLES = ['「看个电影」', '「讲讲这份 PPT」', '「查天气」', '「把这些材料做成一份 PPT」', '「投上去讲讲这张照片」'];
  let exIdx = 0;
  setInterval(() => {
    exIdx = (exIdx + 1) % EXAMPLES.length;
    const el = $('s0-examples'); el.style.opacity = 0;
    setTimeout(() => { el.textContent = EXAMPLES[exIdx] + EXAMPLES[(exIdx + 1) % EXAMPLES.length]; el.style.opacity = 1; }, 400);
  }, 3500);

  function show(id) {
    for (const s of screens) $(s).classList.toggle('active', s === id);
  }
  function overlay(text) {
    if (!text) return $('s5-overlay').classList.add('hidden');
    $('s5-text').textContent = text;
    $('s5-overlay').classList.remove('hidden');
  }

  let deviceSecret = localStorage.getItem('lebo_tv_secret') || null;

  async function register() {
    const res = await fetch('/api/tv/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, deviceSecret, name: '客厅的电视' }),
    });
    const info = await res.json();
    deviceId = info.deviceId;
    deviceSecret = info.deviceSecret;
    localStorage.setItem('lebo_tv_device', deviceId);
    localStorage.setItem('lebo_tv_secret', deviceSecret);
    $('qr-img').src = info.qrDataUrl;
    $('cast-code').textContent = info.castCode.replace(/(\d{3})(\d{3})/, '$1 $2');
    connect();
  }

  let pingTimer = null;
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?role=tv&device=${encodeURIComponent(deviceId)}&secret=${encodeURIComponent(deviceSecret || '')}`);
    ws.onopen = () => { wsRetry = 0; $('net-state').textContent = '● 网络正常'; };
    ws.onmessage = (e) => handle(JSON.parse(e.data));
    ws.onclose = (ev) => {
      $('net-state').textContent = '● 重连中';
      // 服务重启后设备表清空（4004）或密钥不符（4003）：必须重新注册换新二维码，
      // 否则电视会永久卡在"重连中"，二维码也永远扫不通。
      if (ev.code === 4004 || ev.code === 4003) {
        deviceId = null; deviceSecret = null;
        localStorage.removeItem('lebo_tv_device'); localStorage.removeItem('lebo_tv_secret');
        setTimeout(() => register().catch(() => setTimeout(register, 3000)), 1000);
        return;
      }
      setTimeout(connect, Math.min(1000 * ++wsRetry, 5000));
    };
    ws.onerror = () => ws.close();
    clearInterval(pingTimer); // 每次重连都新建 interval 会叠加，必须先清
    pingTimer = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'ping' })), 25000);
  }
  const send = (m) => ws?.readyState === 1 && ws.send(JSON.stringify(m));

  // ============ 处理云端指令 ============
  function handle(cmd) {
    if (cmd.type === 'hello') return;
    if (cmd.type === 'pong') return;
    if (cmd.type !== 'tv_command') return;
    switch (cmd.command) {
      case 'reset': show('s0'); overlay(null); stopPlayer(); break;
      case 'render': renderLayout(cmd); break;
      case 'play_local': playLocal(cmd.play); break;
      case 'player_ctl': playerCtl(cmd.ctl); break;
      case 'stream_desktop': streamDesktop(cmd.stream); break;
      case 'overlay': handleOverlay(cmd); break;
      case 'layout_ctl': break; // 简化：布局调整由后续 render 承载
    }
    if (cmd.tts) speak(cmd.tts);
    if (cmd.presenting) updatePresentBar(cmd.presenting);
  }

  function handleOverlay(cmd) {
    if (cmd.ctl?.op === 'mute_tts') stopSpeak();
  }

  // ---- 讲解/问答/大字卡：布局引擎（6.10 布局 DSL） ----
  function renderLayout(cmd) {
    const lay = cmd.layout;
    if (!lay) return;
    const stage = $('stage');
    stage.className = 'stage layout-' + (lay.layout || 'L1');
    stage.innerHTML = '';
    for (const pane of lay.panes || []) stage.appendChild(renderPane(pane));
    // 讲解态显示状态条，纯问答/大字卡也复用 S3 容器
    show('s3');
    $('present-bar').style.visibility = cmd.presenting ? 'visible' : 'hidden';
    if (lay.subtitle?.enabled === false) $('subtitle').textContent = '';
  }

  function renderPane(pane) {
    const el = document.createElement('div');
    el.className = 'pane';
    const c = pane.content || {};
    if (c.title && c.kind !== 'text_card') {
      const t = document.createElement('div'); t.className = 'pane-title'; t.textContent = c.title; el.appendChild(t);
    }
    if (c.kind === 'image' && c.url) {
      const img = document.createElement('img'); img.src = c.url; el.appendChild(img);
      if (c.focus?.rect) el.appendChild(focusRing(c.focus.rect));
    } else if (c.kind === 'video' && c.url) {
      const v = document.createElement('video'); v.src = c.url; v.autoplay = true; v.controls = false; v.playsInline = true;
      v.onended = () => send({ type: 'play_event', event: 'clip_end' }); el.appendChild(v);
    } else if (c.kind === 'table') {
      const d = document.createElement('div'); d.className = 'pane-table'; d.textContent = c.text || ''; el.appendChild(d);
    } else if (c.kind === 'text_card') {
      const d = document.createElement('div'); d.className = 'pane-text pane-textcard';
      d.innerHTML = `<div class="big">${esc(c.title || '')}</div>${c.text ? `<div class="body">${esc(c.text)}</div>` : ''}`;
      el.appendChild(d);
    } else if (c.kind === 'doc_page') {
      const d = document.createElement('div'); d.className = 'pane-text'; d.textContent = c.text || c.title || ''; el.appendChild(d);
    } else if (c.kind === 'web' && c.url) {
      const f = document.createElement('iframe'); f.src = c.url; f.style.cssText = 'width:100%;height:100%;border:0;background:#fff'; el.appendChild(f);
    } else {
      const d = document.createElement('div'); d.className = 'pane-text'; d.textContent = c.text || '（内容加载中）'; el.appendChild(d);
    }
    if (c.source_label) {
      const s = document.createElement('div'); s.className = 'source-label'; s.textContent = c.source_label; el.appendChild(s);
    }
    return el;
  }
  function focusRing(rect) {
    const r = document.createElement('div'); r.className = 'focus-ring';
    r.style.left = rect[0] * 100 + '%'; r.style.top = rect[1] * 100 + '%';
    r.style.width = rect[2] * 100 + '%'; r.style.height = rect[3] * 100 + '%';
    return r;
  }

  function updatePresentBar(p) {
    $('present-bar').style.visibility = 'visible';
    $('present-title').textContent = '正在讲：' + (p.point || '');
    $('present-progress').textContent = `第 ${p.section} 段 / 共 ${p.total} 段`;
    $('present-status').textContent = '讲解中';
  }

  // ---- 本地播放器（TV-03；7.4 视频不走串流） ----
  const player = $('player');
  let lastPlayFail = '';

  // 电视端从打开到起播通常没有任何用户手势，未静音的 video.play() 必被自动播放策略拒绝。
  // 因此先静音起播保证"有画面"，声音等拿到手势再开——注意不能在无手势时取消静音，
  // 那样浏览器会直接把视频暂停，比黑屏更糟。
  async function playLocal(play) {
    if (!play?.url) return;
    show('s2');
    lastPlayFail = '';
    player.src = play.url;
    player.currentTime = (play.start_at_ms || 0) / 1000;
    player.muted = !audioUnlocked;
    send({ type: 'screen_changed', screen: 'S2' });
    try {
      await player.play();
      send({ type: 'play_event', event: 'play_ok' });
      if (player.muted) overlay('按遥控器任意键开启声音');
      else overlay(null);
    } catch (e) {
      // 失败必须让用户看得见：电视端自己先说话，同时回传手机（否则手机会谎报"开始了"）
      reportPlayFail(e?.name || 'play_error', '这个片子没放起来，看手机换一个');
    }
  }
  // 同一次播放只上报一次失败：play() 的 reject 与 media error 事件常会先后各触发一次
  function reportPlayFail(reason, tip) {
    if (lastPlayFail) return;
    lastPlayFail = reason;
    overlay(tip);
    send({ type: 'play_event', event: 'play_fail', reason });
  }
  // 片源不可达/解码失败同样要有反馈，不能静默黑屏
  player.addEventListener('error', () => {
    if (!player.src) return; // stopPlayer 清空 src 时浏览器也会抛 error，忽略
    reportPlayFail('media_error', '这个片源打不开，看手机换一个');
  });
  function playerCtl(ctl) {
    if (!ctl) return;
    const toast = (t) => { const el = $('player-toast'); el.textContent = t; el.classList.remove('hidden'); setTimeout(() => el.classList.add('hidden'), 1500); };
    switch (ctl.op) {
      case 'pause': player.paused ? player.play() : player.pause(); break;
      case 'resume': player.play(); break;
      case 'seek_forward': player.currentTime += (ctl.seconds || 600); toast('+' + fmt(ctl.seconds || 600)); break;
      case 'seek_back': player.currentTime -= (ctl.seconds || 600); toast('-' + fmt(ctl.seconds || 600)); break;
      case 'restart': player.currentTime = 0; player.play(); break;
      case 'stop': stopPlayer(); show('s0'); send({ type: 'screen_changed', screen: 'S0' }); break;
    }
  }
  function stopPlayer() { try { player.pause(); player.removeAttribute('src'); player.load(); } catch {} }

  // ---- 云桌面串流（TV-02）：正式接入无影 Web SDK；此处显示占位并可挂 video 流 ----
  function streamDesktop(stream) {
    show('s1');
    $('stream-holder').querySelector('.stream-hint').style.display = 'flex';
    send({ type: 'screen_changed', screen: 'S1' });
    // 无影 Web SDK 接入点：用 stream.instance_id + 后端 GetConnectionTicket 建立 WebRTC，绑定到 #stream-video
  }

  // ---- TTS：优先火山 mp3；无音频用浏览器 speechSynthesis 兜底 ----
  // 浏览器自动播放策略：没有用户手势时 audio.play() 与 speechSynthesis 都会被拦截，
  // 讲解就只剩字幕没有声音。因此首次被拦截时在屏上提示一次"按任意键开启声音"，
  // 拿到手势后解锁，并把当前这段补播出来。
  const audio = $('tts-audio');
  let audioUnlocked = false;
  let pendingTts = null;

  function unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    overlay(null);
    try { audio.play().catch(() => {}); } catch {}
    if ('speechSynthesis' in window) { try { speechSynthesis.resume(); } catch {} }
    // 拿到手势后补救视频：静音播放中的取消静音，被策略挡住的重新起播
    if (player.src) {
      if (player.muted) player.muted = false;
      if (player.paused) player.play().catch(() => {});
    }
    // 若失败原因不是策略拦截（片源本身不可达），按键并不能解决，提示要保留
    if (lastPlayFail === 'media_error') overlay('这个片源打不开，看手机换一个');
    if (pendingTts) { const t = pendingTts; pendingTts = null; speak(t); }
  }
  for (const ev of ['click', 'keydown', 'touchstart', 'pointerdown']) {
    document.addEventListener(ev, unlockAudio, { once: false, passive: true });
  }

  function needGesture(tts) {
    pendingTts = tts;
    overlay('按遥控器任意键开启声音');
  }

  function speak(tts) {
    if (tts.text) { $('subtitle').textContent = tts.text; }
    stopSpeak();
    const epoch = tts.epoch;
    if (tts.audio_b64) {
      audio.src = 'data:audio/mp3;base64,' + tts.audio_b64;
      audio.onended = () => send({ type: 'tts_done', epoch });
      audio.onerror = () => browserSpeak(tts.text, epoch);
      audio.play().then(() => { audioUnlocked = true; })
        .catch(() => { if (!audioUnlocked) needGesture(tts); else browserSpeak(tts.text, epoch); });
    } else if (tts.text) {
      browserSpeak(tts.text, epoch);
    }
  }

  function browserSpeak(text, epoch) {
    // 无语音合成能力（多数老电视浏览器）：按字数估时后再上报，避免讲解瞬间空跑到底
    if (!('speechSynthesis' in window) || !text) {
      setTimeout(() => send({ type: 'tts_done', epoch }), Math.max(3000, text ? text.length * 240 : 1500));
      return;
    }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN'; u.rate = 1.05;
    let reported = false;
    const done = () => { if (!reported) { reported = true; send({ type: 'tts_done', epoch }); } };
    u.onend = done;
    // 中文音色缺失/被拦截时 onend 不会触发，讲解会永久卡住 —— 用兜底计时器保底推进
    u.onerror = () => { if (!audioUnlocked) needGesture({ text, epoch }); else done(); };
    setTimeout(done, Math.max(4000, text.length * 260));
    try { speechSynthesis.speak(u); } catch { done(); }
  }
  function stopSpeak() {
    try { audio.pause(); audio.currentTime = 0; } catch {}
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }

  const esc = (s) => String(s).replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
  const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  // Seedream 品牌视觉：探测资源是否已生成（tools/gen-assets.mjs），有则启用，无则回落 CSS。
  function probeImg(src, onOk) {
    const im = new Image();
    im.onload = () => onOk(src);
    im.src = src;
  }
  probeImg('assets/hero-bg.png', (src) => { $('s0').style.setProperty('--hero-bg', `url(${src})`); $('s0').classList.add('has-hero'); });
  probeImg('assets/xiaole.png', (src) => { $('s0-mascot').src = src; $('s0').classList.add('has-mascot'); });

  show('s0');
  register().catch((e) => { overlay('连接服务失败，正在重试…'); console.error(e); setTimeout(register, 3000); });
})();
