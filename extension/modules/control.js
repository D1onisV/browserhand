// Browser control: tabs, page reading, clicks, typing, screenshots, console and network logs.

(() => {
  // ---------- settings (menu ⋯) ----------
  // realInput:  trusted mouse/keyboard, CSP-proof eval and full-page shots through the
  //             DevTools protocol. The browser shows a "debugging this browser" bar meanwhile.
  // followTabs: switch the user's view to the tab Claude works on. When off, Claude's own tabs
  //             live in a separate unfocused window and the user's tabs are never activated.
  const settings = { realInput: false, followTabs: true };
  chrome.storage.local.get(settings).then((s) => Object.assign(settings, s));
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    for (const k of Object.keys(settings)) if (ch[k]) settings[k] = ch[k].newValue;
  });

  const NEED_REAL = 'needs "Real click and keyboard" (menu ⋯), which shows the browser’s debugging bar';

  // One unfocused window for tabs Claude opens while following is off.
  async function agentWindow() {
    const { agentWindowId } = await chrome.storage.session.get({ agentWindowId: null });
    if (agentWindowId) { try { return await chrome.windows.get(agentWindowId); } catch { /* closed */ } }
    return null;
  }
  async function openInAgentWindow(url) {
    const w = await agentWindow();
    if (w) return chrome.tabs.create({ windowId: w.id, url, active: true });
    const created = await chrome.windows.create({ url, focused: false, width: 1280, height: 860 });
    await chrome.storage.session.set({ agentWindowId: created.id });
    return created.tabs[0];
  }
  async function inAgentWindow(tab) {
    const w = await agentWindow();
    return !!w && tab.windowId === w.id;
  }

  // ---------- helpers ----------
  async function tabOf(a) {
    let id;
    if (a.tab !== undefined && a.tab !== null && a.tab !== '') id = +a.tab;
    else {
      const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!t) throw new Error('no active tab');
      id = t.id;
    }
    await assertAccess(id);
    return id;
  }

  function waitLoad(tabId, timeout = 15000) {
    let listener, timer;
    const p = new Promise((res) => {
      listener = (id, ch) => { if (id === tabId && ch.status === 'complete') res(true); };
      chrome.tabs.onUpdated.addListener(listener);
      timer = setTimeout(() => res(false), timeout);
    });
    return p.finally(() => { chrome.tabs.onUpdated.removeListener(listener); clearTimeout(timer); });
  }

  async function tabSummary(tabId, loaded = true) {
    const t = await chrome.tabs.get(tabId);
    return `tab ${t.id}: ${t.title} — ${t.url}${loaded ? '' : ' (still loading)'}`;
  }

  // Run a page command through content/page.js, injecting it into pages opened before the extension loaded.
  async function page(tabId, cmd, args) {
    const exec = () => chrome.scripting.executeScript({
      target: { tabId },
      func: (c, a) => (window.__browserHand ? window.__browserHand.run(c, a) : { missing: true }),
      args: [cmd, args || {}],
    });
    let [r] = await exec();
    if (r && r.result && r.result.missing) {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content/page.js'] });
      [r] = await exec();
    }
    const v = r && r.result;
    if (!v) throw new Error('page returned nothing (chrome:// pages and the Web Store cannot be scripted)');
    if (v.error) throw new Error(v.error);
    return v.result;
  }

  // ---------- DevTools protocol (trusted input, CSP-proof eval, background screenshots) ----------
  const dbg = {};
  async function cdp(tabId, method, params = {}) {
    if (!settings.realInput) throw new Error(`this action ${NEED_REAL}`);
    if (!dbg[tabId]) {
      dbg[tabId] = { p: chrome.debugger.attach({ tabId }, '1.3'), t: null };
      try { await dbg[tabId].p; } catch (e) { delete dbg[tabId]; throw e; }
    } else await dbg[tabId].p;
    clearTimeout(dbg[tabId].t);
    dbg[tabId].t = setTimeout(() => { chrome.debugger.detach({ tabId }).catch(() => {}); delete dbg[tabId]; }, 2000);
    return chrome.debugger.sendCommand({ tabId }, method, params);
  }
  chrome.debugger.onDetach.addListener((s) => { if (dbg[s.tabId]) { clearTimeout(dbg[s.tabId].t); delete dbg[s.tabId]; } });

  const KEYS = {
    Enter: [13, 'Enter', '\r'], Tab: [9, 'Tab'], Escape: [27, 'Escape'], Esc: [27, 'Escape'],
    Backspace: [8, 'Backspace'], Delete: [46, 'Delete'], Space: [32, 'Space', ' '],
    ArrowUp: [38, 'ArrowUp'], ArrowDown: [40, 'ArrowDown'], ArrowLeft: [37, 'ArrowLeft'], ArrowRight: [39, 'ArrowRight'],
    Home: [36, 'Home'], End: [35, 'End'], PageUp: [33, 'PageUp'], PageDown: [34, 'PageDown'],
    F5: [116, 'F5'], F12: [123, 'F12'],
  };
  const EDIT_CMDS = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo', y: 'redo' };

  async function pressKeys(tabId, combos) {
    for (const combo of String(combos).split(/\s+/).filter(Boolean)) {
      const parts = combo.split('+');
      const main = parts.pop();
      let mod = 0;
      for (const p of parts) {
        const l = p.toLowerCase();
        if (l === 'alt') mod |= 1; else if (l === 'ctrl' || l === 'control') mod |= 2;
        else if (l === 'meta' || l === 'cmd' || l === 'win') mod |= 4; else if (l === 'shift') mod |= 8;
        else throw new Error(`unknown modifier ${p}`);
      }
      let vk, code, text, key;
      if (KEYS[main]) { [vk, code, text] = KEYS[main]; key = main === 'Space' ? ' ' : code; }
      else if (main.length === 1) {
        const up = main.toUpperCase();
        vk = up.charCodeAt(0); key = main;
        code = /[A-Z]/.test(up) ? 'Key' + up : /[0-9]/.test(main) ? 'Digit' + main : '';
        if (!(mod & 7)) text = main;
      } else throw new Error(`unknown key "${main}"`);
      const ev = { modifiers: mod, windowsVirtualKeyCode: vk, code, key };
      const down = { ...ev, type: text ? 'keyDown' : 'rawKeyDown', text, unmodifiedText: text };
      if (mod & 2 && EDIT_CMDS[main.toLowerCase()]) down.commands = [EDIT_CMDS[main.toLowerCase()]];
      await cdp(tabId, 'Input.dispatchKeyEvent', down);
      await cdp(tabId, 'Input.dispatchKeyEvent', { ...ev, type: 'keyUp' });
    }
  }

  async function mouseClick(tabId, x, y, { button = 'left', count = 1 } = {}) {
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    for (let i = 1; i <= count; i++) {
      await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: i });
      await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: i });
    }
  }

  // ---------- network log (webRequest, per tab) ----------
  const net = {};
  const starts = new Map();
  chrome.webRequest.onBeforeRequest.addListener((d) => { if (d.tabId >= 0) starts.set(d.requestId, d.timeStamp); }, { urls: ['<all_urls>'] });
  const fin = (d, err) => {
    if (d.tabId < 0) return;
    const s = starts.get(d.requestId); starts.delete(d.requestId);
    const list = (net[d.tabId] ||= []);
    list.push({ m: d.method, u: d.url, s: err ? 'ERR ' + d.error : d.statusCode, t: d.type, ms: s ? Math.round(d.timeStamp - s) : null });
    if (list.length > 500) list.shift();
  };
  chrome.webRequest.onCompleted.addListener((d) => fin(d), { urls: ['<all_urls>'] });
  chrome.webRequest.onErrorOccurred.addListener((d) => fin(d, true), { urls: ['<all_urls>'] });
  chrome.tabs.onRemoved.addListener((id) => { delete net[id]; });

  // ---------- eval in page (MAIN world; falls back to DevTools when CSP blocks eval) ----------
  async function evaluate(tabId, code, timeout = 20000) {
    let expr = code;
    if (/\bawait\b/.test(code)) expr = /\breturn\b/.test(code) ? `(async()=>{${code}})()` : `(async()=>(${code}))()`;
    const [r] = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN', args: [expr],
      func: async (c) => {
        let budget = 3000;
        const ser = (v, d = 0) => {
          if (--budget < 0) return '…';
          if (v === undefined) return 'undefined';
          if (v === null || (typeof v !== 'object' && typeof v !== 'function')) return v;
          if (typeof v === 'function') return `ƒ ${v.name || 'anonymous'}`;
          if (v instanceof Element) return v.outerHTML.length > 3000 ? v.outerHTML.slice(0, 3000) + '…' : v.outerHTML;
          if (v instanceof NodeList || v instanceof HTMLCollection) v = [...v];
          if (v instanceof Map) v = Object.fromEntries(v);
          if (v instanceof Set) v = [...v];
          if (d > 4) return Array.isArray(v) ? `[Array ${v.length}]` : '{…}';
          if (Array.isArray(v)) return v.slice(0, 300).map((x) => ser(x, d + 1));
          const o = {}; let i = 0;
          for (const k in v) { if (i++ > 150) { o['…'] = 'more keys'; break; } try { o[k] = ser(v[k], d + 1); } catch { o[k] = '?'; } }
          return o;
        };
        try { let v = (0, eval)(c); if (v && typeof v.then === 'function') v = await v; return { v: ser(v) }; }
        catch (e) { return { err: String(e && e.stack || e), csp: e instanceof EvalError || /Content Security Policy|unsafe-eval/i.test(String(e)) }; }
      },
    });
    const res = r && r.result;
    if (res && !res.csp) { if (res.err) throw new Error(res.err); return res.v; }
    // The page's CSP blocks eval: user scripts (if allowed) or the DevTools protocol.
    if (!settings.realInput && chrome.userScripts && chrome.userScripts.execute) {
      try {
        const [u] = await chrome.userScripts.execute({ target: { tabId }, world: 'USER_SCRIPT', js: [{ code: expr }] });
        if (u && u.error) throw new Error(u.error);
        return u ? u.result : undefined;
      } catch (e) {
        if (!/not enabled|allow user scripts|developer mode/i.test(String(e.message))) throw e;
      }
    }
    if (!settings.realInput) throw new Error(`this site blocks eval (CSP). Use map/text/find instead, or eval ${NEED_REAL}`);
    const out = await cdp(tabId, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true, timeout });
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception && out.exceptionDetails.exception.description || out.exceptionDetails.text);
    return out.result.value !== undefined ? out.result.value : out.result.description || out.result.type;
  }

  // ---------- screenshot ----------
  async function screenshot(a) {
    const tabId = await tabOf(a);
    const t = await chrome.tabs.get(tabId);
    const format = a.format || 'jpeg';
    const quality = a.quality !== undefined ? +a.quality : 70;
    if (a.full && !settings.realInput) throw new Error(`full=true ${NEED_REAL}. Take a normal shot, scroll, and shoot again`);
    let prev = null;
    if (!t.active && !settings.followTabs && !(await inAgentWindow(t))) {
      throw new Error('this tab is in the background and "Switch to Claude’s tabs" is off, so it was not brought to the front. Use map/text/find, or ask the user');
    }
    if (!t.active) {
      const [cur] = await chrome.tabs.query({ active: true, windowId: t.windowId });
      prev = cur && cur.id;
      await chrome.tabs.update(tabId, { active: true });
      await new Promise((r) => setTimeout(r, 250));
    }
    try {
      if (a.full) {
        const m = await cdp(tabId, 'Page.getLayoutMetrics');
        const cs = m.cssContentSize || m.contentSize;
        const r = await cdp(tabId, 'Page.captureScreenshot', {
          format, quality: format === 'jpeg' ? quality : undefined, captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: cs.width, height: Math.min(cs.height, 15000), scale: a.scale ? +a.scale : 1 },
        });
        return { dataUrl: `data:image/${format};base64,${r.data}` };
      }
      const url = await chrome.tabs.captureVisibleTab(t.windowId, { format, quality });
      return { dataUrl: url };
    } finally {
      if (prev && a.back !== false) await chrome.tabs.update(prev, { active: true }).catch(() => {});
    }
  }

  // ---------- commands ----------
  const P = (cmd) => async (a) => page(await tabOf(a), cmd, a);

  registerCommands({
    tabs: async () => {
      const all = await chrome.tabs.query({});
      const ok = [];
      for (const t of all) if (await canAccess(t.id)) ok.push(t);
      const hidden = all.length - ok.length;
      const lines = ok.map((t) => `${t.active ? '*' : ' '} ${t.id} [w${t.windowId}] ${t.title || '(no title)'} — ${t.url}`);
      if (hidden) lines.push(`(${hidden} more tab(s) hidden: the user turned off access to them)`);
      return lines.join('\n') || '(no accessible tabs)';
    },
    open: async ({ url, active = false, wait = true }) => {
      if (!url) throw new Error('url required');
      const t = settings.followTabs ? await chrome.tabs.create({ url, active: !!active }) : await openInAgentWindow(url);
      await setAccess(t.id, true); // tabs the agent opens itself stay accessible to it
      const p = wait ? waitLoad(t.id) : Promise.resolve(true);
      const done = (await chrome.tabs.get(t.id)).status === 'complete' || await p;
      return tabSummary(t.id, done);
    },
    nav: async (a) => {
      const tabId = await tabOf(a);
      if (!a.url) throw new Error('url required');
      const p = waitLoad(tabId);
      await chrome.tabs.update(tabId, { url: a.url });
      return tabSummary(tabId, a.wait === false ? true : await p);
    },
    back: async (a) => { const id = await tabOf(a); const p = waitLoad(id, 8000); await chrome.tabs.goBack(id); return tabSummary(id, await p); },
    forward: async (a) => { const id = await tabOf(a); const p = waitLoad(id, 8000); await chrome.tabs.goForward(id); return tabSummary(id, await p); },
    reload: async (a) => { const id = await tabOf(a); const p = waitLoad(id); await chrome.tabs.reload(id, { bypassCache: !!a.hard }); return tabSummary(id, await p); },
    activate: async (a) => {
      const id = await tabOf(a);
      const tab = await chrome.tabs.get(id);
      if (!settings.followTabs) {
        if (!(await inAgentWindow(tab))) throw new Error('"Switch to Claude’s tabs" is off: the user’s tabs are not brought to the front. Work with tab=ID directly');
        await chrome.tabs.update(id, { active: true }); // inside Claude's own window, no focus change
        return tabSummary(id);
      }
      await chrome.tabs.update(id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return tabSummary(id);
    },
    close: async (a) => { const id = await tabOf(a); await chrome.tabs.remove(id); return `closed ${id}`; },

    info: P('info'),
    map: P('map'),
    find: P('find'),
    text: P('text'),
    html: P('html'),
    hover: P('hover'),
    focus: P('focus'),
    select: P('select'),
    scroll: P('scroll'),
    wait: async (a) => page(await tabOf(a), 'wait', a),
    video: async (a) => page(await tabOf(a), 'video', a),

    click: async (a) => {
      const tabId = await tabOf(a);
      if (a.x !== undefined && a.y !== undefined) {
        if (!settings.realInput) return page(tabId, 'clickAt', a);
        await mouseClick(tabId, +a.x, +a.y, { button: a.button, count: a.count ? +a.count : 1 });
        return `clicked at ${a.x},${a.y}`;
      }
      if (a.real && settings.realInput) {
        const r = await page(tabId, 'rect', a);
        await mouseClick(tabId, r.x, r.y, { button: a.button, count: a.count ? +a.count : 1 });
        return `real-clicked ${r.desc}`;
      }
      return page(tabId, 'click', a);
    },
    type: async (a) => {
      const tabId = await tabOf(a);
      if (!a.real || !settings.realInput) return page(tabId, 'type', a);
      if (a.target !== undefined) { const r = await page(tabId, 'rect', a); await mouseClick(tabId, r.x, r.y); }
      if (a.clear !== false) await pressKeys(tabId, 'ctrl+a Backspace');
      await cdp(tabId, 'Input.insertText', { text: String(a.text || '') });
      if (a.enter) await pressKeys(tabId, 'Enter');
      return 'typed (real input)';
    },
    key: async (a) => {
      const id = await tabOf(a);
      if (!settings.realInput) return page(id, 'keys', a);
      await pressKeys(id, a.keys);
      return `pressed ${a.keys}`;
    },

    eval: async (a) => evaluate(await tabOf(a), String(a.code || '')),
    shot: screenshot,

    console: async (a) => {
      const tabId = await tabOf(a);
      const [r] = await chrome.scripting.executeScript({
        target: { tabId }, world: 'MAIN', args: [!!a.clear],
        func: (clear) => { const L = window.__browserHandLog; if (!L) return null; const c = L.slice(); if (clear) L.length = 0; return c; },
      });
      const L = r && r.result;
      if (!L) return 'no console hook on this page (it was opened before the extension loaded — reload it)';
      let rows = L;
      if (a.errors) rows = rows.filter((x) => /error|uncaught|unhandled|warn/.test(x.l));
      if (a.q) rows = rows.filter((x) => x.m.toLowerCase().includes(String(a.q).toLowerCase()));
      rows = rows.slice(-(a.max ? +a.max : 100));
      return rows.length ? rows.map((x) => `[${x.l}] ${x.m}`).join('\n') : '(console empty)';
    },
    net: async (a) => {
      const tabId = await tabOf(a);
      let rows = net[tabId] || [];
      if (a.clear) { net[tabId] = []; return 'cleared'; }
      if (a.q) rows = rows.filter((x) => x.u.includes(a.q));
      if (a.errors) rows = rows.filter((x) => typeof x.s === 'string' || x.s >= 400);
      if (a.type) rows = rows.filter((x) => x.t === a.type);
      rows = rows.slice(-(a.max ? +a.max : 80));
      return rows.length ? rows.map((x) => `${x.s} ${x.m} ${x.t} ${x.ms ?? '?'}ms ${x.u.length > 200 ? x.u.slice(0, 200) + '…' : x.u}`).join('\n') : '(no requests recorded for this tab)';
    },
  });
})();
