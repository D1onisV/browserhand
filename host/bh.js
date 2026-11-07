#!/usr/bin/env node
// BrowserHand CLI. Starts the host if needed and sends one command to the extension.
//
//   node host/bh.js <command> [positional] [key=value ...]
//   node host/bh.js <command> '{"json": "args"}'
//
//   node host/bh.js tabs
//   node host/bh.js map tab=123
//   node host/bh.js click 12                  id from `map`; also "#css", "text=Sign in", real=true
//   node host/bh.js type 5 "hello" enter=true
//   node host/bh.js batch '[{"cmd":"nav","url":"https://example.com"},{"cmd":"map"}]'
//   node host/bh.js media look https://youtu.be/...
//
// Chat (session mode): watch | reply "text" | reply - < file | progress "step" | chat [n] | usage '<json>'

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const HOST_DIR = __dirname;
const config = (() => { try { return JSON.parse(fs.readFileSync(path.join(HOST_DIR, 'config.json'), 'utf8')); } catch { return {}; } })();
const PORT = +process.env.BH_PORT || config.port || 17321;
const TOKEN_FILE = path.join(HOST_DIR, 'data', '.token');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readToken = () => { try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { return ''; } };

// Which argument a bare value (not key=value) fills, per command.
const POSITIONAL = {
  open: ['url'], nav: ['url'], click: ['target'], hover: ['target'], focus: ['target'], type: ['target', 'text'],
  select: ['target', 'value'], eval: ['code'], find: ['q'], key: ['keys'], activate: ['tab'], close: ['tab'],
  wait: ['selector'], video: ['action'], text: ['selector'], html: ['selector'], scroll: ['to'], sleep: ['ms'],
  console: ['q'], net: ['q'],
};
const STRING_ARGS = new Set(['text', 'code', 'q', 'url', 'value', 'keys', 'selector']);

function request(method, route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, method, path: route,
      headers: { 'x-bh-token': readToken(), 'content-type': 'application/json' },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ ok: false, error: data }); } });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function ensureHost() {
  try { return await request('GET', '/status'); } catch { /* not running yet */ }
  spawn(process.execPath, [path.join(HOST_DIR, 'server.js')], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    try { return await request('GET', '/status'); } catch { /* still starting */ }
  }
  throw new Error('the host failed to start');
}

function parseArgs(cmd, rest) {
  let args = {};
  if (rest.length && /^\s*[[{]/.test(rest[0]) && cmd !== 'eval') {
    const parsed = JSON.parse(rest.shift());
    args = Array.isArray(parsed) ? { steps: parsed } : parsed;
  }
  const positional = [...(POSITIONAL[cmd] || [])];
  for (const raw of rest) {
    const kv = /^([a-zA-Z_]\w*)=(.*)$/s.exec(raw);
    // "text=Sign in" is a locator for the target, except for commands that take a text argument.
    const isLocator = kv && kv[1] === 'text' && !['type', 'wait'].includes(cmd) && positional[0] && positional[0] !== 'code';
    const isCode = kv && cmd === 'eval' && positional[0] === 'code' && !['tab', 'timeout'].includes(kv[1]);
    let key;
    let value;
    if (kv && !isLocator && !isCode) [, key, value] = kv;
    else {
      key = positional.shift();
      value = raw;
      if (!key) throw new Error(`unexpected argument: ${raw}`);
    }
    if (!STRING_ARGS.has(key)) {
      if (value === 'true') value = true;
      else if (value === 'false') value = false;
      else if (/^-?\d+(\.\d+)?$/.test(value)) value = +value;
    }
    args[key] = value;
  }
  return args;
}

function format(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.file === 'string' && Object.keys(value).length === 1) return value.file;
  return JSON.stringify(value, null, 1);
}

function runMedia(rest) {
  const python = process.platform === 'win32'
    ? path.join(HOST_DIR, '.venv-media', 'Scripts', 'python.exe')
    : path.join(HOST_DIR, '.venv-media', 'bin', 'python');
  if (!fs.existsSync(python)) throw new Error('media tools are not installed: run  node setup.js --media');
  const r = spawnSync(python, [path.join(HOST_DIR, 'media.py'), ...rest], {
    stdio: 'inherit',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  process.exitCode = r.status ?? 1;
}

// Prints each session-mode chat message as a block; reconnects when the host restarts.
async function watch() {
  for (;;) {
    await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: PORT, method: 'GET', path: '/watch', headers: { 'x-bh-token': readToken() } }, (res) => {
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buffer += chunk;
          let nl;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            let m;
            try { m = JSON.parse(line); } catch { continue; }
            if (m.hello) continue;
            const tab = m.tab ? ` | tab ${m.tab.id}: ${m.tab.title} — ${m.tab.url}` : '';
            const images = m.images && m.images.length ? `\nIMAGES: ${m.images.join(' | ')}` : '';
            console.log(`CHAT [${m.id}]${tab}\n${m.text}${images}`);
          }
        });
        res.on('end', resolve);
        res.on('error', resolve);
      });
      req.on('error', resolve);
      req.end();
    });
    await sleep(1000);
    await ensureHost().catch(() => {});
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) {
    console.log('usage: node host/bh.js <command> [args]    (node host/bh.js help lists the commands)');
    return;
  }
  if (cmd === 'media') return runMedia(rest);

  let status = await ensureHost();
  switch (cmd) {
    case 'status':
      console.log(JSON.stringify(status));
      return;
    case 'watch':
      return watch();
    case 'reply': {
      const text = !rest.length || rest[0] === '-' ? fs.readFileSync(0, 'utf8') : rest.join(' ');
      const r = await request('POST', '/reply', { text: text.trim() });
      if (!r.ok) throw new Error(r.error);
      console.log(r.result);
      return;
    }
    case 'progress': {
      const r = await request('POST', '/progress', { text: rest.join(' ') });
      if (!r.ok) throw new Error(r.error);
      return;
    }
    case 'usage': {
      const r = await request('POST', '/usage', JSON.parse(rest.join(' ') || '{}'));
      if (!r.ok) throw new Error(r.error);
      console.log(JSON.stringify(r.result));
      return;
    }
    case 'chat': {
      const r = await request('GET', '/chat?n=' + (+rest[0] || 20));
      for (const m of r.result) {
        const who = m.from === 'user' ? 'USER' : 'CLAUDE';
        const body = m.from === 'claude' && m.kind !== 'reply' ? `(${m.kind}) ${m.detail || ''}` : m.text;
        console.log(`${new Date(m.at).toLocaleTimeString()} ${who} [${m.id}]${m.tab ? ` (tab ${m.tab.id})` : ''}: ${body}`);
      }
      return;
    }
  }

  if (!status.extension) {
    process.stderr.write('waiting for the extension to connect…\n');
    for (let i = 0; i < 70 && !status.extension; i++) {
      await sleep(500);
      status = await request('GET', '/status');
    }
    if (!status.extension) throw new Error('the extension is not connected: is BrowserHand installed and enabled?');
  }

  const r = await request('POST', '/cmd', { cmd, args: parseArgs(cmd, rest) });
  if (!r.ok) throw new Error(r.error);
  if (cmd === 'batch' && Array.isArray(r.result)) {
    for (const step of r.result) console.log(`== ${step.cmd}: ${step.ok ? '\n' + format(step.result) : 'ERROR ' + step.error}`);
    return;
  }
  console.log(format(r.result));
}

main().catch((e) => {
  console.error('ERROR: ' + e.message);
  process.exitCode = 1;
});
