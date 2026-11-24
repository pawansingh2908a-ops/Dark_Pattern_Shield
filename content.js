// Dark Pattern Shield - content script. All analysis is local; nothing leaves the browser.
(() => {
  if (window.__dpsLoaded) return;
  window.__dpsLoaded = true;

  const SETTINGS = { autoScan: true, highlight: true };
  const MAX_TEXT_NODES = 8000;
  const CAP_PER_CATEGORY = 8;

  // ---------- Rule tables ----------
  const SUB_RULES = [
    { re: /auto(matically)?[\s-]*renew|renews? (automatically|every)|will be (automatically )?(charged|billed)|recurring (payment|charge|billing)/i,
      title: 'Automatic renewal / recurring billing', sev: 'high',
      why: 'You may be charged again and again until you cancel.' },
    { re: /free trial|trial (period|ends|expires)|after (your|the) (free )?trial|then [\$₹€£]?\s?[\d.,]+\s*(\/|per)\s*(mo|month|year|yr|week)/i,
      title: 'Free trial that converts to a paid plan', sev: 'high',
      why: 'The trial likely turns into a paid subscription unless you cancel before it ends.' },
    { re: /cancel(lation)?[^.]{0,40}(fee|penalt|before|within|\d+\s*(hours|days))|non-?refundable|no refunds?|early termination/i,
      title: 'Cancellation or refund restrictions', sev: 'high',
      why: 'Cancelling may cost money, have a deadline, or not return what you paid.' },
    { re: /[\$₹€£]\s?[\d,.]+\s*(\/|per|a)\s*(mo|month|yr|year|week)|billed (monthly|annually|yearly|weekly)/i,
      title: 'Recurring price', sev: 'medium',
      why: 'This is the amount you will keep paying on a schedule.' }
  ];
  const CHARGE_RULES = [
    { re: /(processing|service|convenience|handling|booking|platform|resort|admin(istration)?|delivery|packaging) (fee|charge)s?/i,
      title: 'Extra fee mentioned', sev: 'medium',
      why: 'A fee that may be added on top of the price you first saw.' },
    { re: /additional (fees|charges|costs)|taxes? (extra|not included|and fees)|plus (applicable )?(taxes|gst|vat)|shipping (calculated|fees? apply)|excl(uding|\.)? (tax|gst|vat)/i,
      title: 'Price may increase at checkout', sev: 'medium',
      why: 'The final total may be higher than the headline price.' }
  ];
  const KW = /renew|subscri|cancel|trial|billed|charge|fee|refund|recurring|auto-?pay|per (month|year)|penalt|non-?refundable|terms/i;
  const URGENCY = /(only|just)\s+\d+\s+(left|remaining|rooms?|seats?|items?)|hurry|ends? (in|soon|today|tonight)|limited[- ]time|offer expires|\d+\s+(people|others|users)\s+(are\s+)?(viewing|looking|watching)|selling fast|last chance|almost (gone|sold out)/i;
  const SHAMING = /no,? thanks?,? i (don'?t|do not|hate|prefer|like|want)|i('|’)?ll (pay full|miss out|stay|pass on)|no,? i (don'?t|do not)|i don'?t (want|need|like) (to )?(save|discount|protect)/i;
  const TRICKY = /uncheck (this )?(box )?to (not|opt)|check (this )?(box )?to (not|opt.?out|decline)|do not (un)?check/i;
  const PRESELECT_LABEL = /newsletter|offers?|promo|market|partner|third|insur|protect|donat|add[- ]?on|extra|subscribe|renew|share|updates|deals|warranty/i;
  const PRESELECT_HIGH = /insur|donat|renew|add[- ]?on|protect|warranty/i;

  const CLAUSES = [
    { re: /auto(matically)?[\s-]*renew|renew(s|al)? (automatically|unless)/i, label: 'Auto-renewal', sev: 'high', plain: 'Your plan renews and charges you again unless you cancel in time.' },
    { re: /cancel[^.]{0,80}(notice|before|prior|within|fee|penalt|written)|early termination/i, label: 'Cancellation conditions', sev: 'high', plain: 'Cancelling has deadlines, notice rules or fees.' },
    { re: /non-?refundable|no refunds?|not (be )?(entitled to|eligible for) (a )?refund|refunds? (are|is) (not|only)/i, label: 'Refund limits', sev: 'high', plain: 'You may not get your money back.' },
    { re: /binding arbitration|class[- ]action|waive[^.]{0,40}(jury|right)/i, label: 'Arbitration / waiver of legal rights', sev: 'high', plain: 'You may give up the right to sue or join a class action.' },
    { re: /(reserve the right|may|can)[^.]{0,30}(change|modify|increase|adjust)[^.]{0,30}(price|pricing|fees?|rates?)/i, label: 'Price can change', sev: 'medium', plain: 'The company can raise prices or fees later.' },
    { re: /(modify|change|update|amend)[^.]{0,30}(these )?(terms|agreement)[^.]{0,40}(at any time|without|sole discretion)/i, label: 'Terms can change without notice', sev: 'medium', plain: 'The rules you agreed to can be changed later.' },
    { re: /(share|sell|disclose|transfer)[^.]{0,80}(third[- ]part|partners|affiliates|advertis|data brokers)/i, label: 'Data shared with others', sev: 'medium', plain: 'Your personal data may be shared with or sold to other companies.' },
    { re: /(perpetual|irrevocable)[^.]{0,60}licen[sc]e/i, label: 'Broad license over your content', sev: 'medium', plain: 'The company may keep using what you upload, indefinitely.' },
    { re: /not (be )?liable|in no event[^.]{0,40}liable|disclaim[^.]{0,30}warrant/i, label: 'Limited liability', sev: 'low', plain: 'The company limits what it owes you if something goes wrong.' }
  ];

  // ---------- State ----------
  let findings = [];
  let elMap = new Map();
  let decorated = new Set();
  let seen = new Set();
  let counts = {};
  let nextId = 1;
  let scanning = false;
  let termsCache = null;
  let rescans = 0;
  let host = null, pill = null, panel = null, listEl = null;

  // ---------- Helpers ----------
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const snippet = (s, n = 170) => { s = clean(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

  function parseColor(c) {
    const m = (c || '').match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = c => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  function bgOf(el) {
    while (el) {
      const c = parseColor(getComputedStyle(el).backgroundColor);
      if (c && c.a > 0.6) return c;
      el = el.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  }
  function visibleAncestor(el) {
    while (el && el !== document.body && el !== document.documentElement && el.getClientRects().length === 0) el = el.parentElement;
    return el;
  }
  function labelOf(el) {
    return clean(el.innerText || el.value || el.getAttribute('aria-label') || '');
  }

  function decorate(el, f) {
    if (!el || el === document.body || el === document.documentElement) return;
    el.classList.add('dps-hl', 'dps-' + f.sev);
    if (!el.hasAttribute('title')) {
      el.setAttribute('title', '⚠ Dark Pattern Shield: ' + f.title);
      el.dataset.dpsTitle = '1';
    }
    decorated.add(el);
  }
  function clearAll() {
    decorated.forEach(el => {
      el.classList.remove('dps-hl', 'dps-low', 'dps-medium', 'dps-high', 'dps-flash');
      if (el.dataset && el.dataset.dpsTitle) { el.removeAttribute('title'); delete el.dataset.dpsTitle; }
    });
    decorated = new Set(); elMap = new Map(); findings = []; seen = new Set(); counts = {}; nextId = 1;
  }
  function addFinding(f, el) {
    if ((counts[f.category] || 0) >= CAP_PER_CATEGORY) return;
    const key = f.category + '|' + f.title + '|' + f.detail.slice(0, 60);
    if (seen.has(key)) return;
    seen.add(key);
    counts[f.category] = (counts[f.category] || 0) + 1;
    f.id = nextId++;
    findings.push(f);
    if (el) {
      const target = visibleAncestor(el);
      if (target) { elMap.set(f.id, target); decorate(target, f); }
    }
  }

  // ---------- Detectors ----------
  function collectBlocks() {
    const map = new Map();
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n, count = 0;
    while ((n = w.nextNode()) && count < MAX_TEXT_NODES) {
      const p = n.parentElement;
      if (!p || p.closest('script,style,noscript,textarea,svg')) continue;
      const t = n.nodeValue;
      if (!t || t.trim().length < 4) continue;
      map.set(p, (map.get(p) || '') + ' ' + t);
      count++;
    }
    return map;
  }

  function detectText() {
    const bodyFs = parseFloat(getComputedStyle(document.body).fontSize) || 16;
    for (const [el, raw] of collectBlocks()) {
      const t = clean(raw);
      if (t.length < 12 || t.length > 1200) continue;
      const sub = SUB_RULES.find(r => r.re.test(t));
      const chg = CHARGE_RULES.find(r => r.re.test(t));
      const important = sub || chg;

      // Hidden (display:none / collapsed) text about money
      if (el.getClientRects().length === 0) {
        if (important && t.length >= 25) {
          addFinding({ category: 'hidden', sev: 'medium',
            title: 'Hidden text: ' + (sub || chg).title.toLowerCase(),
            detail: snippet(t), why: 'This information exists in the page but is not visible unless something is expanded or clicked.' }, el);
        }
        continue;
      }

      const cs = getComputedStyle(el);
      if (KW.test(t) || important) {
        const fs = parseFloat(cs.fontSize);
        if (fs && (fs < 11 || (fs < bodyFs * 0.7 && fs < 13))) {
          addFinding({ category: 'smalltext', sev: important ? 'high' : 'medium',
            title: `Tiny text (${Math.round(fs)}px) about terms or payments`, detail: snippet(t),
            why: 'Important conditions are shown much smaller than the rest of the page.' }, el);
        }
        let fg = parseColor(cs.color);
        const bg = bgOf(el);
        if (fg) {
          if (fg.a < 1) fg = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 };
          const cr = contrast(fg, bg);
          if (cr < 2 || parseFloat(cs.opacity) < 0.4) {
            addFinding({ category: 'smalltext', sev: 'medium', title: 'Faint, low-contrast text about terms or payments',
              detail: snippet(t), why: 'The text blends into its background, so it is easy to miss.' }, el);
          }
        }
      }

      if (sub) addFinding({ category: 'subscription', sev: sub.sev, title: sub.title, detail: snippet(t), why: sub.why }, el);
      if (chg) addFinding({ category: 'charges', sev: chg.sev, title: chg.title, detail: snippet(t), why: chg.why }, el);
      if (t.length < 140 && URGENCY.test(t)) {
        addFinding({ category: 'darkpattern', sev: 'low', title: 'Urgency / scarcity pressure', detail: snippet(t),
          why: 'Pressure wording can rush you into deciding before you read the details.' }, el);
      }
    }

    // Collapsed accordions holding money-related terms
    const rules = SUB_RULES.concat(CHARGE_RULES);
    document.querySelectorAll('details:not([open])').forEach(d => {
      const t = clean(d.textContent);
      if (t.length < 4000 && rules.some(r => r.re.test(t))) {
        addFinding({ category: 'hidden', sev: 'medium', title: 'Important terms inside a collapsed section', detail: snippet(t),
          why: 'Payment or cancellation details are tucked away until you expand this section.' }, d);
      }
    });
    document.querySelectorAll('[aria-expanded="false"][aria-controls]').forEach(btn => {
      const target = document.getElementById(btn.getAttribute('aria-controls'));
      if (!target) return;
      const t = clean(target.textContent);
      if (t.length < 4000 && rules.some(r => r.re.test(t))) {
        addFinding({ category: 'hidden', sev: 'medium', title: 'Important terms inside a collapsed section', detail: snippet(t),
          why: 'Payment or cancellation details are tucked away until you expand this section.' }, btn);
      }
    });
    document.querySelectorAll('[class*="countdown" i],[id*="countdown" i],[class*="timer" i]').forEach(el => {
      if (el.getClientRects().length) addFinding({ category: 'darkpattern', sev: 'low', title: 'Countdown timer',
        detail: snippet(el.textContent) || 'Countdown element', why: 'Timers are often used to create artificial pressure.' }, el);
    });
  }

  function detectInteractions() {
    // Pre-selected boxes
    document.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
      const lbl = clean((cb.labels && cb.labels[0] && cb.labels[0].textContent) || cb.getAttribute('aria-label') || (cb.parentElement && cb.parentElement.textContent));
      if (lbl && PRESELECT_LABEL.test(lbl)) {
        addFinding({ category: 'darkpattern', sev: PRESELECT_HIGH.test(lbl) ? 'high' : 'medium', title: 'Pre-ticked option',
          detail: snippet(lbl), why: 'An extra, marketing or paid option was selected for you. Untick it if you do not want it.' },
          (cb.labels && cb.labels[0]) || cb.parentElement);
      }
    });

    const clickables = [...document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"], label')];
    const items = clickables.map(el => ({ el, text: labelOf(el) })).filter(x => x.text && x.text.length < 90);

    items.forEach(({ el, text }) => {
      if (SHAMING.test(text)) addFinding({ category: 'darkpattern', sev: 'medium', title: 'Confirm-shaming',
        detail: snippet(text), why: 'The decline option is worded to make you feel bad for saying no.' }, el);
      if (TRICKY.test(text)) addFinding({ category: 'darkpattern', sev: 'medium', title: 'Confusing opt-out wording',
        detail: snippet(text), why: 'The tick-box logic is reversed, so you may opt in when you meant to opt out.' }, el);
    });

    // Consent banner asymmetry
    const ACCEPT = /^(accept|agree|allow|ok\b|got it|i agree|yes)/i;
    const REJECT = /^(reject|decline|deny|refuse|only (necessary|essential)|necessary only|no thanks|manage|customi[sz]e|settings|more options)/i;
    const sel = 'button, a, [role="button"]';
    items.filter(x => ACCEPT.test(x.text) && x.text.length < 30 && x.el.matches(sel)).forEach(({ el: a, text }) => {
      let box = a.parentElement, rej = null;
      for (let i = 0; i < 4 && box; i++, box = box.parentElement) {
        rej = [...box.querySelectorAll(sel)].find(x => x !== a && REJECT.test(labelOf(x)));
        if (rej) break;
      }
      const inConsent = a.closest('[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i]');
      if (!rej) {
        if (inConsent) addFinding({ category: 'darkpattern', sev: 'medium', title: 'No clear "reject" option',
          detail: `"${text}" is offered with no obvious way to decline.`, why: 'Consent should be as easy to refuse as to give.' }, a);
        return;
      }
      const ra = a.getBoundingClientRect(), rr = rej.getBoundingClientRect();
      if (!ra.width || !rr.width) return;
      const bgA = parseColor(getComputedStyle(a).backgroundColor), bgR = parseColor(getComputedStyle(rej).backgroundColor);
      const filledA = bgA && bgA.a > 0.5, filledR = bgR && bgR.a > 0.5;
      if (rr.width * rr.height < ra.width * ra.height * 0.55 || (filledA && !filledR)) {
        addFinding({ category: 'darkpattern', sev: 'medium', title: 'Lopsided accept / decline buttons',
          detail: `"${text}" is prominent while "${labelOf(rej)}" is downplayed.`,
          why: 'Styling steers you towards accepting instead of making both choices equally easy.' }, rej);
      }
    });

    // Subscription found but no cancel path on this page
    if (findings.some(f => f.category === 'subscription') && !items.some(x => /cancel|unsubscribe|manage (my )?(subscription|plan)/i.test(x.text))) {
      addFinding({ category: 'darkpattern', sev: 'low', title: 'No cancellation link found on this page',
        detail: 'Recurring billing is mentioned but no cancel / manage-subscription control was found here.',
        why: 'Check how you would cancel before you sign up. It may be buried in account settings.' }, null);
    }
  }

  // ---------- Terms & conditions analysis ----------
  function extractClauses(text, source) {
    const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/).map(clean).filter(s => s.length > 40 && s.length < 450);
    const out = [];
    CLAUSES.forEach(c => {
      sentences.filter(s => c.re.test(s)).slice(0, 2).forEach(s =>
        out.push({ category: 'terms', sev: c.sev, title: c.label, detail: snippet(s, 260), why: c.plain, source }));
    });
    return out;
  }

  async function getTerms() {
    if (termsCache && termsCache.url === location.href) return termsCache.findings;
    const sources = [];
    if (/terms|conditions|privacy|legal|\btos\b|policy|agreement/i.test(location.pathname + ' ' + document.title)) {
      sources.push({ name: 'This page', text: document.body.innerText });
    }
    document.querySelectorAll('[role="dialog"], [id*="terms" i], [class*="terms" i]').forEach(d => {
      const t = d.innerText || '';
      if (t.length > 1500) sources.push({ name: 'Terms box on this page', text: t });
    });
    const links = [...document.querySelectorAll('a[href]')].filter(a => {
      try {
        const u = new URL(a.href, location.href);
        return u.origin === location.origin && /terms|conditions|\btos\b|user agreement|subscriber agreement|refund|cancellation/i.test(clean(a.textContent) + ' ' + u.pathname);
      } catch (e) { return false; }
    });
    const urls = [...new Set(links.map(a => a.href))].filter(u => u !== location.href).slice(0, 3);
    for (const url of urls) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 6000);
        const res = await fetch(url, { credentials: 'omit', signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) continue;
        const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
        doc.querySelectorAll('script,style,noscript,nav,header,footer').forEach(n => n.remove());
        sources.push({ name: new URL(url).pathname, text: doc.body ? doc.body.textContent : '' });
      } catch (e) { /* cross-origin or blocked: skip */ }
    }
    const results = [];
    const used = new Set();
    sources.forEach(s => extractClauses(s.text || '', s.name).forEach(f => {
      const k = f.title + f.detail.slice(0, 50);
      if (!used.has(k)) { used.add(k); results.push(f); }
    }));
    termsCache = { url: location.href, findings: results };
    return results;
  }

  // ---------- Scoring + UI ----------
  function risk() {
    const w = { high: 3, medium: 2, low: 1 };
    const score = findings.reduce((s, f) => s + w[f.sev], 0);
    const level = score === 0 ? 'None' : score < 4 ? 'Low' : score < 9 ? 'Medium' : 'High';
    return { score, level };
  }
  function payload() {
    return { url: location.href, risk: risk(), findings: findings.map(f => ({ ...f })) };
  }

  function ensurePanel() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'dps-host';
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>
      *{box-sizing:border-box;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
      .pill{border:0;border-radius:999px;padding:10px 16px;font-size:13px;font-weight:600;color:#fff;background:#1f2937;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.3);display:block;margin-left:auto}
      .pill.High{background:#c62828}.pill.Medium{background:#b26a00}.pill.Low{background:#1d4ed8}
      .panel{width:340px;max-height:60vh;overflow:auto;background:#fff;color:#111;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.35);margin-bottom:10px}
      .panel[hidden]{display:none}
      .hd{padding:12px 14px;font-size:13px;font-weight:700;border-bottom:1px solid #eee;position:sticky;top:0;background:#fff}
      .it{display:block;width:100%;text-align:left;border:0;background:none;padding:10px 14px;border-bottom:1px solid #f1f1f1;cursor:pointer}
      .it:hover{background:#f7f7f9}
      .t{font-size:13px;font-weight:600;display:flex;gap:8px;align-items:center}
      .d{width:9px;height:9px;border-radius:50%;flex:none}
      .high{background:#e5484d}.medium{background:#f5a524}.low{background:#3b82f6}
      .w{font-size:12px;color:#444;margin-top:3px}
      .q{font-size:11px;color:#777;margin-top:3px;font-style:italic}
    </style><div class="panel" hidden></div><button class="pill"></button>`;
    panel = shadow.querySelector('.panel');
    pill = shadow.querySelector('.pill');
    pill.addEventListener('click', () => { panel.hidden = !panel.hidden; });
    document.documentElement.appendChild(host);
  }

  function render() {
    document.documentElement.classList.toggle('dps-on', SETTINGS.highlight);
    if (!findings.length) { if (host) { host.remove(); host = null; } return; }
    ensurePanel();
    if (!host.isConnected) document.documentElement.appendChild(host);
    const r = risk();
    pill.className = 'pill ' + r.level;
    pill.textContent = `🛡 ${findings.length} warning${findings.length > 1 ? 's' : ''} · ${r.level} risk`;
    panel.textContent = '';
    const hd = document.createElement('div'); hd.className = 'hd'; hd.textContent = 'Dark Pattern Shield'; panel.appendChild(hd);
    [...findings].sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.sev] - { high: 0, medium: 1, low: 2 }[b.sev])).forEach(f => {
      const b = document.createElement('button'); b.className = 'it';
      const t = document.createElement('div'); t.className = 't';
      const dot = document.createElement('span'); dot.className = 'd ' + f.sev;
      const tt = document.createElement('span'); tt.textContent = f.title;
      t.append(dot, tt);
      const w = document.createElement('div'); w.className = 'w'; w.textContent = f.why;
      const q = document.createElement('div'); q.className = 'q'; q.textContent = '“' + f.detail + '”';
      b.append(t, w, q);
      b.addEventListener('click', () => focusFinding(f.id));
      panel.appendChild(b);
    });
  }

  function focusFinding(id) {
    const el = elMap.get(id);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('dps-flash');
    setTimeout(() => el.classList.remove('dps-flash'), 1800);
  }

  // ---------- Orchestration ----------
  async function scan() {
    if (scanning) return;
    scanning = true;
    try {
      clearAll();
      if (!document.body) return;
      detectText();
      detectInteractions();
      render();
      const terms = await getTerms();
      terms.forEach(f => addFinding({ ...f }, null));
      render();
    } finally { scanning = false; }
  }

  chrome.runtime.onMessage.addListener((msg, _s, send) => {
    if (msg.type === 'DPS_SCAN') { termsCache = null; scan().then(() => send(payload())); return true; }
    if (msg.type === 'DPS_GET') { send(payload()); return; }
    if (msg.type === 'DPS_FOCUS') { focusFinding(msg.id); send({ ok: true }); return; }
    if (msg.type === 'DPS_HIGHLIGHT') { SETTINGS.highlight = msg.on; document.documentElement.classList.toggle('dps-on', msg.on); send({ ok: true }); return; }
  });

  function observe() {
    let timer = null;
    new MutationObserver(muts => {
      if (!SETTINGS.autoScan || rescans >= 4 || scanning) return;
      const real = muts.some(m => [...m.addedNodes].some(n => n.id !== 'dps-host'));
      if (!real) return;
      clearTimeout(timer);
      timer = setTimeout(() => { rescans++; scan(); }, 2500);
    }).observe(document.body, { childList: true, subtree: true });
  }

  chrome.storage.sync.get(SETTINGS, v => {
    Object.assign(SETTINGS, v);
    if (SETTINGS.autoScan) { setTimeout(scan, 800); observe(); }
  });
  chrome.storage.onChanged.addListener(ch => {
    if (ch.highlight) { SETTINGS.highlight = ch.highlight.newValue; document.documentElement.classList.toggle('dps-on', SETTINGS.highlight); }
    if (ch.autoScan) SETTINGS.autoScan = ch.autoScan.newValue;
  });
})();
