// Auto-reject cookie banners: clicks "Reject all" / "Only necessary". Never clicks "Accept".
// If a banner offers no reject option, it is left alone.
(() => {
  if (window.__browserHandCookies) return;
  window.__browserHandCookies = true;

  // Known consent platforms: their reject buttons.
  const KNOWN = [
    '#onetrust-reject-all-handler', '.ot-pc-refuse-all-handler',
    '#CybotCookiebotDialogBodyButtonDecline', '#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll',
    '#didomi-notice-disagree-button', '.didomi-continue-without-agreeing',
    'button[data-testid="uc-deny-all-button"]', '#uc-btn-deny-banner',
    '.cmplz-deny', '.cky-btn-reject', '.osano-cm-denyAll', '.cm-btn-decline', '.iubenda-cs-reject-btn',
    '#truste-consent-required', '.qc-cmp2-summary-buttons button[mode="secondary"]',
    '.fc-cta-do-not-consent', '#cookie-reject', '#reject-cookies', '[data-cookiefirst-action="reject"]',
    '.js-cookie-reject', '#tarteaucitronAllDenied2', '.sp_choice_type_REJECT_ALL', '.message-component.sp_choice_type_13',
  ];
  const BANNER = /cookie|кукі|куки|consent|згод[аиу] на|согласи[ея] на|gdpr|tracking|трекінг/i;
  const NECESSARY = /(only|just)\s+(the\s+)?(necessary|essential|required)|(necessary|essential|required)\s+only|лише\s+(необхідн|обов|основн)|тільки\s+(необхідн|обов)|только\s+(необходим|обязательн|основн)|nur\s+(notwendig|erforderlich|essenziell)|solo\s+(necesari|esencial)|uniquement\s+(n[ée]cessaire|essentiel)/i;
  const REJECT = /reject|decline|deny|disagree|refuse|do not consent|don.?t (accept|agree)|continue without|відхил|відмов|не прийма|не погоджу|без згоди|отклон|отказ|не принима|не соглас|ablehnen|verweigern|refuser|rechazar|rifiut|odrzu|odmítn/i;
  const ACCEPT = /accept|agree|allow|got it|ok\b|okay|прийн|погодж|дозвол|зрозуміло|приня|соглас|разреш|понятно|akzept|zustimm|erlauben|accepter|aceptar|accett/i;

  function* walk(root) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let n;
    while ((n = w.nextNode())) { yield n; if (n.shadowRoot) yield* walk(n.shadowRoot); }
  }
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 && (!el.checkVisibility || el.checkVisibility({ opacityProperty: true, visibilityProperty: true }));
  };
  const label = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
  const isRejectText = (t) => t.length <= 60 && (NECESSARY.test(t) || (REJECT.test(t) && !ACCEPT.test(t.replace(NECESSARY, ''))) );

  // A banner = an overlay (fixed/sticky/dialog) whose text talks about cookies/consent.
  function inBanner(el) {
    let n = el, overlay = false, cookieText = false;
    for (let i = 0; i < 12 && n; i++) {
      n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
      if (!n || n === document.body || n === document.documentElement) break;
      const pos = getComputedStyle(n).position;
      if (pos === 'fixed' || pos === 'sticky' || n.matches('dialog,[role=dialog],[role=alertdialog],[aria-modal=true]')) overlay = true;
      const t = (n.innerText || '').slice(0, 4000);
      if (t.length > 40 && BANNER.test(t)) cookieText = true;
      if (overlay && cookieText) return true;
    }
    // consent pages/iframes (e.g. consent.google.com, Sourcepoint) are banners as a whole
    return /consent|cmp|privacy-mgmt|sp_message/i.test(location.hostname + location.pathname);
  }

  let clicks = 0;
  function attempt() {
    if (clicks >= 3) return;
    for (const sel of KNOWN) {
      for (const el of document.querySelectorAll(sel)) {
        if (visible(el) && !ACCEPT.test(label(el).replace(NECESSARY, '')) ) { el.click(); clicks++; return; }
      }
    }
    for (const el of walk(document)) {
      if (!el.matches('button,[role=button],input[type=button],input[type=submit]')) continue;
      const t = label(el);
      if (!t || !isRejectText(t) || !visible(el) || !inBanner(el)) continue;
      el.click(); clicks++;
      return;
    }
  }

  chrome.storage.local.get({ cookieReject: true }).then(({ cookieReject }) => {
    if (!cookieReject) return;
    attempt();
    // Banners often appear late: watch the page for 15 s.
    let pending = false;
    const mo = new MutationObserver(() => {
      if (pending) return; pending = true;
      setTimeout(() => { pending = false; attempt(); }, 300);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    // Fade-in animations don't run in background tabs, so banners stay "invisible" there:
    // keep trying for a while and again whenever the tab becomes visible.
    const iv = setInterval(attempt, 1000);
    setTimeout(() => { mo.disconnect(); clearInterval(iv); }, 30000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      let n = 0; const t = setInterval(() => { attempt(); if (++n >= 8) clearInterval(t); }, 500);
    });
  });
})();
