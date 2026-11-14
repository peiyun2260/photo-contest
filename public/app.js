// 攝影大賽前端：純原生 JS，不需要 build。
(() => {
  'use strict';

  const EVENT_DAY = '2026-11-25';
  const PHASES = ['報名・上傳', '投票', '公布結果'];
  const LONG_EDGE = 2000;
  const THUMB_EDGE = 600;
  const HEIC_LIB = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
  const CFG = window.CONTEST_CONFIG || {};
  const SB_URL = (CFG.supabaseUrl || '').replace(/\/+$/, '');
  const SB_KEY = CFG.supabaseAnonKey || '';

  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // LINE 內建瀏覽器或無痕模式下 localStorage 可能會丟例外
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  let state = null;
  let stateSeq = 0;
  let token = store.get('pc_token');
  let adminToken = store.get('pc_admin');
  let adminState = null;
  let mode = 'register';
  let uploads = [];
  let uploadKey = 0;
  let busyVote = null;

  // ---------- 與後端溝通 ----------

  // 所有資料都透過 Supabase 的資料庫函式（supabase/schema.sql）存取
  async function rpc(fn, args = {}) {
    if (!SB_URL || !SB_KEY) throw new Error('網站還在設定中，晚一點再來。');
    let res;
    try {
      res = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
    } catch {
      throw new Error('連不上網路，檢查一下訊號再試一次。');
    }
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok || !data || data.error) {
      const err = new Error((data && data.error) || '出了點狀況，請再試一次。');
      err.status = (data && data.status) || res.status;
      throw err;
    }
    return data;
  }

  function applyState(next) {
    stateSeq += 1;
    state = next;
    if (token && !state.me) {
      // 被主辦人移除，或登入過期
      token = null;
      store.del('pc_token');
    }
    render();
  }

  async function refresh() {
    const seq = stateSeq;
    let next;
    try {
      next = await rpc('get_state', { p_token: token });
    } catch (err) {
      if (!state) $('hero-lead').textContent = err.message + '（會自動重試）';
      return;
    }
    // 畫面更新放在 try 外面，程式出錯時才不會被默默吃掉
    if (seq === stateSeq) applyState(next);
  }

  // ---------- 畫面 ----------

  const htmlCache = new WeakMap();
  function setHTML(el, html) {
    if (htmlCache.get(el) === html) return;
    htmlCache.set(el, html);
    el.innerHTML = html;
  }

  const scrollBehavior = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
  const thumbUrl = (id) => `${SB_URL}/storage/v1/object/public/photos/${id}_t.jpg`;
  const fullUrl = (id) => `${SB_URL}/storage/v1/object/public/photos/${id}.jpg`;

  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('is-on');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove('is-on'), 3200);
  }

  function daysLeft() {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
    return Math.round((Date.parse(EVENT_DAY) - Date.parse(today)) / 86400000);
  }
  const CORNERS = '<span class="corners" aria-hidden="true"><i class="c c--tl"></i><i class="c c--tr"></i><i class="c c--bl"></i><i class="c c--br"></i></span>';
  const frameNo = (i) => `<span class="shot__no" aria-hidden="true">${String(i + 1).padStart(2, '0')}</span>`;

  const LAYOUT = {
    1: [['hero', 'blush'], ['info', ''], ['join', 'parchment'], ['me', 'parchment'], ['roster', '']],
    2: [['hero', 'blush'], ['join', 'parchment'], ['me', 'parchment'], ['vote', 'dark'], ['roster', ''], ['info', 'parchment']],
    3: [['hero', 'blush'], ['results', 'dark'], ['roster', 'parchment'], ['info', '']],
  };
  let layoutPhase = 0;

  function applyLayout(phase) {
    if (layoutPhase === phase) return;
    layoutPhase = phase;
    const main = $('main');
    for (const [id, tone] of LAYOUT[phase]) {
      const el = $(id);
      el.classList.remove('tile--dark', 'tile--parchment', 'tile--blush');
      if (tone) el.classList.add('tile--' + tone);
      main.appendChild(el);
    }
  }

  function render() {
    if (!state) return;
    const { phase, me } = state;
    applyLayout(phase);

    $('nav-phase').textContent = '現在：' + PHASES[phase - 1];
    $('hud-phase').textContent = ['報名・上傳中', '投票中', '結果出爐'][phase - 1];
    const photoCount = state.participants.reduce((n, p) => n + p.photos.length, 0);
    const days = daysLeft();
    const first = phase === 1 && days >= 0
      ? (days === 0 ? ['今天', '就是登記日'] : [days, '天後登記'])
      : phase === 3
        ? [state.photos.reduce((n, p) => n + p.votes, 0), '張選票']
        : [1, '票／每人']
    ;
    setHTML($('readout'), [first, [state.participants.length, '人報名'], [photoCount, '張照片']]
      .map(([n, label]) => `<p><b>${n}</b><span>${label}</span></p>`).join(''));

    const lead = {
      1: me
        ? `${me.name}，謝謝你願意來。拍完之後，照片可以回到這裡上傳。`
        : '11 月 25 日下午，想邀請你來見證，也幫我們留下這一天。報名、交照片、投票都在這裡呦',
      2: '請你挑選一張你覺得最讚的',
      3: '結果出來了！',
    }[phase];
    $('hero-lead').textContent = lead;
    // 活動結束後（投票、公布結果）改成道謝的語氣
    setHTML($('hero-title'), phase === 1
      ? '我們要結婚了！<br>一起和我們紀錄吧'
      : '我們結婚了！<br>謝謝你們幫我們記錄 愛你');
    // 公布結果時，獎項說明的標題就不需要了
    $('prizes-title').hidden = phase === 3;

    setHTML($('steps'), PHASES.map((label, i) => {
      const n = i + 1;
      const attr = n === phase ? ' aria-current="step"' : n < phase ? ' class="is-done"' : '';
      return `<li${attr}>${n}. ${label}</li>`;
    }).join(''));

    const actions = {
      1: me
        ? '<a class="btn" href="#me">交照片</a><a class="btn btn--ghost" href="#info">活動資訊</a>'
        : '<a class="btn" href="#join">我要參賽</a><a class="btn btn--ghost" href="#info">活動資訊</a>',
      2: '<a class="btn" href="#vote">去投票</a>',
      3: '<a class="btn" href="#results">看得獎照片</a>',
    }[phase];
    setHTML($('hero-actions'), actions);

    renderJoin();
    renderMe();
    renderVote();
    renderResults();
    renderRoster();
    if (lightbox.open) renderLightbox();
  }

  function renderJoin() {
    const { phase, me } = state;
    const show = !me && phase < 3;
    $('join').hidden = !show;
    if (!show) return;
    const loginOnly = phase === 2;
    const m = loginOnly ? 'login' : mode;
    $('join-title').textContent = loginOnly ? '先登入再投票' : m === 'login' ? '歡迎回來' : '報名';
    $('join-lead').textContent = loginOnly
      ? '用報名時的名字和密碼登入，就可以投票了。'
      : m === 'login'
        ? '輸入報名時的名字和密碼就可以了。'
        : '輸入名字和一組數字密碼報名，下次用這組名字數字登入';
    document.querySelector('#join .segmented').hidden = loginOnly;
    for (const b of document.querySelectorAll('[data-action="mode"]')) {
      b.setAttribute('aria-pressed', String(b.dataset.mode === m));
    }
    const people = state.participants;
    $('joined').hidden = !people.length;
    setHTML($('joined'), people.length ? `
      <p class="joined__title">已經報名的朋友（${people.length}）</p>
      <ul>${people.map((p) => `<li><button type="button" class="chip${p.attending ? '' : ' chip--away'}" data-action="pick-name" data-name="${esc(p.name)}">${esc(p.name)}${p.attending ? '' : '<small>我不行QQ</small>'}</button></li>`).join('')}</ul>
      <p class="joined__hint">看到自己的名字了嗎？點一下就可以直接登入。</p>` : '');
    $('f-attend').hidden = m === 'login';
    $('f-pin-hint').hidden = m === 'login';
    $('f-pin').autocomplete = m === 'login' ? 'current-password' : 'new-password';
    const submit = $('join-submit');
    if (!submit.disabled) submit.textContent = m === 'login' ? '登入' : '報名';
    submit.dataset.mode = m;
  }

  function myPhotos() {
    const mine = state.participants.find((p) => p.id === state.me.id);
    return mine ? mine.photos : [];
  }

  function renderMe() {
    const { phase, me } = state;
    const show = Boolean(me) && phase < 3;
    $('me').hidden = !show;
    if (!show) return;
    const head = `
      <div class="me__head">
        <h2 id="me-title" tabindex="-1">嗨，${esc(me.name)}</h2>
        <button type="button" class="link-btn" data-action="logout">登出</button>
      </div>`;

    if (phase === 2) {
      const voted = state.photos.find((p) => p.id === me.vote);
      setHTML($('me-body'), head + `
        <p class="status" role="status">${voted
          ? `你目前投給 <strong>${esc(voted.ownerName)}</strong> 的照片。截止前想改都可以。`
          : '你還沒投票。慢慢看，選一張最喜歡的。'}</p>`);
      return;
    }

    const photos = myPhotos();
    const used = photos.length + uploads.length;
    const slots = [];
    for (const p of photos) {
      slots.push(`
        <div class="slot">
          <div class="slot__frame">
            <button type="button" class="slot__open" data-action="open" data-id="${p.id}" data-name="${esc(me.name)}" aria-label="看大圖">
              <img src="${thumbUrl(p.id)}" alt="你上傳的照片" width="${p.w}" height="${p.h}" decoding="async">
            </button>
          </div>
          <div class="slot__actions">
            <button type="button" class="btn btn--small btn--quiet" data-action="delete-photo" data-id="${p.id}">刪除</button>
          </div>
        </div>`);
    }
    for (const u of uploads) {
      const img = u.preview ? `<img src="${u.preview}" alt="">` : '';
      let veil;
      let actions = '';
      if (u.status === 'error') {
        veil = `<div class="slot__veil" role="alert">沒傳成功<br>${esc(u.error)}</div>`;
        actions = `
          <button type="button" class="btn btn--small" data-action="retry-upload" data-key="${u.key}">重試</button>
          <button type="button" class="btn btn--small btn--quiet" data-action="cancel-upload" data-key="${u.key}">取消</button>`;
      } else if (u.status === 'upload') {
        veil = `<div class="slot__veil" data-upload="${u.key}"><span>上傳中 ${u.progress}%</span><div class="slot__bar"><i style="transform:scaleX(${u.progress / 100})"></i></div></div>`;
        actions = `<button type="button" class="btn btn--small btn--quiet" data-action="cancel-upload" data-key="${u.key}">取消</button>`;
      } else {
        veil = '<div class="slot__veil"><span class="spinner" aria-hidden="true"></span><span>處理照片中…</span></div>';
      }
      slots.push(`
        <div class="slot">
          <div class="slot__frame">${img}${veil}</div>
          <div class="slot__actions">${actions}</div>
        </div>`);
    }
    for (let i = used; i < state.maxPhotos; i += 1) {
      slots.push(`
        <div class="slot">
          <div class="slot__frame">
            <button type="button" class="slot__add" data-action="pick">${CORNERS}<b aria-hidden="true">＋</b>選照片</button>
          </div>
        </div>`);
    }

    setHTML($('me-body'), head + `
      <div class="me__block">
        <div class="me__label" id="attend-label">11/25 會來現場嗎？</div>
        <div class="segmented" role="group" aria-labelledby="attend-label" style="margin:0">
          <button type="button" class="segmented__btn" data-action="attend" data-value="yes" aria-pressed="${me.attending}">我會到場</button>
          <button type="button" class="segmented__btn" data-action="attend" data-value="no" aria-pressed="${!me.attending}">我不行QQ</button>
        </div>
      </div>
      <div class="me__block">
        <div class="me__label">你的參賽照片<span>${photos.length} / ${state.maxPhotos}</span></div>
        <div class="slots" data-gallery>${slots.join('')}</div>
        <p class="me__note">直接從相簿選就可以，會自動縮圖後上傳，iPhone 的 HEIC 也可以。投票開始前都能更換。</p>
      </div>`);
  }

  function shotImg(p, alt) {
    return `<img src="${thumbUrl(p.id)}" alt="${esc(alt)}" width="${p.w}" height="${p.h}" loading="lazy" decoding="async">`;
  }

  function voteButton(p, small) {
    const me = state.me;
    if (me && p.ownerId === me.id) return '<div class="shot__mine">你的作品</div>';
    const chosen = me && me.vote === p.id;
    const label = busyVote === p.id ? '<span class="spinner" aria-hidden="true"></span>投票中…' : chosen ? '✓ 已投這張' : me && me.vote ? '改投這張' : '投這張';
    return `<button type="button" class="btn ${small ? 'btn--small btn--block' : ''} ${chosen ? '' : 'btn--ghost'}" data-action="vote" data-id="${p.id}" aria-pressed="${Boolean(chosen)}">${label}</button>`;
  }

  function renderVote() {
    const show = state.phase === 2;
    $('vote').hidden = !show;
    if (!show) return;
    const photos = state.photos;
    const wall = photos.map((p, i) => `
      <figure class="shot${state.me && state.me.vote === p.id ? ' is-voted' : ''}">
        <button type="button" class="shot__open" data-action="open" data-id="${p.id}" data-name="${esc(p.ownerName)}" aria-label="看 ${esc(p.ownerName)} 的照片大圖">
          ${shotImg(p, p.ownerName + ' 拍的照片')}${frameNo(i)}
        </button>
        <figcaption><span class="shot__by">${esc(p.ownerName)}</span></figcaption>
        ${voteButton(p, true)}
      </figure>`).join('');
    setHTML($('vote-body'), `
      <h2 id="vote-title">投票牆</h2>
      <p class="tile__lead">${photos.length
        ? `共 ${photos.length} 張，每人 1 票。點照片可以看大圖，票數會在公布時揭曉。`
        : '還沒有照片，再等一下下。'}</p>
      <div class="wall" data-gallery>${wall}</div>`);
  }

  function renderResults() {
    const show = state.phase === 3;
    $('results').hidden = !show;
    if (!show) return;
    const byId = Object.fromEntries(state.photos.map((p) => [p.id, p]));
    const winner = (id) => {
      const p = byId[id];
      if (!p) return '';
      return `
        <figure class="winner">
          <button type="button" class="winner__open" data-action="open" data-id="${p.id}" data-name="${esc(p.ownerName)}" aria-label="看 ${esc(p.ownerName)} 的照片大圖">
            <img src="${fullUrl(p.id)}" alt="${esc(p.ownerName)} 拍的得獎照片" width="${p.w}" height="${p.h}" decoding="async" fetchpriority="high">
          </button>
          <figcaption><span class="winner__name">${esc(p.ownerName)}</span><span class="winner__votes">${p.votes} 票</span></figcaption>
        </figure>`;
    };
    const { popular, favorites } = state.result;
    const tags = (id) =>
      (popular.includes(id) ? '<span class="tag">人氣獎</span> ' : '') +
      (favorites.includes(id) ? '<span class="tag">最愛</span> ' : '');
    const wall = state.photos.map((p, i) => `
      <figure class="shot">
        <button type="button" class="shot__open" data-action="open" data-id="${p.id}" data-name="${esc(p.ownerName)}" aria-label="看 ${esc(p.ownerName)} 的照片大圖">
          ${shotImg(p, p.ownerName + ' 拍的照片')}${frameNo(i)}
        </button>
        <figcaption><span class="shot__by">${tags(p.id)}${esc(p.ownerName)}</span><span class="shot__votes">${p.votes} 票</span></figcaption>
      </figure>`).join('');
    setHTML($('results-body'), `
      <h2 id="results-title">得獎作品</h2>
      <div class="award">
        <h3 class="award__title">人氣獎</h3>
        <p class="award__sub">${popular.length > 1 ? `同票並列，${popular.length} 張一起得獎。` : '大家投票選出來的。'}</p>
        <div class="award__list" data-gallery>${popular.map(winner).join('') || '<p class="muted">這次沒有人投票，人氣獎先保留。</p>'}</div>
      </div>
      <div class="award">
        <h3 class="award__title">我們ㄉPick</h3>
        <p class="award__sub">我們會挑一張我們最喜歡的嘻嘻</p>
        <div class="award__list" data-gallery>${favorites.map(winner).join('') || '<p class="muted">我們還在挑，晚一點公布。</p>'}</div>
      </div>
      <h3>全部照片</h3>
      <div class="wall" data-gallery style="margin-top:0">${wall || '<p class="muted">這次沒有照片。</p>'}</div>`);
  }

  function renderRoster() {
    const list = state.participants;
    const coming = list.filter((p) => p.attending).length;
    const rows = list.map((p) => `
      <li>
        <span class="avatar${p.attending ? '' : ' avatar--away'}" aria-hidden="true">${esc([...p.name][0])}</span>
        <span class="roster__name">${esc(p.name)}${state.me && state.me.id === p.id ? '（你）' : ''}
          <small>${p.attending ? '會到場' : '我不行QQ'}</small>
        </span>
        <span class="roster__thumbs" data-gallery>${p.photos.map((ph) => `
          <button type="button" data-action="open" data-id="${ph.id}" data-name="${esc(p.name)}" aria-label="看 ${esc(p.name)} 的照片大圖">
            <img src="${thumbUrl(ph.id)}" alt="" width="44" height="44" loading="lazy" decoding="async">
          </button>`).join('')}</span>
      </li>`).join('');
    setHTML($('roster-body'), `
      <h2 id="roster-title">已經報名的朋友</h2>
      <div class="roster__stats">
        <p><b>${list.length}</b><span>人報名</span></p>
        <p><b>${coming}</b><span>人會到場</span></p>
      </div>
      ${list.length
        ? `<ul class="roster__list">${rows}</ul>`
        : ''}`);
  }

  // ---------- 確認視窗 ----------

  function confirmDialog(title, text, okLabel) {
    const dlg = $('confirm');
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    $('confirm-ok').textContent = okLabel;
    dlg.returnValue = 'cancel';
    return new Promise((resolve) => {
      dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
      dlg.showModal();
    });
  }

  // ---------- 報名／登入 ----------

  function fieldError(id, message) {
    $(id).setAttribute('aria-invalid', message ? 'true' : 'false');
    $(id + '-err').textContent = message || '';
  }

  async function submitJoin(e) {
    e.preventDefault();
    const submit = $('join-submit');
    if (submit.disabled) return;
    const m = submit.dataset.mode;
    const name = $('f-name').value.trim();
    const pin = $('f-pin').value.trim();
    fieldError('f-name', name ? '' : '名字還沒填。');
    fieldError('f-pin', /^\d{4,6}$/.test(pin) ? '' : '密碼要是 4–6 位數字。');
    $('join-error').textContent = '';
    if (!name) return $('f-name').focus();
    if (!/^\d{4,6}$/.test(pin)) return $('f-pin').focus();

    submit.disabled = true;
    submit.innerHTML = `<span class="spinner" aria-hidden="true"></span>${m === 'login' ? '登入中…' : '報名中…'}`;
    try {
      const args = { p_name: name, p_pin: pin };
      if (m === 'register') args.p_attending = $('join-form').elements.attending.value === 'yes';
      const data = await rpc(m === 'login' ? 'login' : 'register', args);
      token = data.token;
      store.set('pc_token', token);
      $('join-form').reset();
      submit.disabled = false;
      applyState(data.state);
      toast(m === 'login' ? `歡迎回來，${data.state.me.name}` : '報名好了，謝謝你！');
      const title = $('me-title');
      if (title) {
        title.focus({ preventScroll: true });
        $('me').scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
      }
    } catch (err) {
      submit.disabled = false;
      $('join-error').textContent = err.message;
      if (err.status === 409) $('f-name').focus();
      else if (err.status === 401) $('f-pin').focus();
      renderJoin();
    }
  }

  async function logout() {
    const ok = await confirmDialog('要登出嗎？', '之後用同一組名字和密碼就能再登入。', '登出');
    if (!ok) return;
    try { await rpc('logout', { p_token: token }); } catch {}
    token = null;
    store.del('pc_token');
    uploads = [];
    mode = 'login';
    await refresh();
  }

  async function setAttending(value) {
    if (state.me.attending === value) return;
    try {
      const data = await rpc('set_attending', { p_token: token, p_attending: value });
      applyState(data.state);
      toast(value ? '太好了，當天見！' : '沒關係，謝謝你告訴我們。');
    } catch (err) {
      toast(err.message);
      refresh();
    }
  }

  // ---------- 照片處理與上傳 ----------

  const looksHeic = (file) => /hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name);

  async function loadSource(blob) {
    if ('createImageBitmap' in window) {
      try {
        const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
        return { src: bmp, w: bmp.width, h: bmp.height, release: () => bmp.close && bmp.close() };
      } catch {}
    }
    // 舊版瀏覽器或記憶體不夠時改用 <img>；現代瀏覽器畫到 canvas 時會自動套用 EXIF 方向
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    try {
      await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; });
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
    return { src: img, w: img.naturalWidth, h: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
  }

  let heicLoading;
  function loadHeicLib() {
    heicLoading = heicLoading || new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = HEIC_LIB;
      s.onload = () => resolve(window.heic2any);
      s.onerror = () => { heicLoading = null; reject(new Error('load')); };
      document.head.appendChild(s);
    });
    return heicLoading;
  }

  async function decode(file) {
    try {
      return await loadSource(file); // iPhone Safari 本身就讀得懂 HEIC
    } catch {
      if (!looksHeic(file)) throw new Error('這個檔案打不開，換一張試試。');
    }
    try {
      const heic2any = await loadHeicLib();
      const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
      return await loadSource(Array.isArray(out) ? out[0] : out);
    } catch {
      throw new Error('HEIC 轉檔失敗，請先截圖或轉成 JPG 再傳。');
    }
  }

  function drawScaled(src, w, h, edge) {
    const scale = Math.min(1, edge / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  const toJpeg = (canvas, quality) =>
    new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('照片處理失敗，換一張試試。'))), 'image/jpeg', quality);
    });

  async function compress(file) {
    const source = await decode(file);
    try {
      const big = drawScaled(source.src, source.w, source.h, LONG_EDGE);
      const small = drawScaled(big, big.width, big.height, THUMB_EDGE);
      const [full, thumb] = [await toJpeg(big, 0.85), await toJpeg(small, 0.75)];
      const out = { full, thumb, w: big.width, h: big.height };
      big.width = big.height = small.width = small.height = 0; // 釋放 iOS 的 canvas 記憶體
      return out;
    } finally {
      source.release();
    }
  }

  const newPhotoId = () =>
    Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');

  function setProgress(u, ratio) {
    u.progress = Math.min(99, Math.round(ratio * 100));
    const veil = document.querySelector(`[data-upload="${u.key}"]`);
    if (veil) {
      veil.querySelector('span').textContent = `上傳中 ${u.progress}%`;
      veil.querySelector('i').style.transform = `scaleX(${u.progress / 100})`;
    }
  }

  // 用 XHR 直接傳到 Supabase Storage，才拿得到上傳進度
  function putFile(u, name, blob, done, total) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      u.xhr = xhr;
      xhr.open('POST', `${SB_URL}/storage/v1/object/photos/${name}`);
      xhr.setRequestHeader('apikey', SB_KEY);
      xhr.setRequestHeader('Authorization', 'Bearer ' + SB_KEY);
      xhr.setRequestHeader('Content-Type', 'image/jpeg');
      xhr.setRequestHeader('Cache-Control', 'max-age=31536000');
      xhr.timeout = 120000;
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) setProgress(u, (done + e.loaded) / total); };
      xhr.onerror = () => reject(new Error('網路不穩'));
      xhr.ontimeout = () => reject(new Error('傳太久了'));
      xhr.onabort = () => reject(new Error('已取消'));
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(xhr.status === 413 ? '檔案太大了' : '伺服器沒收到')));
      xhr.send(blob);
    });
  }

  async function send(u) {
    u.status = 'upload';
    u.progress = 0;
    u.error = '';
    render();
    const id = newPhotoId(); // 每次重試都用新的檔名，避免和上次傳一半的檔案撞名
    const total = u.thumb.size + u.full.size;
    try {
      await putFile(u, `${id}_t.jpg`, u.thumb, 0, total);
      await putFile(u, `${id}.jpg`, u.full, u.thumb.size, total);
      if (!uploads.includes(u)) return;
      const data = await rpc('add_photo', { p_token: token, p_id: id, p_w: u.w, p_h: u.h });
      dropUpload(u);
      applyState(data.state);
      toast('照片收到了！');
    } catch (err) {
      if (!uploads.includes(u)) return;
      u.status = 'error';
      u.error = err.message;
      render();
      if (err.status === 401 || err.status === 409) refresh();
    }
  }

  function dropUpload(u) {
    uploads = uploads.filter((x) => x !== u);
    if (u.xhr) u.xhr.abort();
    if (u.preview) URL.revokeObjectURL(u.preview);
  }

  async function startUpload(u) {
    u.status = 'compress';
    u.error = '';
    render();
    try {
      if (!u.full) {
        const out = await compress(u.file);
        Object.assign(u, out);
        u.preview = URL.createObjectURL(out.thumb);
      }
    } catch (err) {
      if (!uploads.includes(u)) return;
      u.status = 'error';
      u.error = err.message;
      return render();
    }
    if (uploads.includes(u)) send(u);
  }

  function pickFiles(files) {
    const room = state.maxPhotos - myPhotos().length - uploads.length;
    const list = [...files];
    if (room <= 0) return toast(`已經 ${state.maxPhotos} 張了，想換要先刪掉一張。`);
    if (list.length > room) toast(`每人最多 ${state.maxPhotos} 張，只收前 ${room} 張。`);
    for (const file of list.slice(0, Math.max(0, room))) {
      if (file.type && !file.type.startsWith('image/')) {
        toast('只能上傳照片喔。');
        continue;
      }
      uploadKey += 1;
      const u = { key: uploadKey, file, status: 'compress', progress: 0, error: '' };
      uploads.push(u);
      startUpload(u);
    }
  }

  async function deletePhoto(id) {
    const ok = await confirmDialog('刪掉這張？', '刪掉就不能復原，但你可以再上傳別張。', '刪除');
    if (!ok) return;
    try {
      const data = await rpc('delete_photo', { p_token: token, p_id: id });
      applyState(data.state);
      toast('已刪除。');
    } catch (err) {
      toast(err.message);
      refresh();
    }
  }

  // ---------- 投票 ----------

  async function vote(id) {
    if (!state.me) {
      if (lightbox.open) lightbox.close();
      toast('請先登入，再投票。');
      $('join').scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
      setTimeout(() => $('f-name').focus({ preventScroll: true }), 400);
      return;
    }
    if (busyVote || state.me.vote === id) return;
    busyVote = id;
    render();
    try {
      const data = await rpc('cast_vote', { p_token: token, p_photo_id: id });
      busyVote = null;
      applyState(data.state);
      toast('投好了！截止前都可以改。');
    } catch (err) {
      busyVote = null;
      render();
      toast(err.message);
      refresh();
    }
  }

  // ---------- 看大圖 ----------

  const lightbox = $('lightbox');
  let lb = { items: [], index: 0 };

  function openLightbox(button) {
    const group = button.closest('[data-gallery]');
    const buttons = group ? [...group.querySelectorAll('[data-action="open"]')] : [button];
    lb.items = buttons.map((b) => ({ id: b.dataset.id, name: b.dataset.name }));
    lb.index = Math.max(0, buttons.indexOf(button));
    renderLightbox(true);
    if (!lightbox.open) {
      lightbox.showModal();
      history.pushState({ lb: true }, '');
    }
  }

  function renderLightbox(changed) {
    const item = lb.items[lb.index];
    if (!item) return;
    const img = $('lb-img');
    if (changed) {
      // 先放縮圖，大圖載完再換上，網路慢也不會看到一片黑
      img.src = thumbUrl(item.id);
      img.alt = `${item.name} 拍的照片`;
      const full = new Image();
      full.onload = () => {
        if (lb.items[lb.index] === item && lightbox.open) img.src = full.src;
      };
      full.src = fullUrl(item.id);
    }
    const photo = state && state.photos ? state.photos.find((p) => p.id === item.id) : null;
    const count = lb.items.length > 1 ? `${lb.index + 1} / ${lb.items.length}` : '';
    const votes = photo && state.phase === 3 ? `${photo.votes} 票` : '';
    setHTML($('lb-caption'), `<b>${esc(item.name)}</b>${[count, votes].filter(Boolean).join('・')}`);
    setHTML($('lb-action'), photo && state.phase === 2 ? voteButton(photo, false) : '');
    const many = lb.items.length > 1;
    for (const b of lightbox.querySelectorAll('.lightbox__nav')) b.hidden = !many;
  }

  function stepLightbox(delta) {
    if (lb.items.length < 2) return;
    lb.index = (lb.index + delta + lb.items.length) % lb.items.length;
    renderLightbox(true);
  }

  lightbox.addEventListener('close', () => {
    $('lb-img').removeAttribute('src');
    if (history.state && history.state.lb) history.back();
  });
  // 手機按「上一頁」時關掉大圖，而不是離開網站
  window.addEventListener('popstate', () => {
    if (lightbox.open) lightbox.close();
  });
  lightbox.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') stepLightbox(-1);
    if (e.key === 'ArrowRight') stepLightbox(1);
  });
  $('lb-stage').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) lightbox.close(); // 點照片以外的地方就關閉
  });

  let touch = null;
  lightbox.addEventListener('touchstart', (e) => {
    touch = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
  }, { passive: true });
  lightbox.addEventListener('touchend', (e) => {
    if (!touch || e.touches.length) return;
    const zoomed = window.visualViewport && window.visualViewport.scale > 1.05;
    const dx = e.changedTouches[0].clientX - touch.x;
    const dy = e.changedTouches[0].clientY - touch.y;
    touch = null;
    if (zoomed) return;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) stepLightbox(dx < 0 ? 1 : -1);
    else if (dy > 90 && dy > Math.abs(dx) * 1.5) lightbox.close(); // 往下滑關閉
  }, { passive: true });

  // ---------- 管理面板 ----------

  const isAdminView = () => location.hash === '#admin';

  function showView() {
    const admin = isAdminView();
    $('admin').hidden = !admin;
    $('main').hidden = admin;
    document.querySelector('.footer').hidden = admin;
    if (admin) {
      renderAdmin();
      if (adminToken) refreshAdmin();
      window.scrollTo(0, 0);
    }
  }

  async function refreshAdmin() {
    try {
      adminState = await rpc('admin_state', { p_token: adminToken });
    } catch (err) {
      if (err.status === 401) {
        adminToken = null;
        adminState = null;
        store.del('pc_admin');
      }
    }
    renderAdmin();
  }

  function renderAdmin() {
    const body = $('admin-body');
    if (!adminToken || !adminState) {
      if (adminToken) return setHTML(body, '<h1 id="admin-title">管理面板</h1><p class="tile__lead">載入中…</p>');
      return setHTML(body, `
        <h1 id="admin-title">管理面板</h1>
        <p class="tile__lead">這裡是主辦人專區。朋友們請<a href="#">回活動頁</a>。</p>
        <form id="admin-form" style="margin-top:24px" novalidate>
          <div class="field">
            <label for="a-pass">管理密碼</label>
            <input id="a-pass" name="password" type="password" autocomplete="current-password" autocapitalize="off" spellcheck="false" aria-describedby="a-pass-err" required>
            <p class="field__error" id="a-pass-err" role="alert"></p>
          </div>
          <button type="submit" class="btn btn--block">進入</button>
        </form>`);
    }
    const s = adminState;
    const voted = s.participants.filter((p) => p.hasVoted).length;
    const coming = s.participants.filter((p) => p.attending).length;
    const hints = ['朋友可以報名、上傳照片', '朋友可以投票，看不到票數', '所有人都看得到得獎照片和票數'];
    const phases = PHASES.map((label, i) => {
      const n = i + 1;
      const current = n === s.phase;
      return `<button type="button" class="btn ${current ? '' : 'btn--quiet'}" data-action="admin-phase" data-phase="${n}" aria-pressed="${current}">
        <span><strong>${n}. ${label}</strong>${current ? '（目前）' : ''}<br><small>${hints[i]}</small></span></button>`;
    }).join('');
    const photos = s.photos.map((p) => `
      <li>
        <button type="button" class="admin__thumb" data-action="open" data-id="${p.id}" data-name="${esc(p.ownerName)}" aria-label="看 ${esc(p.ownerName)} 的照片大圖">
          <img src="${thumbUrl(p.id)}" alt="" width="56" height="56" loading="lazy" decoding="async">
        </button>
        <span class="admin__main">${esc(p.ownerName)}<small>${p.votes} 票</small></span>
        <button type="button" class="btn btn--small ${p.favorite ? '' : 'btn--ghost'}" data-action="admin-favorite" data-id="${p.id}" aria-pressed="${p.favorite}">${p.favorite ? '★ 我們ㄉPick' : '☆ 選為我們ㄉPick'}</button>
      </li>`).join('');
    const people = s.participants.map((p) => `
      <li>
        <span class="admin__main">${esc(p.name)}
          <small>${p.attending ? '會到場' : '我不行QQ'}・${p.photoCount} 張・${p.hasVoted ? '已投票' : '還沒投票'}</small>
        </span>
        <button type="button" class="btn btn--small btn--quiet" data-action="admin-remove" data-id="${p.id}" data-name="${esc(p.name)}">移除</button>
      </li>`).join('');
    setHTML(body, `
      <div class="admin__top">
        <h1 id="admin-title">管理面板</h1>
        <button type="button" class="link-btn" data-action="admin-logout">登出</button>
      </div>
      <div class="admin__stats">
        <p><b>${s.participants.length}</b><span>報名</span></p>
        <p><b>${coming}</b><span>到場</span></p>
        <p><b>${s.photos.length}</b><span>照片</span></p>
        <p><b>${voted}</b><span>已投票</span></p>
      </div>
      <h2>活動階段</h2>
      <div class="admin__phases">${phases}</div>
      <h2>照片與即時票數</h2>
      ${photos ? `<ul class="admin__list" data-gallery>${photos}</ul>` : '<p class="muted">還沒有人上傳照片。</p>'}
      <h2>報名名單</h2>
      ${people ? `<ul class="admin__list">${people}</ul>` : '<p class="muted">還沒有人報名。</p>'}
      <p class="me__note"><a href="#">回活動頁</a>・這頁每 10 秒自動更新。看得到誰投了票，但看不到投給誰。</p>`);
  }

  async function adminCall(fn, args) {
    try {
      adminState = await rpc(fn, { p_token: adminToken, ...args });
      renderAdmin();
      refresh();
      return true;
    } catch (err) {
      toast(err.message);
      if (err.status === 401) refreshAdmin();
      return false;
    }
  }

  async function adminLogin(form) {
    const input = form.elements.password;
    const button = form.querySelector('button[type="submit"]');
    if (button.disabled) return;
    button.disabled = true;
    try {
      const data = await rpc('admin_login', { p_password: input.value });
      adminToken = data.token;
      store.set('pc_admin', adminToken);
      adminState = data.state;
      renderAdmin();
      $('admin-title').setAttribute('tabindex', '-1');
      $('admin-title').focus();
    } catch (err) {
      button.disabled = false;
      input.setAttribute('aria-invalid', 'true');
      $('a-pass-err').textContent = err.message;
      input.focus();
    }
  }

  // ---------- 事件 ----------

  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const { action, id } = el.dataset;
    switch (action) {
      case 'mode':
        mode = el.dataset.mode;
        $('join-error').textContent = '';
        renderJoin();
        break;
      case 'pick-name':
        mode = 'login';
        $('join-error').textContent = '';
        $('f-name').value = el.dataset.name;
        renderJoin();
        $('f-pin').focus();
        break;
      case 'toggle-pin': {
        const show = $('f-pin').type === 'password';
        $('f-pin').type = show ? 'text' : 'password';
        el.textContent = show ? '隱藏' : '顯示';
        el.setAttribute('aria-pressed', String(show));
        el.setAttribute('aria-label', show ? '隱藏密碼' : '顯示密碼');
        break;
      }
      case 'logout': logout(); break;
      case 'attend': setAttending(el.dataset.value === 'yes'); break;
      case 'pick': $('file-input').click(); break;
      case 'delete-photo': deletePhoto(id); break;
      case 'retry-upload': {
        const u = uploads.find((x) => String(x.key) === el.dataset.key);
        if (u) startUpload(u);
        break;
      }
      case 'cancel-upload': {
        const u = uploads.find((x) => String(x.key) === el.dataset.key);
        if (u) { dropUpload(u); render(); }
        break;
      }
      case 'open': openLightbox(el); break;
      case 'vote': vote(id); break;
      case 'lb-close': lightbox.close(); break;
      case 'lb-prev': stepLightbox(-1); break;
      case 'lb-next': stepLightbox(1); break;
      case 'admin-phase': {
        const phase = Number(el.dataset.phase);
        if (phase === adminState.phase) break;
        const warn = {
          1: '朋友可以再報名、換照片。已經投的票會保留。',
          2: '朋友就不能再報名或換照片了，開始投票。',
          3: '所有人馬上會看到得獎照片和票數。記得先選好「我們ㄉPick」。',
        }[phase];
        if (await confirmDialog(`切換到「${PHASES[phase - 1]}」？`, warn, '切換')) {
          if (await adminCall('admin_set_phase', { p_phase: phase })) toast(`已切換到「${PHASES[phase - 1]}」`);
        }
        break;
      }
      case 'admin-favorite':
        adminCall('admin_set_favorite', { p_photo_id: id, p_favorite: el.getAttribute('aria-pressed') !== 'true' });
        break;
      case 'admin-remove':
        if (await confirmDialog(`移除 ${el.dataset.name}？`, '這個人的照片和投出的票會一起刪除，無法復原。', '移除')) {
          if (await adminCall('admin_remove_participant', { p_id: id })) toast('已移除。');
        }
        break;
      case 'admin-logout':
        adminToken = null;
        adminState = null;
        store.del('pc_admin');
        renderAdmin();
        break;
    }
  });

  $('join-form').addEventListener('submit', submitJoin);
  document.addEventListener('submit', (e) => {
    if (e.target.id === 'admin-form') {
      e.preventDefault();
      adminLogin(e.target);
    }
  });

  $('file-input').addEventListener('change', (e) => {
    if (e.target.files.length) pickFiles(e.target.files);
    e.target.value = ''; // 讓同一張照片可以重選
  });

  // 鍵盤彈出時把輸入框捲到看得到的地方
  function keepVisible() {
    const el = document.activeElement;
    if (!el || el.tagName !== 'INPUT' || el.type === 'file' || el.type === 'radio') return;
    const vv = window.visualViewport;
    const height = vv ? vv.height : window.innerHeight;
    const rect = el.getBoundingClientRect();
    const top = (vv ? vv.offsetTop : 0) + 60;
    if (rect.top < top || rect.bottom > height - 16) {
      el.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
    }
  }
  document.addEventListener('focusin', () => setTimeout(keepVisible, 350));
  if (window.visualViewport) window.visualViewport.addEventListener('resize', keepVisible);

  // 照片還在傳的時候離開頁面，先提醒一下
  window.addEventListener('beforeunload', (e) => {
    if (uploads.some((u) => u.status !== 'error')) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  window.addEventListener('hashchange', showView);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });
  setInterval(() => {
    if (document.hidden) return;
    if (isAdminView()) {
      if (adminToken && !$('confirm').open) refreshAdmin();
    } else {
      refresh();
    }
  }, 10000);

  showView();
  refresh();
})();
