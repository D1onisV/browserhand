// Page helper, runs in the extension's isolated world. Does not modify the page's DOM attributes.
(() => {
  if (window.__browserHand) return;

  const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[role=textbox],[role=searchbox],[role=slider],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
  const STRUCT = 'h1,h2,h3,h4,h5,h6,nav,main,header,footer,aside,form,dialog,[role=dialog],[role=alert],table,iframe';

  // Per-page-load id range, so a stale id from before a reload/navigation never hits a different element.
  let seq = (Math.floor(Math.random() * 900) + 100) * 100;
  const byId = new Map();      // id -> WeakRef(el)
  const idMap = new WeakMap(); // el -> id

  const clip = (s, n = 80) => { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
  const idOf = (el) => { let v = idMap.get(el); if (!v) { v = ++seq; idMap.set(el, v); byId.set(v, new WeakRef(el)); } return v; };

  function* walk(root) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let n;
    while ((n = w.nextNode())) { yield n; if (n.shadowRoot) yield* walk(n.shadowRoot); }
  }
  const deepQuery = (sel) => {
    const el = document.querySelector(sel);
    if (el) return el;
    for (const n of walk(document)) if (n.shadowRoot) { const f = n.shadowRoot.querySelector(sel); if (f) return f; }
    return null;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    return el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : true;
  };
  const inView = (el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; };

  function label(el) {
    const tag = el.tagName;
    const a = el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title');
    if (a) return clip(a);
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      const l = el.labels && el.labels[0] && el.labels[0].innerText;
      return clip(l || el.placeholder || el.getAttribute('name') || '');
    }
    return clip(el.innerText || el.textContent || el.value || '');
  }

  function describe(el) {
    const tag = el.tagName.toLowerCase();
    let t = tag;
    const role = el.getAttribute('role');
    if (role) t += `[${role}]`;
    if (tag === 'input') t += `:${el.type}`;
    let s = `[${idOf(el)}] ${t}`;
    const l = label(el);
    if (l) s += ` "${l}"`;
    if (tag === 'a') { const h = el.getAttribute('href'); if (h && !h.startsWith('javascript')) s += ` → ${clip(h, 70)}`; }
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (el.type === 'checkbox' || el.type === 'radio') s += el.checked ? ' [x]' : ' [ ]';
      else if (el.type !== 'password' && el.value) s += ` = ${JSON.stringify(clip(el.value, 40))}`;
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') s += ' (disabled)';
    if (el.getAttribute('aria-expanded')) s += ` expanded=${el.getAttribute('aria-expanded')}`;
    if (el.id) s += ` #${clip(el.id, 40)}`;
    if (!inView(el)) s += ' ·off';
    return s;
  }

  function structLine(el) {
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return `${'#'.repeat(+tag[1])} ${clip(el.innerText, 100)}  [${idOf(el)}]`;
    if (tag === 'iframe') return `<iframe ${clip(el.src, 80)}> [${idOf(el)}]`;
    const l = el.getAttribute('aria-label') || el.getAttribute('name') || el.id || '';
    return `<${tag}${el.getAttribute('role') ? ' role=' + el.getAttribute('role') : ''}${l ? ' "' + clip(l, 40) + '"' : ''}> [${idOf(el)}]`;
  }

  function resolve(t) {
    if (t === undefined || t === null || t === '') throw new Error('target required (id from map, CSS selector, or text=...)');
    if (typeof t === 'number' || /^\d+$/.test(t)) {
      const el = byId.get(+t) && byId.get(+t).deref();
      if (!el || !el.isConnected) throw new Error(`element [${t}] no longer exists — run map again`);
      return el;
    }
    if (t.startsWith('text=')) {
      const q = t.slice(5).toLowerCase().trim();
      let partial = null;
      for (const el of walk(document)) {
        if (!el.matches(INTERACTIVE) || !visible(el)) continue;
        const l = label(el).toLowerCase();
        if (l === q) return el;
        if (!partial && l.includes(q)) partial = el;
      }
      if (partial) return partial;
      throw new Error(`no visible interactive element with text "${q}"`);
    }
    const el = deepQuery(t);
    if (!el) throw new Error(`selector not found: ${t}`);
    return el;
  }

  // CAPTCHA / bot checks: Claude must not solve them — it stops and asks the user.
  function captcha() {
    const f = [...document.querySelectorAll('iframe')].find((x) => /recaptcha|hcaptcha|challenges\.cloudflare|turnstile|arkoselabs|funcaptcha|geetest|captcha/i.test(x.src || ''));
    if (f && visible(f)) return 'captcha iframe';
    if (document.querySelector('.g-recaptcha,.h-captcha,.cf-turnstile,#captcha,[id*=captcha i],[class*=captcha i]')) {
      const el = document.querySelector('.g-recaptcha,.h-captcha,.cf-turnstile,#captcha,[id*=captcha i],[class*=captcha i]');
      if (visible(el)) return 'captcha widget';
    }
    if (/just a moment|attention required|verify you are human|я не робот|підтвердіть, що ви не робот|подтвердите, что вы не робот|no soy un robot|ich bin kein roboter/i.test(document.title + ' ' + (document.body ? document.body.innerText.slice(0, 2000) : ''))) return 'bot check page';
    return null;
  }
  const header = () => {
    const c = captcha();
    return `URL: ${location.href}\nTitle: ${document.title}\nScroll: ${Math.round(scrollY)}/${Math.max(0, document.documentElement.scrollHeight - innerHeight)}  Viewport: ${innerWidth}x${innerHeight} dpr=${devicePixelRatio}` +
      (c ? `\n⚠ CAPTCHA DETECTED (${c}). Do NOT try to solve or bypass it: stop and ask the user to solve it themselves, then continue.` : '');
  };

  function clickElement(el, x, y) {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, composed: true, clientX: x ?? r.left + r.width / 2, clientY: y ?? r.top + r.height / 2, button: 0, view: window };
    const desc = describe(el);
    el.dispatchEvent(new PointerEvent('pointerover', o)); el.dispatchEvent(new MouseEvent('mouseover', o));
    el.dispatchEvent(new PointerEvent('pointerdown', o)); el.dispatchEvent(new MouseEvent('mousedown', o));
    if (el.focus) el.focus({ preventScroll: true });
    el.dispatchEvent(new PointerEvent('pointerup', o)); el.dispatchEvent(new MouseEvent('mouseup', o));
    el.click();
    return desc;
  }

  const editable = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA)$/.test(el.tagName));
  const setValue = (el, v) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
  };
  const focusables = () => [...walk(document)].filter((e) => e.matches(INTERACTIVE) && !e.disabled && visible(e) && e.tabIndex >= 0);

  // What the browser would do after an uncancelled keydown, for the keys agents use most.
  function keyDefault(el, key, mods) {
    const field = /^(INPUT|TEXTAREA)$/.test(el.tagName);
    if (mods.ctrlKey || mods.metaKey) {
      if (key.toLowerCase() === 'a') { if (field) el.select(); else document.execCommand('selectAll'); }
      return;
    }
    if (key === 'Enter') {
      if (el.tagName === 'TEXTAREA' || el.isContentEditable) document.execCommand('insertText', false, '\n');
      else if (el.form) el.form.requestSubmit();
      else if (el.matches('a[href],button,[role=button]')) el.click();
    } else if (key === 'Tab') {
      const list = focusables();
      const next = list[(list.indexOf(el) + (mods.shiftKey ? -1 : 1) + list.length) % list.length];
      if (next) next.focus();
    } else if (key === 'Backspace' && field) {
      const a = el.selectionStart ?? el.value.length;
      const b = el.selectionEnd ?? a;
      setValue(el, a !== b ? el.value.slice(0, a) + el.value.slice(b) : el.value.slice(0, Math.max(0, a - 1)) + el.value.slice(a));
    } else if (key === 'Backspace' && el.isContentEditable) {
      document.execCommand('delete');
    } else if (!editable(el) && /^(PageDown|PageUp|Home|End|ArrowDown|ArrowUp| )$/.test(key)) {
      const step = { PageDown: innerHeight * 0.85, ' ': innerHeight * 0.85, PageUp: -innerHeight * 0.85, ArrowDown: 60, ArrowUp: -60 }[key];
      if (key === 'Home') scrollTo(0, 0); else if (key === 'End') scrollTo(0, document.documentElement.scrollHeight); else scrollBy(0, step);
    } else if (key.length === 1 && field) {
      const a = el.selectionStart ?? el.value.length;
      const b = el.selectionEnd ?? a;
      setValue(el, el.value.slice(0, a) + key + el.value.slice(b));
    } else if (key.length === 1 && el.isContentEditable) {
      document.execCommand('insertText', false, key);
    }
  }

  const api = {
    info: () => ({ captcha: captcha(), url: location.href, title: document.title, ready: document.readyState, scrollY: Math.round(scrollY), scrollMax: document.documentElement.scrollHeight - innerHeight, viewport: [innerWidth, innerHeight], dpr: devicePixelRatio, focused: document.activeElement && document.activeElement !== document.body ? describe(document.activeElement) : null }),

    // Structured overview: headings/landmarks + every visible interactive element with an id.
    map({ max = 400, view = false, struct = true } = {}) {
      const out = [header(), '---'];
      let n = 0;
      for (const el of walk(document)) {
        const isI = el.matches(INTERACTIVE);
        const isS = struct && !isI && el.matches(STRUCT);
        if (!isI && !isS) continue;
        if (!visible(el)) continue;
        if (view && !inView(el)) continue;
        if (isI && el.tagName !== 'INPUT' && el.parentElement && el.parentElement.closest('a[href],button,[role=button]')) continue;
        out.push(isI ? describe(el) : structLine(el));
        if (++n >= max) { out.push(`… truncated at ${max} (use max= or view=true)`); break; }
      }
      return out.join('\n');
    },

    find({ q, max = 30 } = {}) {
      if (!q) throw new Error('q required');
      const needle = q.toLowerCase();
      const out = []; const seen = new Set();
      for (const el of walk(document)) {
        let own = '';
        for (const c of el.childNodes) if (c.nodeType === 3) own += c.textContent;
        const attrs = [el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('title'), el.getAttribute('alt'), el.value].filter(Boolean).join(' ');
        if (!(own + ' ' + attrs).toLowerCase().includes(needle) || !visible(el)) continue;
        const target = el.closest(INTERACTIVE) || el;
        if (seen.has(target)) continue; seen.add(target);
        out.push(target.matches(INTERACTIVE) ? describe(target) : `[${idOf(target)}] ${target.tagName.toLowerCase()} "${clip(target.innerText, 100)}"${inView(target) ? '' : ' ·off'}`);
        if (out.length >= max) break;
      }
      return out.length ? out.join('\n') : `nothing found for "${q}"`;
    },

    text({ selector, max = 20000 } = {}) {
      const el = selector ? resolve(selector) : document.body;
      const t = (el.innerText || '').replace(/\n{3,}/g, '\n\n');
      return t.length > max ? t.slice(0, max) + `\n… [${t.length - max} more chars, use max=]` : t;
    },

    html({ selector, max = 60000, raw = false } = {}) {
      const src = selector ? resolve(selector) : document.documentElement;
      let h;
      if (raw) h = src.outerHTML;
      else {
        const c = src.cloneNode(true);
        c.querySelectorAll('script,style,noscript,link[rel=stylesheet],link[rel=preload],meta,template').forEach((e) => e.remove());
        c.querySelectorAll('svg').forEach((e) => { e.innerHTML = ''; });
        const tw = document.createTreeWalker(c, NodeFilter.SHOW_COMMENT); const cm = [];
        while (tw.nextNode()) cm.push(tw.currentNode); cm.forEach((n) => n.remove());
        for (const e of [c, ...c.querySelectorAll('*')]) {
          for (const a of [...e.attributes]) {
            if (a.name === 'style' || a.name.startsWith('on') || (a.name.startsWith('data-') && !/test|qa|id$/.test(a.name))) e.removeAttribute(a.name);
            else if (a.value.length > 120) e.setAttribute(a.name, a.value.slice(0, 120) + '…');
          }
        }
        h = c.outerHTML.replace(/>\s+</g, '><').replace(/\s{2,}/g, ' ');
      }
      return h.length > max ? h.slice(0, max) + `\n… [${h.length - max} more chars, use max= or selector=]` : h;
    },

    rect({ target }) {
      const el = resolve(target);
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, desc: describe(el) };
    },

    click({ target }) {
      const el = resolve(target);
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      return `clicked ${clickElement(el)}`;
    },

    // Click at viewport coordinates (CSS pixels) with page events, no debugger.
    clickAt({ x, y }) {
      const el = document.elementFromPoint(+x, +y);
      if (!el) throw new Error(`nothing at ${x},${y}`);
      return `clicked at ${x},${y}: ${clickElement(el, +x, +y)}`;
    },

    // Keys as page events: "Enter", "Tab", "shift+Tab", "Escape", "Backspace", "ctrl+a", "PageDown", "a".
    // Sites that only trust real keyboard input need "Real click and keyboard" instead.
    keys({ keys = '' } = {}) {
      const done = [];
      for (const combo of String(keys).split(/\s+/).filter(Boolean)) {
        const parts = combo.split('+');
        const main = parts.pop();
        const has = (re) => parts.some((p) => re.test(p));
        const mods = { ctrlKey: has(/^(ctrl|control)$/i), shiftKey: has(/^shift$/i), altKey: has(/^alt$/i), metaKey: has(/^(meta|cmd|win)$/i) };
        const key = { Esc: 'Escape', Space: ' ', Return: 'Enter' }[main] || main;
        const code = key.length === 1 ? (/[a-z]/i.test(key) ? 'Key' + key.toUpperCase() : /\d/.test(key) ? 'Digit' + key : '') : key;
        const el = document.activeElement || document.body;
        const opts = { key, code, bubbles: true, cancelable: true, composed: true, ...mods };
        if (el.dispatchEvent(new KeyboardEvent('keydown', opts))) keyDefault(el, key, mods);
        el.dispatchEvent(new KeyboardEvent('keyup', opts));
        done.push(combo);
      }
      return `pressed ${done.join(' ')}`;
    },

    focus({ target }) { const el = resolve(target); el.focus(); return `focused ${describe(el)}`; },

    hover({ target }) {
      const el = resolve(target);
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      const o = { bubbles: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      for (const t of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove'])
        el.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, o) : new MouseEvent(t, o));
      return `hovered ${describe(el)}`;
    },

    type({ target, text = '', clear = true, enter = false }) {
      const el = target !== undefined ? resolve(target) : document.activeElement;
      if (!el) throw new Error('no target and nothing focused');
      el.focus();
      if (el.isContentEditable) {
        if (clear) document.execCommand('selectAll');
        document.execCommand('insertText', false, text);
      } else {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, (clear ? '' : el.value) + text);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (enter) {
        const k = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
        const ok = el.dispatchEvent(new KeyboardEvent('keydown', k));
        el.dispatchEvent(new KeyboardEvent('keyup', k));
        if (ok && el.form) el.form.requestSubmit();
      }
      return `typed into ${describe(el)}`;
    },

    select({ target, value }) {
      const el = resolve(target);
      if (el.tagName !== 'SELECT') throw new Error('not a <select>');
      const opt = [...el.options].find((o) => o.value === String(value)) || [...el.options].find((o) => o.text.trim().toLowerCase() === String(value).toLowerCase());
      if (!opt) throw new Error(`option not found. Options: ${[...el.options].map((o) => o.text.trim()).join(' | ')}`);
      el.value = opt.value;
      el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
      return `selected "${opt.text.trim()}"`;
    },

    scroll({ to, target, dy, pages } = {}) {
      if (target !== undefined) resolve(target).scrollIntoView({ block: 'center', behavior: 'instant' });
      else if (to === 'top') scrollTo(0, 0);
      else if (to === 'bottom') scrollTo(0, document.documentElement.scrollHeight);
      else if (to !== undefined) resolve(to).scrollIntoView({ block: 'center', behavior: 'instant' });
      else scrollBy(0, dy !== undefined ? +dy : innerHeight * 0.85 * (pages !== undefined ? +pages : 1));
      return `scrollY=${Math.round(scrollY)}/${document.documentElement.scrollHeight - innerHeight}`;
    },

    // <video>/<audio> on the page: list, play/pause, seek, speed, grab the current frame.
    async video({ action = 'info', index, t, rate, width = 960 } = {}) {
      const els = [...walk(document)].filter((e) => e instanceof HTMLMediaElement);
      if (!els.length) throw new Error('no <video> or <audio> on this page');
      const pick = () => {
        if (index !== undefined) { const e = els[+index]; if (!e) throw new Error(`no media #${index}`); return e; }
        return els.find((e) => !e.paused) || els.find((e) => e instanceof HTMLVideoElement && visible(e)) || els[0];
      };
      const fmt = (s) => (isFinite(s) ? `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}` : 'live');
      const line = (e, i) => `#${i} ${e.tagName.toLowerCase()}${e.videoWidth ? ` ${e.videoWidth}x${e.videoHeight}` : ''} ${fmt(e.currentTime)} / ${fmt(e.duration)} ${e.paused ? 'paused' : 'playing'}${e.muted ? ' muted' : ''} x${e.playbackRate}${e.loop ? ' loop' : ''}`;
      if (action === 'info') return [`URL: ${location.href}`, ...els.map(line)].join('\n');
      const e = pick();
      const i = els.indexOf(e);
      if (action === 'play') { await e.play(); return line(e, i); }
      if (action === 'pause') { e.pause(); return line(e, i); }
      if (action === 'seek') {
        const s = String(t).split(':').reduce((acc, x) => acc * 60 + parseFloat(x), 0);
        e.currentTime = s;
        await new Promise((r) => { const done = () => { e.removeEventListener('seeked', done); r(); }; e.addEventListener('seeked', done); setTimeout(done, 3000); });
        return line(e, i);
      }
      if (action === 'rate') { e.playbackRate = +rate; return line(e, i); }
      if (action === 'mute') { e.muted = !e.muted; return line(e, i); }
      if (action === 'frame') {
        if (!(e instanceof HTMLVideoElement) || !e.videoWidth) throw new Error('not a video or no frame yet');
        const k = Math.min(1, width / e.videoWidth);
        const c = document.createElement('canvas');
        c.width = Math.round(e.videoWidth * k); c.height = Math.round(e.videoHeight * k);
        try {
          c.getContext('2d').drawImage(e, 0, 0, c.width, c.height);
          return { dataUrl: c.toDataURL('image/jpeg', 0.85), at: fmt(e.currentTime) };
        } catch {
          throw new Error('the site blocks frame capture (DRM/cross-origin) — use `shot` instead');
        }
      }
      throw new Error('action: info | play | pause | seek t= | rate rate= | mute | frame');
    },

    async wait({ selector, text, gone = false, timeout = 10000 } = {}) {
      const t0 = Date.now();
      const check = () => {
        let hit;
        if (selector) hit = !!deepQuery(selector) && visible(deepQuery(selector));
        else if (text) hit = (document.body.innerText || '').toLowerCase().includes(String(text).toLowerCase());
        else hit = document.readyState === 'complete';
        return gone ? !hit : hit;
      };
      while (Date.now() - t0 < timeout) { if (check()) return `ok after ${Date.now() - t0}ms`; await new Promise((r) => setTimeout(r, 100)); }
      throw new Error(`wait timed out after ${timeout}ms`);
    },
  };

  window.__browserHand = {
    async run(cmd, args) {
      try {
        if (!api[cmd]) return { error: `unknown page command: ${cmd}` };
        return { result: await api[cmd](args || {}) };
      } catch (e) { return { error: String(e && e.message || e) }; }
    },
  };
})();
