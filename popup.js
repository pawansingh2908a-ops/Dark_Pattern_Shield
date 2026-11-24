const $ = id => document.getElementById(id);
const CAT = {
  smalltext: 'Small / low-visibility text',
  hidden: 'Hidden information',
  subscription: 'Subscriptions & renewals',
  charges: 'Hidden charges',
  terms: 'Terms & conditions summary',
  darkpattern: 'Deceptive design'
};

async function send(msg) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try { return await chrome.tabs.sendMessage(tab.id, msg); } catch (e) { return null; }
}

function render(data) {
  const box = $('results'); box.textContent = '';
  if (!data) { $('risk').textContent = '–'; $('risk').className = 'badge'; $('msg').textContent = 'This page cannot be scanned (browser pages and the Web Store are off-limits). Try reloading the tab.'; return; }
  $('risk').textContent = data.risk.level === 'None' ? 'No issues' : data.risk.level + ' risk';
  $('risk').className = 'badge ' + data.risk.level;
  $('msg').textContent = data.findings.length ? `${data.findings.length} thing(s) worth a look. Click one to jump to it.` : 'Nothing suspicious detected on this page.';
  Object.keys(CAT).forEach(cat => {
    const list = data.findings.filter(f => f.category === cat);
    if (!list.length) return;
    const h = document.createElement('div'); h.className = 'cat'; h.textContent = CAT[cat]; box.appendChild(h);
    list.forEach(f => {
      const b = document.createElement('button'); b.className = 'item';
      const t = document.createElement('div'); t.className = 't';
      const d = document.createElement('span'); d.className = 'd ' + f.sev;
      const s = document.createElement('span'); s.textContent = f.title;
      t.append(d, s);
      const w = document.createElement('div'); w.className = 'w'; w.textContent = f.why;
      const q = document.createElement('div'); q.className = 'q'; q.textContent = '“' + f.detail + '”' + (f.source ? '  (' + f.source + ')' : '');
      b.append(t, w, q);
      b.addEventListener('click', () => send({ type: 'DPS_FOCUS', id: f.id }));
      box.appendChild(b);
    });
  });
}

$('scan').addEventListener('click', async () => {
  $('scan').disabled = true; $('scan').textContent = 'Scanning…';
  render(await send({ type: 'DPS_SCAN' }));
  $('scan').disabled = false; $('scan').textContent = 'Scan this page';
});

chrome.storage.sync.get({ highlight: true, autoScan: true }, v => {
  $('highlight').checked = v.highlight; $('autoScan').checked = v.autoScan;
});
$('highlight').addEventListener('change', e => { chrome.storage.sync.set({ highlight: e.target.checked }); send({ type: 'DPS_HIGHLIGHT', on: e.target.checked }); });
$('autoScan').addEventListener('change', e => chrome.storage.sync.set({ autoScan: e.target.checked }));

send({ type: 'DPS_GET' }).then(render);
