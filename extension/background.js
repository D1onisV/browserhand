// BrowserHand service worker: command registry, per-tab access, connection to the local host,
// and the chat relay between the popup and the host.

const VERSION = chrome.runtime.getManifest().version;
const DEFAULT_PORT = 17321;
const UPDATE_REPO = 'D1onisV/browserhand';

// ---------- commands ----------

const commands = {};

// Modules (modules/*.js) add their commands through this.
self.registerCommands = (table) => Object.assign(commands, table);

async function run(cmd, args) {
  const fn = commands[cmd];
  if (!fn) throw new Error(`unknown command "${cmd}". Available: ${Object.keys(commands).sort().join(' ')}`);
  return fn(args || {});
}

// ---------- per-tab access ----------
// Tab ids only live for one browser session, so choices go to storage.session.
// `newTabs` is the default for tabs the user hasn't decided on.

const access = { byTab: {}, newTabs: true };
const accessReady = Promise.all([
  chrome.storage.session.get({ access: {} }).then((s) => { access.byTab = s.access; }),
  chrome.storage.local.get({ newTabs: true }).then((s) => { access.newTabs = s.newTabs; }),
]);
const saveAccess = () => chrome.storage.session.set({ access: access.byTab });

self.canAccess = async (tabId) => {
  await accessReady;
  const v = access.byTab[tabId];
  return v === undefined ? access.newTabs : v;
};

self.setAccess = async (tabId, allowed) => {
  await accessReady;
  access.byTab[tabId] = !!allowed;
  await saveAccess();
};

self.assertAccess = async (tabId) => {
  if (!(await canAccess(tabId))) throw new Error(`no access to tab ${tabId}: the user turned it off`);
};

// A tab opened from an allowed tab (target=_blank links, popups) inherits its access.
chrome.tabs.onCreated.addListener(async (tab) => {
  await accessReady;
  if (access.byTab[tab.id] !== undefined || tab.openerTabId === undefined) return;
  if (access.byTab[tab.openerTabId] === undefined) return;
  access.byTab[tab.id] = await canAccess(tab.openerTabId);
  saveAccess();
});

chrome.tabs.onRemoved.addListener(async (id) => {
  await accessReady;
  if (id in access.byTab) { delete access.byTab[id]; saveAccess(); }
});

const ownUrl = chrome.runtime.getURL('');

async function tabList() {
  const tabs = (await chrome.tabs.query({})).filter((tab) => !(tab.url || '').startsWith(ownUrl));
  return Promise.all(tabs.map(async (tab) => ({
    id: tab.id,
    windowId: tab.windowId,
    title: tab.title,
    url: tab.url,
    favIconUrl: tab.favIconUrl,
    active: tab.active,
    allowed: await canAccess(tab.id),
    scriptable: /^(https?|file):/.test(tab.url || ''),
  })));
}

async function currentTab() {
  const candidates = [
    ...(await chrome.tabs.query({ active: true, lastFocusedWindow: true })),
    ...(await chrome.tabs.query({ active: true })),
  ];
  const tab = candidates.find((x) => !(x.url || '').startsWith(ownUrl));
  return tab && (await canAccess(tab.id)) ? { id: tab.id, title: tab.title, url: tab.url } : null;
}

importScripts('modules/control.js');

registerCommands({
  ping: async () => 'pong',
  help: async () => Object.keys(commands).sort().join(' '),
  sleep: async ({ ms = 500 }) => { await new Promise((r) => setTimeout(r, +ms)); return `slept ${ms}ms`; },

  // Several commands in one round trip: steps = [{ cmd, ...args }]; `tab` applies to all steps.
  batch: async ({ steps = [], tab, stopOnError = true }) => {
    const out = [];
    for (const { cmd, ...args } of steps) {
      if (tab !== undefined && args.tab === undefined) args.tab = tab;
      try { out.push({ cmd, ok: true, result: await run(cmd, args) }); }
      catch (e) { out.push({ cmd, ok: false, error: String(e.message || e) }); if (stopOnError) break; }
    }
    return out;
  },

  'plan-usage': async () => { chat.usage = await fetchUsage(); broadcastChat(); return chat.usage; },

  // Development helpers.
  'open-ui': async ({ theme, lang }) => {
    const q = new URLSearchParams({ popup: '1' });
    if (theme) q.set('theme', theme);
    if (lang) q.set('lang', lang);
    const tab = await chrome.tabs.create({ url: chrome.runtime.getURL('ui/chat.html?' + q) });
    return `tab ${tab.id}`;
  },
  'reload-ext': async () => { setTimeout(() => chrome.runtime.reload(), 100); return 'reloading extension'; },
  'reload-all': async () => { setTimeout(reloadAll, 100); return 'restarting the host and reloading the extension'; },
});

// ---------- connection to the host ----------

let socket = null;
let enabled = true;
let port = DEFAULT_PORT;
const isOpen = () => !!(socket && socket.readyState === WebSocket.OPEN);

chrome.storage.local.get({ enabled: true, hostPort: DEFAULT_PORT }).then((s) => {
  enabled = s.enabled;
  port = s.hostPort;
  connect();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.hostPort) { port = changes.hostPort.newValue || DEFAULT_PORT; if (socket) socket.close(); }
  if (changes.enabled) {
    enabled = changes.enabled.newValue;
    if (!enabled && socket) { socket.close(); socket = null; }
  }
  if (changes.enabled || changes.hostPort) { connect(); updateBadge(); broadcastChat(); }
});

function updateBadge() {
  const text = !enabled ? 'OFF' : update.available ? 'NEW' : isOpen() ? 'ON' : '';
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: isOpen() ? '#0f766e' : '#6b7280' });
}

function connect() {
  if (!enabled) return updateBadge();
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  let ws;
  try { ws = new WebSocket(`ws://127.0.0.1:${port}/ext`); } catch { return; }
  socket = ws;

  ws.onopen = () => {
    lastPong = Date.now();
    ws.send(JSON.stringify({ hello: true, version: VERSION }));
    flushQueue();
    updateBadge();
    broadcastChat();
  };

  ws.onmessage = async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === 'pong') { lastPong = Date.now(); return; }
    if (msg.type && (msg.type.startsWith('chat-') || msg.type === 'update-status')) return onChatFrame(msg);
    if (!msg.id) return;
    let reply;
    try { reply = { id: msg.id, ok: true, result: await run(msg.cmd, msg.args) }; }
    catch (e) { reply = { id: msg.id, ok: false, error: String((e && e.message) || e) }; }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
  };

  ws.onclose = () => {
    if (update.reloadOnClose) return chrome.runtime.reload();
    if (socket === ws) socket = null;
    chat.listener = false;
    chat.sessions = [];
    updateBadge();
    broadcastChat();
    if (enabled) setTimeout(connect, 2000);
  };
}

// A WebSocket keeps the service worker alive; the alarm wakes it up to reconnect.
// The host answers every ping; a silent connection is dropped and opened again.
let lastPong = 0;
setInterval(() => {
  if (!isOpen()) return;
  if (Date.now() - lastPong > 25000) { socket.close(); return; }
  socket.send('{"ping":1}');
}, 10000);
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

// ---------- chat relay ----------

const MAX_MESSAGES = 300;
const chat = { messages: [], listener: false, queued: [], progress: null, usage: {}, sessions: [], cli: '', skill: false, threads: [], current: null };
chrome.storage.local.get({ chatQueue: [] }).then((s) => { chat.queued = s.chatQueue; });

const chatState = () => ({
  enabled,
  connected: isOpen(),
  listener: chat.listener,
  sessions: chat.sessions,
  cli: chat.cli,
  skill: chat.skill,
  threads: chat.threads,
  current: chat.current,
  messages: chat.messages,
  queued: chat.queued,
  progress: chat.progress,
  usage: chat.usage,
  update,
});
const broadcastChat = () => chrome.runtime.sendMessage({ type: 'chat-event', state: chatState() }).catch(() => {});

function onChatFrame(msg) {
  switch (msg.type) {
    case 'chat-sync':
      chat.messages = msg.messages || [];
      chat.listener = !!msg.listener;
      chat.sessions = msg.sessions || [];
      chat.cli = msg.cli || chat.cli;
      chat.skill = !!msg.skill;
      chat.threads = msg.threads || [];
      chat.current = msg.current || null;
      chat.usage = newerUsage(chat.usage, msg.usage);
      chat.progress = msg.progress || null;
      break;
    case 'chat-msg': if (!msg.msg.thread || msg.msg.thread === chat.current) chat.messages.push(msg.msg); break;
    case 'chat-threads': chat.threads = msg.threads || []; chat.current = msg.current || chat.current; break;
    case 'chat-status': {
      const m = chat.messages.find((x) => x.id === msg.id);
      if (m) m.status = msg.status;
      break;
    }
    case 'chat-listener': chat.listener = !!msg.on; break;
    case 'chat-sessions': chat.sessions = msg.sessions || []; break;
    case 'chat-progress': chat.progress = msg.progress || null; break;
    case 'chat-usage': chat.usage = newerUsage(chat.usage, msg.usage); break;
    case 'update-status': onUpdateStatus(msg); break;
  }
  if (chat.messages.length > MAX_MESSAGES) chat.messages.splice(0, chat.messages.length - MAX_MESSAGES);
  broadcastChat();
}

function flushQueue() {
  if (!isOpen() || !chat.queued.length) return;
  for (const item of chat.queued) socket.send(JSON.stringify({ type: 'chat-send', ...item }));
  chat.queued = [];
  chrome.storage.local.set({ chatQueue: [] });
}

async function sendChat(msg) {
  if (!enabled) return { ok: false, error: 'disabled' };
  const item = {
    text: msg.text,
    tab: msg.withTab ? await currentTab() : null,
    images: msg.images,
    mode: msg.mode,
    target: msg.target,
    model: msg.model,
    effort: msg.effort,
  };
  if (isOpen()) {
    socket.send(JSON.stringify({ type: 'chat-send', ...item }));
  } else {
    chat.queued.push({ ...item, at: Date.now() });
    await chrome.storage.local.set({ chatQueue: chat.queued });
    broadcastChat();
  }
  return { ok: true };
}

// "Reload extension": restart the local host, then reload the extension. Applies changed files
// and clears a stuck state; connected chats reconnect by themselves.
function reloadAll() {
  if (isOpen()) socket.send('{"type":"host-restart"}');
  setTimeout(() => chrome.runtime.reload(), 700);
}

function sendToHost(msg) {
  if (!isOpen()) return { ok: false, error: 'no-host' };
  socket.send(JSON.stringify(msg));
  return { ok: true };
}

const popupHandlers = {
  'chat-get': () => chatState(),
  'update-check': async () => { await checkForUpdate(true); return { ok: true }; },
  'update-run': () => {
    if (!isOpen()) return { ok: false, error: 'no-host' };
    update.state = 'running';
    update.detail = '';
    socket.send('{"type":"update-run"}');
    broadcastChat();
    return { ok: true };
  },
  'usage-refresh': async () => {
    try { chat.usage = await fetchUsage(); broadcastChat(); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  },
  'chat-send': sendChat,
  'chat-stop': () => { if (isOpen()) socket.send('{"type":"chat-stop"}'); return { ok: true }; },
  'reload-all': () => { reloadAll(); return { ok: true }; },
  'thread-new': () => sendToHost({ type: 'thread-new' }),
  'thread-switch': ({ id }) => sendToHost({ type: 'thread-switch', id }),
  'thread-delete': ({ id }) => sendToHost({ type: 'thread-delete', id }),
  'chat-clear': async () => {
    chat.queued = [];
    await chrome.storage.local.set({ chatQueue: [] });
    if (isOpen()) socket.send('{"type":"chat-clear"}');
    else { chat.messages = []; broadcastChat(); }
    return { ok: true };
  },
  'tabs-get': async () => { await accessReady; return { tabs: await tabList(), newTabs: access.newTabs }; },
  'tab-set': async ({ id, allowed }) => {
    const ids = id === 'all' ? (await tabList()).map((tab) => tab.id) : [id];
    await accessReady;
    for (const tabId of ids) access.byTab[tabId] = !!allowed;
    await saveAccess();
    return { ok: true };
  },
  'tab-default': async ({ allowed }) => {
    access.newTabs = !!allowed;
    await chrome.storage.local.set({ newTabs: access.newTabs });
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const handler = msg && popupHandlers[msg.type];
  if (!handler) return;
  Promise.resolve(handler(msg)).then(reply, (e) => reply({ ok: false, error: String(e.message || e) }));
  return true;
});

// ---------- plan usage ----------
// Read from claude.ai with the browser's existing sign-in (read-only). The host also reports
// limits from Claude Code runs; whichever is newer wins.

const newerUsage = (a, b) => (((b && b.updatedAt) || 0) >= ((a && a.updatedAt) || 0) ? b || {} : a);

async function claudeApi(path) {
  const r = await fetch('https://claude.ai' + path, { credentials: 'include', headers: { accept: 'application/json' } });
  if (r.status === 401 || r.status === 403) throw new Error('login');
  if (!r.ok) throw new Error('http ' + r.status);
  return r.json();
}

async function fetchUsage() {
  let { claudeOrg } = await chrome.storage.local.get({ claudeOrg: null });
  if (!claudeOrg) {
    const orgs = await claudeApi('/api/organizations');
    const org = Array.isArray(orgs) && (orgs.find((o) => (o.capabilities || []).includes('chat')) || orgs[0]);
    if (!org) throw new Error('login');
    claudeOrg = org.uuid;
    await chrome.storage.local.set({ claudeOrg });
  }
  let usage;
  try {
    usage = await claudeApi(`/api/organizations/${claudeOrg}/usage`);
  } catch (e) {
    await chrome.storage.local.remove('claudeOrg');
    throw e;
  }
  const window = (w) => (w && Number.isFinite(w.utilization)
    ? { pct: Math.round(w.utilization), resetsAt: w.resets_at ? Date.parse(w.resets_at) : null }
    : undefined);
  return { five_hour: window(usage.five_hour), seven_day: window(usage.seven_day), updatedAt: Date.now(), source: 'claude.ai' };
}

// ---------- updates ----------
// Once a day the extension asks GitHub for the latest release; the host does the actual update
// (download, replace files, keep user data), then the extension reloads itself.

const update = { latest: null, available: false, page: null, state: null, detail: '' };

const isNewer = (a, b) => {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

async function checkForUpdate(force = false) {
  const { updateInfo } = await chrome.storage.local.get({ updateInfo: null });
  if (updateInfo) Object.assign(update, { latest: updateInfo.latest, page: updateInfo.page });
  if (force || !updateInfo || Date.now() - updateInfo.checkedAt > 24 * 3600e3) {
    try {
      const r = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json' } });
      if (r.ok) {
        const release = await r.json();
        update.latest = String(release.tag_name || '').replace(/^v/, '');
        update.page = release.html_url;
        await chrome.storage.local.set({ updateInfo: { latest: update.latest, page: update.page, checkedAt: Date.now() } });
      }
    } catch { /* offline: try again next time */ }
  }
  update.available = !!update.latest && isNewer(update.latest, VERSION);
  updateBadge();
  broadcastChat();
}

function onUpdateStatus(msg) {
  update.state = msg.state;
  update.detail = msg.detail || '';
  // Reload once the old host has closed the connection, so the new code connects to the new host.
  if (msg.state === 'done') {
    update.reloadOnClose = true;
    setTimeout(() => chrome.runtime.reload(), 8000); // in case the close never comes
  }
  if (msg.state === 'current') update.available = false;
}

chrome.alarms.create('update-check', { periodInMinutes: 360 });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === 'update-check') checkForUpdate(); });
checkForUpdate();
