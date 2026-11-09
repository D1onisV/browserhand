// Chat window (toolbar popup). MV3 pages block inline scripts, so all UI logic lives here.

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const params = new URLSearchParams(location.search);
if (params.has('popup')) document.documentElement.classList.add('popup');

// Theme and language are cached in localStorage so they apply before the first paint.
// `?theme=` / `?lang=` preview a value without saving it.
function applyTheme(theme, save = true) {
  if (theme !== 'dark' && theme !== 'light') theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  if (save) localStorage.theme = theme;
}
applyTheme(params.get('theme') || localStorage.theme, !params.has('theme'));
setLanguage(params.get('lang') || localStorage.lang || 'en');

const MODELS = [
  ['session', null],
  ['claude-opus-5-5', 'Opus 5.5'],
  ['claude-sonnet-5-5', 'Sonnet 5.5'],
  ['claude-haiku-5-5', 'Haiku 5.5'],
  ['claude-fable-5-1', 'Fable 5.1'],
];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const modelName = (id) => (id === 'session' ? t('composer.session') : (MODELS.find(([m]) => m === id) || [, id])[1]);

const VIDEO_URL = /youtube\.com\/(watch|shorts|live)|youtu\.be\/|tiktok\.com\/.+\/video|vimeo\.com\/\d|instagram\.com\/(reel|p)\/|(twitter|x)\.com\/.+\/status|twitch\.tv\/videos|facebook\.com\/.*videos|dailymotion\.com\/video|\.(mp4|webm|mov|mkv|mp3|m4a|wav)(\?|$)/i;

const ICON = {
  route: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 3v5a2 2 0 0 0 2 2h7M10 7l3 3-3 3"/></svg>',
  tab: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2"/><path d="M2 6.5h12"/></svg>',
  x: '<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  globe: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c1.8 1.7 2.6 3.7 2.6 6S9.8 12.3 8 14M8 2C6.2 3.7 5.4 5.7 5.4 8s.8 4.3 2.6 6"/></svg>',
};

let state = { enabled: true, connected: false, listener: false, messages: [], queued: [], progress: null, usage: {} };
let prefs = { model: 'session', effort: 'medium', attachTab: true };

// prefs.model is "session:<chat name>" for a connected Claude Code chat, or a model id.
const isSession = (v) => String(v).startsWith('session');
// The chosen Claude Code chat, picked in the Chats list (older versions kept it in prefs.model as "session:<name>").
const sessionName = () => prefs.chat || '';
let images = [];      // pending pasted images: { data, thumb }
let activeTab = null; // { id, title, url, allowed, scriptable }

// ---------- formatting ----------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Minimal markdown: fenced code, inline code, bold, links. Input is escaped first.
function markdown(src) {
  return String(src).split(/```(?:[\w-]*)\n?([\s\S]*?)```/g).map((part, i) => {
    if (i % 2) return `<pre><code>${esc(part.replace(/\n$/, ''))}</code></pre>`;
    return renderLists(esc(part)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>'));
  }).join('');
}

// "- item" / "* item" / "1. item" lines become real lists.
function renderLists(html) {
  const out = [];
  let kind = null;
  for (const line of html.split('\n')) {
    const m = /^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/.exec(line);
    const k = m ? (m[1] ? 'ul' : 'ol') : null;
    if (k !== kind) {
      if (kind) out.push(`</${kind}>`);
      if (k) out.push(`<${k}>`);
      kind = k;
    }
    out.push(k ? `<li>${m[3]}</li>` : line + '\n');
  }
  if (kind) out.push(`</${kind}>`);
  return out.join('').replace(/\n+(<(?:ul|ol)>)/g, '$1').replace(/\n$/, '');
}

const clock = (ts) => new Date(ts).toLocaleTimeString(currentLang, { hour: '2-digit', minute: '2-digit' });

function duration(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min >= 1440) return `${t('time.d', { n: Math.floor(min / 1440) })} ${t('time.h', { n: Math.floor((min % 1440) / 60) })}`;
  if (min >= 60) return `${t('time.h', { n: Math.floor(min / 60) })} ${t('time.m', { n: min % 60 })}`;
  return t('time.m', { n: min });
}

function claudeText(m) {
  switch (m.kind) {
    case 'error': return t('chat.error', { detail: m.detail || m.text });
    case 'stopped': return t('chat.stopped');
    case 'no-answer': return t('chat.noAnswer', { detail: m.detail || '' });
    case 'start-failed': return t('chat.startFailed', { detail: m.detail || '' });
    default: return m.text;
  }
}

function progressText(p) {
  if (!p) return t('chat.working');
  if (p.code === 'reading') return t('progress.reading', { file: p.detail });
  if (p.code === 'tool') return p.detail;
  return t('progress.' + p.code);
}

// ---------- status & usage ----------

function renderStatus() {
  let cls = '';
  let tip;
  if (!state.enabled) { cls = 'off'; tip = t('status.off'); }
  else if (!state.connected) tip = t('status.noServer');
  else if (!isSession(prefs.model)) { cls = 'on'; tip = t('status.worker', { model: modelName(prefs.model) }); }
  else if (sessionName() ? sessionOnline(sessionName()) : state.listener) {
    cls = 'on';
    tip = sessionName() ? t('status.chatListening', { name: sessionName() }) : t('status.listening');
  } else {
    cls = 'wait';
    tip = sessionName() ? t('status.chatIdle', { name: sessionName() }) : t('status.idle');
  }
  $('dot').className = 'dot ' + cls;
  $('dot').title = tip;
  document.querySelector('.title').title = tip;
  $('enabled').checked = state.enabled !== false;
  renderUsage();
  renderUpdate();
}

const level = (pct) => (pct >= 95 ? 'max' : pct >= 80 ? 'hi' : '');

let usageError = null;

async function refreshUsage() {
  $('usageRefresh').classList.add('spin');
  const r = await send({ type: 'usage-refresh' });
  usageError = r && r.ok ? null : (r && r.error) || 'failed';
  if (r && r.ok) state = await send({ type: 'chat-get' });
  $('usageRefresh').classList.remove('spin');
  renderUsage();
}

function renderUsage() {
  const usage = state.usage || {};
  const rows = [
    ['five_hour', 'usage.session', 'usage.sessionSub'],
    ['seven_day', 'usage.week', 'usage.weekSub'],
  ].filter(([key]) => usage[key]);

  const worst = Math.max(0, ...rows.map(([key]) => usage[key].pct));
  $('usageBadge').hidden = worst < 80;
  $('usageBadge').className = 'badge ' + level(worst);

  $('usageRows').innerHTML = rows.length
    ? rows.map(([key, name, sub]) => {
      const w = usage[key];
      const reset = w.resetsAt ? ` · ${t('usage.resets', { t: duration(w.resetsAt - Date.now()) })}` : '';
      return `<div class="urow">
        <div class="top"><span class="name">${t(name)}</span><span class="pct">${t('usage.used', { p: w.pct })}</span></div>
        <div class="sub">${t(sub)}${reset}</div>
        <div class="bar-bg"><div class="bar-fg ${level(w.pct)}" style="width:${Math.min(100, w.pct)}%"></div></div>
      </div>`;
    }).join('')
    : `<div class="none">${t('usage.none')}</div>`;
  const foot = $('usageFoot');
  foot.hidden = !(usage.updatedAt || usageError);
  if (usageError === 'login') foot.innerHTML = t('usage.signIn', { link: '<a href="https://claude.ai" target="_blank" rel="noopener">claude.ai</a>' });
  else if (usageError) foot.textContent = t('usage.failed');
  else if (usage.updatedAt) foot.textContent = t('usage.updated', { t: clock(usage.updatedAt) }) + (usage.source === 'claude.ai' ? ' · claude.ai' : '');
}

// ---------- updates ----------

function renderUpdate() {
  const u = state.update || {};
  const show = u.available || ['running', 'done', 'error'].includes(u.state);
  $('updateRow').hidden = !show;
  $('menuBadge').hidden = !u.available || u.state === 'running';
  if (!show) return;
  const btn = $('updateBtn');
  btn.disabled = u.state === 'running' || u.state === 'done';
  btn.textContent = u.state === 'running' ? t('update.running')
    : u.state === 'done' ? t('update.done')
      : t('update.button', { v: u.latest });
  const note = $('updateNote');
  if (u.state === 'error') note.textContent = t('update.failed', { detail: u.detail });
  else if (u.state === 'running') note.textContent = u.detail || '';
  else if (u.page) note.innerHTML = `<a href="${esc(u.page)}" target="_blank" rel="noopener">${t('update.notes')}</a>`;
  else note.textContent = '';
}

// ---------- messages ----------

function renderMessages() {
  const list = $('list');
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  const all = [...state.messages, ...state.queued.map((q) => ({ ...q, from: 'user', status: 'queued' }))];

  list.innerHTML = all.length ? '' : `<div class="empty">${t('chat.empty')}<br>${t('chat.emptyHint')}</div>`;
  for (const m of all) {
    const el = document.createElement('div');
    const isNote = m.from === 'claude' && m.kind && m.kind !== 'reply';
    el.className = `msg ${m.from}${isNote ? ' note' : ''}`;

    let html = '';
    const thumbs = (m.images || []).filter((x) => x.thumb);
    if (thumbs.length) html += `<div class="imgs">${thumbs.map((x) => `<img src="${esc(x.thumb)}" alt="">`).join('')}</div>`;
    const text = m.from === 'claude' ? claudeText(m) : m.text;
    if (text) html += markdown(text);

    let meta = clock(m.at);
    if (m.from === 'user') meta += ' · ' + ({ queued: '⏳', sent: '✓', read: '✓✓' }[m.status] || '');
    else if (m.meta && m.meta.session) meta += ` · ${esc(m.meta.session)}`;
    else if (m.meta && m.meta.model && m.meta.model !== 'session') {
      meta += ` · ${modelName(m.meta.model)}`;
      if (m.meta.ms) meta += ` · ${t('time.s', { n: Math.round(m.meta.ms / 1000) })}`;
    }
    html += `<div class="meta">${meta}</div>`;
    el.innerHTML = html;
    list.appendChild(el);
  }

  const last = all[all.length - 1];
  if (nearBottom || (last && last.from === 'user')) {
    const pin = () => { list.scrollTop = list.scrollHeight; };
    pin();
    requestAnimationFrame(pin);
    for (const img of list.querySelectorAll('img')) img.decode().then(pin, () => {});
  }

  const working = !!state.progress || (last && last.from === 'user' && last.status === 'read');
  $('progress').hidden = !working;
  $('progressText').textContent = progressText(state.progress);
  $('stop').hidden = !(working && last && last.mode === 'worker');
}

// ---------- composer ----------

function renderComposer() {
  const input = $('input');
  $('suggest').hidden = !(activeTab && activeTab.allowed && VIDEO_URL.test(activeTab.url || '') && !input.value.trim());
  fillModelSelect();
  $('effort').value = prefs.effort;
  $('effort').hidden = isSession(prefs.model);
  input.placeholder = t('composer.placeholder');
  fitSelect($('model'));
  fitSelect($('effort'));
  fitSelect($('lang'));
  renderChatChip();

  const chip = $('tabChip');
  const usable = !!(activeTab && activeTab.scriptable && activeTab.allowed);
  chip.disabled = !usable;
  chip.classList.toggle('on', usable && prefs.attachTab);
  chip.innerHTML = ICON.tab + (activeTab ? `<span>${esc(activeTab.title || t('composer.tab'))}</span>` : '');
  chip.title = !activeTab ? ''
    : !activeTab.scriptable ? t('composer.tabSystem')
      : !activeTab.allowed ? t('composer.tabBlocked')
        : prefs.attachTab ? t('composer.tabOn') : t('composer.tabOff');

  const box = $('thumbs');
  box.innerHTML = '';
  images.forEach((img, i) => {
    const el = document.createElement('div');
    el.className = 'thumb';
    el.innerHTML = `<img src="${img.thumb}" alt=""><button title="${t('composer.remove')}" aria-label="${t('composer.remove')}">${ICON.x}</button>`;
    el.querySelector('button').onclick = () => { images.splice(i, 1); renderComposer(); updateSend(); };
    box.appendChild(el);
  });
}

const updateSend = () => { $('send').disabled = !($('input').value.trim() || images.length); };

function autosize() {
  const input = $('input');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
}

async function submit() {
  const text = $('input').value.trim();
  if (!text && !images.length) return;
  $('send').disabled = true;
  const worker = !isSession(prefs.model);
  const r = await send({
    type: 'chat-send',
    text,
    images,
    withTab: prefs.attachTab && !!(activeTab && activeTab.allowed && activeTab.scriptable),
    mode: worker ? 'worker' : 'session',
    target: worker ? undefined : sessionName() || undefined,
    model: worker ? prefs.model : undefined,
    effort: worker ? prefs.effort : undefined,
  });
  if (r && r.ok) {
    $('input').value = '';
    images = [];
    $('err').textContent = '';
    autosize();
    renderComposer();
  } else {
    $('err').textContent = r && r.error === 'disabled' ? t('composer.disabled') : t('composer.sendFailed');
  }
  updateSend();
  $('input').focus();
}

// ---------- images ----------

async function addImage(file) {
  if (!file || !file.type.startsWith('image/') || images.length >= 6) return;
  const bitmap = await createImageBitmap(file);
  const encode = (maxSide, quality) => {
    const k = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * k);
    canvas.height = Math.round(bitmap.height * k);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
  };
  images.push({ data: encode(1568, 0.85), thumb: encode(240, 0.7) });
  renderComposer();
  updateSend();
}

// ---------- tabs ----------

function favicon(url) {
  const placeholder = () => Object.assign(document.createElement('span'), { className: 'fav', innerHTML: ICON.globe });
  if (!url || !/^(https?|data):/.test(url)) return placeholder();
  const img = Object.assign(document.createElement('img'), { src: url, alt: '' });
  img.onerror = () => img.replaceWith(placeholder());
  return img;
}

async function renderTabs() {
  const { tabs, newTabs } = await send({ type: 'tabs-get' });
  $('newTabs').checked = newTabs;
  const usable = tabs.filter((tab) => tab.scriptable);
  $('tabsCount').textContent = `${usable.filter((tab) => tab.allowed).length}/${usable.length}`;
  const [current] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  activeTab = current ? tabs.find((tab) => tab.id === current.id) || null : null;
  renderComposer();

  const box = $('tabsList');
  box.innerHTML = '';
  for (const tab of tabs) {
    const row = document.createElement('div');
    row.className = 'trow' + (tab.allowed ? '' : ' off') + (tab.scriptable ? '' : ' sys');
    row.title = tab.scriptable ? tab.url : t('tabs.system');

    const toggle = Object.assign(document.createElement('input'), { type: 'checkbox', checked: tab.allowed && tab.scriptable, disabled: !tab.scriptable });
    toggle.onchange = async () => { await send({ type: 'tab-set', id: tab.id, allowed: toggle.checked }); renderTabs(); };

    const title = Object.assign(document.createElement('span'), { className: 't', textContent: tab.title || tab.url });
    title.onclick = () => { chrome.tabs.update(tab.id, { active: true }); chrome.windows.update(tab.windowId, { focused: true }); };

    row.append(toggle, favicon(tab.favIconUrl), title);
    if (current && tab.id === current.id) row.append(Object.assign(document.createElement('span'), { className: 'act', title: t('tabs.current') }));
    box.appendChild(row);
  }
}

let tabsTimer;
const refreshTabs = () => { clearTimeout(tabsTimer); tabsTimer = setTimeout(renderTabs, 120); };

// ---------- static UI ----------

const sessionOnline = (name) => (state.sessions || []).some((s) => s.name === name);

// The picker: "Claude Code chat" and the models. Which chat is chosen in the Chats list.
function fillModelSelect() {
  const names = (state.sessions || []).map((s) => s.name);
  if (isSession(prefs.model) && !prefs.chat && names.length) prefs.chat = names[names.length - 1];
  const entries = MODELS.map(([id]) => [id, modelName(id)]);
  const select = $('model');
  const html = entries.map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join('');
  if (select.dataset.html !== html) { select.innerHTML = html; select.dataset.html = html; }
  select.value = isSession(prefs.model) ? 'session' : prefs.model;
}

// A native select is as wide as its longest option; size it to the chosen one so the bar has no gaps.
const measure = document.createElement('canvas').getContext('2d');
function fitSelect(select) {
  if (select.hidden || select.selectedIndex < 0) return;
  const cs = getComputedStyle(select);
  measure.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const text = measure.measureText(select.options[select.selectedIndex].text).width;
  select.style.width = Math.ceil(text + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 2) + 'px';
}

// Where a message goes in Claude Code mode: the chosen chat, shown above the input.
function renderChatChip() {
  const chip = $('chatChip');
  chip.hidden = !isSession(prefs.model);
  if (chip.hidden) return;
  const name = sessionName();
  const online = !!name && sessionOnline(name);
  chip.classList.toggle('on', online);
  chip.classList.toggle('warn', !online);
  const label = !name ? t('composer.noChat') : online ? name : t('composer.chatOffline', { name });
  chip.innerHTML = ICON.route + `<span>${esc(label)}</span>`;
}

// Text to paste into another Claude Code chat; paths come from where BrowserHand is installed.
function connectText() {
  const cli = `node "${state.cli || 'host/bh.js'}"`;
  return [t('connect.pasteIntro'), '', `${cli} watch name="${t('connect.namePlaceholder')}"`, '', t('connect.pasteBody', { reply: `${cli} reply "…"`, help: `${cli} help` })].join('\n');
}

function fillSelects() {
  fillModelSelect();
  $('effort').innerHTML = EFFORTS.map((e) => `<option value="${e}">${t('effort.' + e)}</option>`).join('');
  $('lang').innerHTML = Object.entries(LANGUAGES).map(([code, name]) => `<option value="${code}">${name}</option>`).join('');
  $('lang').value = currentLang;
}

function renderTheme() {
  $('themeBtn').title = document.documentElement.dataset.theme === 'dark' ? t('theme.toLight') : t('theme.toDark');
  $('themeBtn').setAttribute('aria-label', $('themeBtn').title);
}

function renderAll() {
  translatePage();
  fillSelects();
  renderTheme();
  renderStatus();
  renderMessages();
  renderComposer();
}

// ---------- events ----------

const closePopovers = (except) => {
  for (const id of ['menu', 'usagePop', 'connectPop', 'threadsPop']) if (id !== except) $(id).hidden = true;
};
const savePrefs = () => chrome.storage.local.set({ prefs });

$('usageBtn').onclick = (e) => {
  e.stopPropagation();
  closePopovers('usagePop');
  $('usagePop').hidden = !$('usagePop').hidden;
  renderUsage();
  const age = Date.now() - ((state.usage && state.usage.updatedAt) || 0);
  if (!$('usagePop').hidden && age > 30000) refreshUsage();
};
$('usageRefresh').onclick = (e) => { e.stopPropagation(); refreshUsage(); };
$('menuBtn').onclick = (e) => { e.stopPropagation(); closePopovers('menu'); $('menu').hidden = !$('menu').hidden; };
document.addEventListener('click', (e) => {
  if (!$('menu').contains(e.target)) $('menu').hidden = true;
  if (!$('usagePop').contains(e.target)) $('usagePop').hidden = true;
  if (!$('connectPop').contains(e.target)) $('connectPop').hidden = true;
  if (!$('threadsPop').contains(e.target)) $('threadsPop').hidden = true;
});

$('themeBtn').onclick = () => { applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); renderTheme(); };
$('lang').onchange = (e) => {
  setLanguage(e.target.value);
  localStorage.lang = currentLang;
  chrome.storage.local.set({ lang: currentLang });
  renderAll();
  renderTabs();
};

$('enabled').onchange = (e) => chrome.storage.local.set({ enabled: e.target.checked });
$('newTabs').onchange = (e) => send({ type: 'tab-default', allowed: e.target.checked });
$('cookieReject').onchange = (e) => chrome.storage.local.set({ cookieReject: e.target.checked });
$('followTabs').onchange = (e) => chrome.storage.local.set({ followTabs: e.target.checked });
$('realInput').onchange = (e) => chrome.storage.local.set({ realInput: e.target.checked });
$('updateBtn').onclick = async (e) => {
  e.stopPropagation();
  const r = await send({ type: 'update-run' });
  if (!r || !r.ok) {
    $('updateNote').textContent = r && r.error === 'no-host' ? t('update.noHost') : t('update.failed', { detail: (r && r.error) || '' });
  }
};
$('connectChat').onclick = (e) => {
  e.stopPropagation();
  closePopovers('connectPop');
  $('connectSkill').hidden = !state.skill;
  $('connectText').textContent = connectText();
  $('copyConnect').textContent = t('connect.copy');
  $('connectPop').hidden = false;
};
$('copyConnect').onclick = async (e) => {
  e.stopPropagation();
  await navigator.clipboard.writeText($('connectText').textContent);
  $('copyConnect').textContent = t('connect.copied');
};
$('reloadAll').onclick = async () => {
  $('reloadAll').disabled = true;
  $('reloadAll').querySelector('span').textContent = t('menu.reloading');
  await send({ type: 'reload-all' }); // the window closes when the extension reloads
};

// ---------- conversations ----------

// Connected Claude Code chats; clicking one sends the next messages there.
function renderSessions() {
  const box = $('sessionList');
  const list = state.sessions || [];
  box.innerHTML = list.length ? '' : `<div class="none">${t('threads.noChats')}</div>`;
  for (const s of list) {
    const chosen = isSession(prefs.model) && prefs.chat === s.name;
    const row = document.createElement('div');
    row.className = 'thread' + (chosen ? ' on' : '');
    row.title = s.cwd || '';
    row.innerHTML = `<span class="live"></span><span class="th-title">${esc(s.name)}</span><span class="th-when">${chosen ? t('threads.chosen') : t('threads.choose')}</span>`;
    row.onclick = () => {
      prefs.model = 'session';
      prefs.chat = s.name;
      savePrefs();
      renderStatus();
      renderComposer();
      $('threadsPop').hidden = true;
      $('input').focus();
    };
    box.appendChild(row);
  }
}

function renderThreads() {
  renderSessions();
  const box = $('threadList');
  const list = state.threads || [];
  box.innerHTML = list.length ? '' : `<div class="none">${t('threads.empty')}</div>`;
  for (const th of list) {
    const title = th.title || t('threads.untitled');
    const sameDay = new Date(th.updatedAt).toDateString() === new Date().toDateString();
    const when = sameDay ? clock(th.updatedAt) : new Date(th.updatedAt).toLocaleDateString(currentLang, { day: 'numeric', month: 'short' });
    const row = document.createElement('div');
    row.className = 'thread' + (th.id === state.current ? ' on' : '');
    row.innerHTML = `<span class="th-title">${esc(title)}</span><span class="th-when">${when}</span>
      <button class="th-del" title="${t('threads.delete')}" aria-label="${t('threads.delete')}">${ICON.x}</button>`;
    row.onclick = async () => { await send({ type: 'thread-switch', id: th.id }); $('threadsPop').hidden = true; };
    row.querySelector('.th-del').onclick = async (e) => {
      e.stopPropagation();
      if (confirm(t('threads.deleteConfirm', { title }))) await send({ type: 'thread-delete', id: th.id });
    };
    box.appendChild(row);
  }
}

$('threadsBtn').onclick = (e) => {
  e.stopPropagation();
  closePopovers('threadsPop');
  renderThreads();
  $('threadsPop').hidden = !$('threadsPop').hidden;
};
$('threadNew').onclick = async (e) => {
  e.stopPropagation();
  await send({ type: 'thread-new' });
  $('threadsPop').hidden = true;
  $('input').focus();
};

$('tabsToggle').onclick = () => {
  const collapsed = $('tabsBox').classList.toggle('collapsed');
  localStorage.tabsOpen = collapsed ? '0' : '1';
};
if (localStorage.tabsOpen === '1') $('tabsBox').classList.remove('collapsed');
$('allOn').onclick = async () => { await send({ type: 'tab-set', id: 'all', allowed: true }); renderTabs(); };
$('allOff').onclick = async () => { await send({ type: 'tab-set', id: 'all', allowed: false }); renderTabs(); };
for (const ev of ['onCreated', 'onRemoved', 'onActivated', 'onMoved', 'onAttached']) chrome.tabs[ev].addListener(refreshTabs);
chrome.tabs.onUpdated.addListener((_id, change) => { if (change.title || change.url || change.favIconUrl) refreshTabs(); });
chrome.windows.onFocusChanged.addListener(refreshTabs);

$('model').onchange = (e) => { prefs.model = e.target.value; savePrefs(); renderStatus(); renderComposer(); };
$('effort').onchange = (e) => { prefs.effort = e.target.value; savePrefs(); fitSelect(e.target); };
$('tabChip').onclick = () => { prefs.attachTab = !prefs.attachTab; savePrefs(); renderComposer(); };
$('chatChip').onclick = (e) => { e.stopPropagation(); $('threadsBtn').click(); };

$('input').addEventListener('input', () => {
  autosize();
  updateSend();
  if ($('input').value.trim()) $('suggest').hidden = true;
});
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
});
$('send').onclick = submit;
$('stop').onclick = () => send({ type: 'chat-stop' });
$('sugVideo').onclick = () => {
  $('input').value = t('composer.videoPrompt');
  prefs.attachTab = true;
  savePrefs();
  autosize();
  updateSend();
  renderComposer();
  $('input').focus();
};

document.addEventListener('paste', (e) => {
  const files = [...((e.clipboardData && e.clipboardData.items) || [])]
    .filter((item) => item.type.startsWith('image/'))
    .map((item) => item.getAsFile());
  if (files.length) { e.preventDefault(); files.forEach(addImage); }
});
const composer = $('composer');
composer.addEventListener('dragover', (e) => { e.preventDefault(); composer.classList.add('drop'); });
composer.addEventListener('dragleave', () => composer.classList.remove('drop'));
composer.addEventListener('drop', (e) => { e.preventDefault(); composer.classList.remove('drop'); [...e.dataTransfer.files].forEach(addImage); });
$('attach').onclick = () => $('file').click();
$('file').onchange = (e) => { [...e.target.files].forEach(addImage); e.target.value = ''; };

// A chat that connects while the window is open gets a short notice.
let knownChats = null;
function announceNewChats() {
  const names = (state.sessions || []).map((s) => s.name);
  if (knownChats) {
    const added = names.filter((n) => !knownChats.includes(n));
    if (added.length) {
      const note = $('notice');
      note.textContent = added.length === 1 ? t('notice.chat', { name: added[0] }) : t('notice.chats', { names: added.join(', ') });
      note.hidden = false;
      clearTimeout(note.timer);
      note.timer = setTimeout(() => { note.hidden = true; }, 7000);
    }
  }
  knownChats = names;
}

chrome.runtime.onMessage.addListener((m) => {
  if (m && m.type === 'chat-event') {
    state = m.state;
    renderStatus();
    renderMessages();
    announceNewChats();
    if (!$('threadsPop').hidden) renderThreads();
  }
});

(async () => {
  const stored = await chrome.storage.local.get({ prefs, cookieReject: true, followTabs: true, realInput: false, lang: null });
  prefs = { ...prefs, ...stored.prefs };
  if (String(prefs.model).startsWith('session:')) { prefs.chat = prefs.model.slice(8); prefs.model = 'session'; }
  $('cookieReject').checked = stored.cookieReject;
  $('followTabs').checked = stored.followTabs;
  $('realInput').checked = stored.realInput;
  if (!params.has('lang') && stored.lang && stored.lang !== currentLang) {
    setLanguage(stored.lang);
    localStorage.lang = currentLang;
  }
  state = await send({ type: 'chat-get' });
  knownChats = (state.sessions || []).map((s) => s.name);
  renderAll();
  renderTabs();
  $('input').focus();
})();
