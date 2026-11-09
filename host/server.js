// BrowserHand host: connects the extension (WebSocket) with local clients (HTTP, see bh.js).
// Listens on 127.0.0.1 only.
//
// Chat messages typed in the extension are handled in one of two modes:
//   session  streamed to a Claude Code session that runs `node host/bh.js watch`
//   worker   the host runs a headless `claude -p` with the chosen model and effort;
//            one conversation, resumed between messages, reset by "New chat".

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const updater = require('./update');
const skill = require('./skill');

const HOST_DIR = __dirname;
const ROOT = path.resolve(HOST_DIR, '..');
const DATA = path.join(HOST_DIR, 'data');
const SHOTS = path.join(DATA, 'shots');
const UPLOADS = path.join(DATA, 'uploads');
const CHAT_FILE = path.join(DATA, 'chat.jsonl');
const STATE_FILE = path.join(DATA, 'state.json');
const TOKEN_FILE = path.join(DATA, '.token');
const PROMPT_FILE = path.join(HOST_DIR, 'worker-prompt.md');
for (const dir of [DATA, SHOTS, UPLOADS]) fs.mkdirSync(dir, { recursive: true });

const config = readJson(path.join(HOST_DIR, 'config.json'), {});
const PORT = +process.env.BH_PORT || config.port || 17321;
// IDs of extensions allowed to connect. The first one is the ID pinned by the manifest key.
const EXTENSION_IDS = config.extensionIds || ['cdphdaidboienlcjeenkbmccgfokadjp'];
const CLAUDE = process.env.CLAUDE_BIN || config.claudeBin || findClaude();
const MAX_CHAT = 5000;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function findClaude() {
  const win = process.platform === 'win32';
  const guesses = win
    ? [path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')]
    : [path.join(process.env.HOME || '', '.local', 'bin', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude'];
  return guesses.find((g) => fs.existsSync(g)) || (win ? 'claude.cmd' : 'claude');
}

let token = (() => { try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { return ''; } })();
if (!token) {
  token = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
}

const state = { workerSession: null, usage: {}, ...readJson(STATE_FILE, {}) };
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));

let extension = null;
let extensionInfo = null;
let nextId = 0;
const pending = new Map();

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};
const toExtension = (msg) => { if (extension && extension.readyState === 1) extension.send(JSON.stringify(msg)); };
const readBody = async (req) => { let body = ''; for await (const chunk of req) body += chunk; return JSON.parse(body || '{}'); };

function keepNewest(dir, count) {
  const files = fs.readdirSync(dir).sort();
  for (const f of files.slice(0, Math.max(0, files.length - count))) fs.rmSync(path.join(dir, f), { force: true });
}

function saveDataUrl(dir, prefix, dataUrl) {
  const m = /^data:image\/(\w+);base64,(.*)$/s.exec(dataUrl || '');
  if (!m) return null;
  const file = path.join(dir, `${prefix}-${Date.now()}-${crypto.randomBytes(2).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
  fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
  return file;
}

// ---------- usage limits ----------

function setUsage(kind, pct, resetsAt) {
  if (!Number.isFinite(pct)) return;
  state.usage[kind] = { pct: Math.round(pct), resetsAt: resetsAt || null };
  state.usage.updatedAt = Date.now();
  saveState();
  toExtension({ type: 'chat-usage', usage: state.usage });
}

// ---------- chat ----------

const chat = [];
for (const line of (() => { try { return fs.readFileSync(CHAT_FILE, 'utf8').split('\n'); } catch { return []; } })()) {
  if (!line.trim()) continue;
  try {
    const m = JSON.parse(line);
    const i = chat.findIndex((x) => x.id === m.id);
    if (i >= 0) chat[i] = m; else chat.push(m);
  } catch { /* skip a damaged line */ }
}
const persist = (m) => fs.appendFileSync(CHAT_FILE, JSON.stringify(m) + '\n');

// ---------- conversations ----------
// Every message belongs to a conversation. "New chat" starts another one; the old ones stay and
// can be opened again. Each keeps its own background Claude Code conversation.

state.threads = state.threads || {};
const titleOf = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 60);

for (const m of chat) {
  if (!m.thread) m.thread = 'main';
  const t = state.threads[m.thread] || (state.threads[m.thread] = { id: m.thread, title: '', createdAt: m.at, updatedAt: m.at, workerSession: null });
  t.updatedAt = Math.max(t.updatedAt || 0, m.at || 0);
  if (!t.title && m.from === 'user') t.title = titleOf(m.text);
}
if (state.workerSession && state.threads.main && !state.threads.main.workerSession) state.threads.main.workerSession = state.workerSession;
delete state.workerSession;

function newThread() {
  const id = crypto.randomBytes(4).toString('hex');
  state.threads[id] = { id, title: '', createdAt: Date.now(), updatedAt: Date.now(), workerSession: null };
  state.currentThread = id;
  saveState();
}

const latestThread = () => Object.values(state.threads).sort((a, b) => b.updatedAt - a.updatedAt)[0];
if (!state.threads[state.currentThread]) {
  const latest = latestThread();
  if (latest) state.currentThread = latest.id; else newThread();
}
saveState();

const currentMessages = () => chat.filter((m) => m.thread === state.currentThread);
const threadList = () => Object.values(state.threads)
  .map((t) => ({ id: t.id, title: t.title, updatedAt: t.updatedAt }))
  .sort((a, b) => b.updatedAt - a.updatedAt);
const sendThreads = () => toExtension({ type: 'chat-threads', threads: threadList(), current: state.currentThread });

function touchThread(m) {
  const t = state.threads[m.thread];
  if (!t) return;
  t.updatedAt = m.at;
  if (!t.title && m.from === 'user') t.title = titleOf(m.text);
  saveState();
}

function rewriteChatFile() {
  fs.writeFileSync(CHAT_FILE, chat.map((m) => JSON.stringify(m) + '\n').join(''));
}
const watchers = new Map(); // response -> { res, name, cwd }
const listening = () => watchers.size > 0;

function setStatus(m, status) {
  m.status = status;
  persist(m);
  toExtension({ type: 'chat-status', id: m.id, status });
}

function addUserMessage({ text, tab, images, mode, target, model, effort }) {
  const id = crypto.randomBytes(4).toString('hex');
  const saved = (images || []).slice(0, 6)
    .map((img) => ({ file: saveDataUrl(UPLOADS, 'img', img.data), thumb: img.thumb || null }))
    .filter((img) => img.file);
  if (saved.length) keepNewest(UPLOADS, 200);
  const m = {
    id, from: 'user', text: String(text || ''), tab: tab || null, images: saved,
    mode: mode === 'worker' ? 'worker' : 'session', target: target || null, model, effort,
    at: Date.now(), status: 'sent', thread: state.currentThread,
  };
  push(m);
  if (m.mode === 'worker') enqueue(m); else deliver();
}

// kind: reply | error | stopped | no-answer | start-failed
function addClaudeMessage(kind, text, extra = {}) {
  push({ id: crypto.randomBytes(4).toString('hex'), from: 'claude', kind, text: String(text || ''), at: Date.now(), thread: state.currentThread, ...extra });
}

function push(m) {
  chat.push(m);
  if (chat.length > MAX_CHAT) chat.shift();
  persist(m);
  touchThread(m);
  toExtension({ type: 'chat-msg', msg: m });
  sendThreads();
}

// A session-mode message goes to the chat it is addressed to (by name); without a target,
// to the most recently connected chat. A message for a chat that isn't connected waits.
let lastDelivered = null; // name of the chat that got the latest message
let lastDeliveredThread = null;

// A reply is labelled with the sender's name if that chat is listening, otherwise with the chat
// that received the latest message (a chat connected with name=... that replies without it).
const replyName = (name) => ([...watchers.values()].some((w) => w.name === name) ? name : lastDelivered || name || null);

function watcherFor(target) {
  const all = [...watchers.values()];
  if (!target) return all[all.length - 1] || null;
  return all.filter((w) => w.name === target).pop() || null;
}

function deliver() {
  if (!listening()) return;
  for (const m of chat) {
    if (m.from !== 'user' || m.mode !== 'session' || m.status !== 'sent') continue;
    const w = watcherFor(m.target);
    if (!w) continue;
    w.res.write(JSON.stringify({ id: m.id, text: m.text, tab: m.tab, images: m.images.map((x) => x.file), at: m.at }) + '\n');
    lastDelivered = w.name;
    lastDeliveredThread = m.thread;
    setStatus(m, 'read');
  }
}

function sessionList() {
  const byName = new Map();
  for (const w of watchers.values()) byName.set(w.name, { name: w.name, cwd: w.cwd });
  return [...byName.values()];
}

const sendListener = () => {
  toExtension({ type: 'chat-listener', on: listening() });
  toExtension({ type: 'chat-sessions', sessions: sessionList() });
};
const progress = (code, detail) => toExtension({ type: 'chat-progress', progress: code ? { code, detail } : null });

// ---------- worker: headless Claude Code ----------

const worker = { proc: null, queue: [], current: null, stopped: false };

function enqueue(m) { worker.queue.push(m); runNext(); }

function promptFor(m) {
  let p = m.text;
  if (m.tab) p += `\n\n[Current tab: tab ${m.tab.id}: ${m.tab.title} — ${m.tab.url}]`;
  if (m.images.length) p += `\n\n[The user attached images. Look at them with Read:\n${m.images.map((x) => x.file).join('\n')}]`;
  return p;
}

function toolProgress(tool) {
  if (tool.name === 'Read') return ['reading', path.basename(String((tool.input && tool.input.file_path) || ''))];
  const cmd = String((tool.input && tool.input.command) || '');
  const m = /bh\.js\s+(\S+)(.*)/.exec(cmd);
  return ['tool', m ? `${m[1]} ${m[2].trim().slice(0, 40)}`.trim() : cmd.slice(0, 50)];
}

function runNext() {
  if (worker.proc || !worker.queue.length) return;
  const m = worker.queue.shift();
  worker.current = m;
  worker.stopped = false;
  setStatus(m, 'read');
  progress('starting');
  start(m, (state.threads[m.thread] || {}).workerSession || null);
}

function start(m, resume) {
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--model', m.model || 'claude-sonnet-5-5', '--effort', m.effort || 'medium',
    '--strict-mcp-config', '--setting-sources', 'project',
    '--tools', 'Bash,Read',
    // Only the browser CLI and reading BrowserHand's own files (screenshots, pasted images, media).
    // No direct ffmpeg/yt-dlp: yt-dlp --exec would run any command a web page talked the model into.
    '--allowedTools', 'Bash(node host/bh.js:*)', 'Read(./host/data/**)',
    '--append-system-prompt-file', PROMPT_FILE,
  ];
  if (resume) args.push('--resume', resume);

  let proc;
  try { proc = spawn(CLAUDE, args, { cwd: ROOT, windowsHide: true }); } catch (e) { return finish(m, 'start-failed', '', { detail: e.message }); }
  worker.proc = proc;

  const startedAt = Date.now();
  let buffer = '';
  let stderr = '';
  let result = null;
  let initialized = false;

  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.type === 'system' && e.subtype === 'init') {
        initialized = true;
        if (state.threads[m.thread]) state.threads[m.thread].workerSession = e.session_id;
        saveState();
        progress('thinking');
      } else if (e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
        const tools = e.message.content.filter((x) => x.type === 'tool_use');
        if (tools.length) progress(...toolProgress(tools[tools.length - 1]));
        else if (e.message.content.some((x) => x.type === 'text')) progress('writing');
      } else if (e.type === 'rate_limit_event' && e.rate_limit_info) {
        const r = e.rate_limit_info;
        setUsage(r.rateLimitType || 'five_hour', (r.utilization || 0) * 100, r.resetsAt ? r.resetsAt * 1000 : null);
      } else if (e.type === 'result') {
        result = e;
      }
    }
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  proc.on('error', (e) => { stderr += e.message; });
  proc.on('close', () => {
    worker.proc = null;
    if (worker.stopped) return finish(m, 'stopped');
    // The saved conversation is gone: start a fresh one once.
    if (!result && resume && !initialized) {
      if (state.threads[m.thread]) state.threads[m.thread].workerSession = null;
      saveState();
      return start(m, null);
    }
    if (!result) return finish(m, 'no-answer', '', { detail: stderr.trim().slice(-400) });
    const meta = { model: m.model, effort: m.effort, ms: Date.now() - startedAt, cost: result.total_cost_usd };
    if (result.is_error) return finish(m, 'error', '', { detail: result.result || result.subtype, meta });
    finish(m, 'reply', result.result || '', { meta });
  });
  proc.stdin.end(promptFor(m));
}

function finish(m, kind, text = '', extra = {}) {
  worker.current = null;
  progress(null);
  addClaudeMessage(kind, text, { replyTo: m.id, thread: m.thread, ...extra });
  runNext();
}

function stopWorker() {
  worker.queue = [];
  if (worker.proc) { worker.stopped = true; worker.proc.kill(); }
}

// "New chat": keep the old conversation; an empty current one is reused.
function startThread() {
  if (currentMessages().length) newThread();
  toExtension(syncFrame());
}

function switchThread(id) {
  if (state.threads[id]) { state.currentThread = id; saveState(); }
  toExtension(syncFrame());
}

function deleteThread(id) {
  if (!state.threads[id]) return;
  if (worker.current && worker.current.thread === id) stopWorker();
  for (let i = chat.length - 1; i >= 0; i--) if (chat[i].thread === id) chat.splice(i, 1);
  delete state.threads[id];
  rewriteChatFile();
  if (state.currentThread === id) {
    const next = latestThread();
    if (next) state.currentThread = next.id; else newThread();
  }
  saveState();
  toExtension(syncFrame());
}

const syncFrame = () => ({
  type: 'chat-sync',
  messages: currentMessages().slice(-200),
  threads: threadList(),
  current: state.currentThread,
  listener: listening(),
  sessions: sessionList(),
  cli: path.join(HOST_DIR, 'bh.js'),
  skill: skill.isInstalled(),
  usage: state.usage,
  progress: worker.current ? { code: 'thinking' } : null,
});

// Screenshots come from the extension as data URLs; clients get file paths.
function replaceDataUrls(value) {
  if (!value || typeof value !== 'object') return value;
  if (typeof value.dataUrl === 'string') {
    const file = saveDataUrl(SHOTS, 'shot', value.dataUrl);
    if (file) { keepNewest(SHOTS, 100); return { file }; }
  }
  if (Array.isArray(value)) return value.map(replaceDataUrls);
  for (const k of Object.keys(value)) value[k] = replaceDataUrls(value[k]);
  return value;
}

// ---------- self-update ----------
// Replaces the files with the latest release, then reloads the extension and restarts the host.

let updating = false;

async function runUpdate() {
  if (updating) return { ok: false, error: 'an update is already running' };
  updating = true;
  const status = (state, detail) => toExtension({ type: 'update-status', state, detail });
  status('running');
  try {
    const r = await updater.update({ log: (line) => status('running', line) });
    if (!r.updated) { status('current', r.installed); return { ok: true, result: `already up to date (${r.installed})` }; }
    status('done', r.installed);
    setTimeout(restart, 800);
    return { ok: true, result: `updated to ${r.installed}` };
  } catch (e) {
    status('error', e.message);
    return { ok: false, error: e.message };
  } finally {
    updating = false;
  }
}

// Refuse new connections, drop the current ones, start the new copy (it waits for the port), exit.
let restarting = false;

function restart() {
  restarting = true;
  for (const client of wss.clients) client.terminate();
  wss.close();
  server.close();
  spawn(process.execPath, [path.join(HOST_DIR, 'server.js')], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  setTimeout(() => process.exit(0), 200);
}

// ---------- HTTP API for local clients ----------

const routes = {
  'GET /status': () => ({ ok: true, extension: !!extension, info: extensionInfo, listening: listening(), worker: !!worker.proc }),

  'GET /sessions': () => ({ ok: true, result: [...watchers.values()].map((w) => ({ name: w.name, cwd: w.cwd })) }),

  'GET /chat': (req, url) => ({ ok: true, result: chat.slice(-(+url.searchParams.get('n') || 20)) }),

  'POST /reply': async (req) => {
    const { text, name } = await readBody(req);
    if (!text) return { ok: false, error: 'text required' };
    progress(null);
    const thread = state.threads[lastDeliveredThread] ? lastDeliveredThread : state.currentThread;
    addClaudeMessage('reply', text, { thread, meta: { model: 'session', session: replyName(name) } });
    return { ok: true, result: 'sent' };
  },

  'POST /progress': async (req) => {
    const { text } = await readBody(req);
    progress(text ? 'tool' : null, text);
    return { ok: true, result: 'ok' };
  },

  // Plan limits reported by a session (as shown on the Claude usage page).
  'POST /usage': async (req) => {
    const { windows = [] } = await readBody(req);
    for (const w of windows) {
      const kind = /5-hour|five/i.test(w.label) ? 'five_hour' : /week/i.test(w.label) ? 'seven_day' : null;
      if (kind) setUsage(kind, w.percentUsed, w.resetsAt ? Date.parse(w.resetsAt) : null);
    }
    return { ok: true, result: state.usage };
  },

  'GET /update': async () => {
    const r = await updater.check();
    return { ok: true, result: { installed: r.installed, latest: r.latest, available: r.available, page: r.page } };
  },

  'POST /update': () => runUpdate(),

  'POST /cmd': async (req) => {
    const { cmd, args = {} } = await readBody(req);
    if (!extension) return { ok: false, error: 'extension not connected' };
    const id = ++nextId;
    const timeout = (+args.timeout || 0) + 30000;
    const r = await new Promise((resolve) => {
      const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: `timeout after ${timeout}ms` }); }, timeout);
      pending.set(id, { resolve, timer });
      extension.send(JSON.stringify({ id, cmd, args }));
    });
    if (r.ok) r.result = replaceDataUrls(r.result);
    return r;
  },
};

const server = http.createServer(async (req, res) => {
  // Local clients only: exact Host (blocks DNS rebinding), no browser Origin, valid token.
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host || '')) return json(res, 403, { ok: false, error: 'bad host' });
  if (req.headers.origin) return json(res, 403, { ok: false, error: 'browser origins are not allowed' });
  if (req.headers['x-bh-token'] !== token) return json(res, 401, { ok: false, error: 'bad token' });

  const url = new URL(req.url, 'http://localhost');

  // Long-lived stream of session-mode chat messages, one JSON object per line.
  if (req.method === 'GET' && url.pathname === '/watch') {
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache' });
    res.write('{"hello":true}\n');
    const cwd = url.searchParams.get('cwd') || '';
    const name = (url.searchParams.get('name') || path.basename(cwd) || 'session').slice(0, 60);
    watchers.set(res, { res, name, cwd });
    const keepalive = setInterval(() => res.write('\n'), 15000);
    req.on('close', () => { clearInterval(keepalive); watchers.delete(res); sendListener(); });
    sendListener();
    deliver();
    return;
  }

  const route = routes[`${req.method} ${url.pathname}`];
  if (!route) return json(res, 404, { ok: false, error: 'not found' });
  try {
    const body = await route(req, url);
    json(res, body.ok === false && body.error === 'text required' ? 400 : 200, body);
  } catch (e) {
    json(res, 400, { ok: false, error: e.message });
  }
});

// ---------- WebSocket for the extension ----------

const allowedOrigin = (origin) => typeof origin === 'string'
  && EXTENSION_IDS.some((id) => origin === `chrome-extension://${id}`);

const wss = new WebSocketServer({
  server,
  path: '/ext',
  maxPayload: 64 * 1024 * 1024,
  verifyClient: ({ origin }) => !restarting && allowedOrigin(origin),
});

wss.on('connection', (ws) => {
  if (extension && extension !== ws) extension.close();
  extension = ws;
  ws.send(JSON.stringify(syncFrame()));

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    // Whichever connection talks is the extension (heals a connection the host lost track of).
    if (extension !== ws) extension = ws;
    if (msg.ping) { ws.send('{"type":"pong"}'); return; }
    if (msg.hello) { extensionInfo = msg; return; }
    if (msg.type === 'chat-send') {
      const hasImages = Array.isArray(msg.images) && msg.images.length > 0;
      if (String(msg.text || '').trim() || hasImages) addUserMessage(msg);
      return;
    }
    if (msg.type === 'chat-stop') return stopWorker();
    if (msg.type === 'chat-clear' || msg.type === 'thread-new') return startThread();
    if (msg.type === 'thread-switch') return switchThread(msg.id);
    if (msg.type === 'thread-delete') return deleteThread(msg.id);
    if (msg.type === 'update-run') return runUpdate();
    const p = pending.get(msg.id);
    if (p) { clearTimeout(p.timer); pending.delete(msg.id); p.resolve(msg); }
  });

  ws.on('close', () => {
    if (extension !== ws) return;
    extension = null;
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: 'extension disconnected' });
      pending.delete(id);
    }
  });
});

// A copy started during a restart waits for the old one to release the port; a duplicate copy gives up.
function listen(attempt = 0) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && attempt < 40) return setTimeout(() => listen(attempt + 1), 250);
    console.error(e.message);
    process.exit(1);
  });
  server.listen(PORT, '127.0.0.1', () => console.log(`BrowserHand host listening on 127.0.0.1:${PORT}`));
}
listen();
