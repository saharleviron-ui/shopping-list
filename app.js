/* רשימת הקניות שלנו — אפליקציה סטטית ל-GitHub Pages.
   הרשימה נשמרת בקובץ JSON בריפו (data/list.json) דרך GitHub API עם טוקן אישי.
   כל שינוי נשמר קודם בטלפון (עובד גם בלי קליטה) ואז מסונכרן. */
(() => {
'use strict';

const LS = {
  settings: 'sl_settings', base: 'sl_base', sha: 'sl_sha', pending: 'sl_pending', mode: 'sl_mode'
};
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const norm = s => String(s).toLowerCase().replace(/["'״׳`]/g, '').replace(/[-–_,.]/g, ' ').replace(/\s+/g, ' ').trim();
const emptyList = () => ({ version: 1, items: [], custom: [], updatedAt: null, updatedBy: null });

// ---------- state ----------
const S = {
  cats: [], catMap: {}, products: [],
  base: load(LS.base, emptyList()),
  sha: load(LS.sha, null),
  pending: load(LS.pending, []),
  settings: Object.assign(defaultSettings(), load(LS.settings, {})),
  mode: load(LS.mode, 'list'),
  status: 'off', lastSync: null, syncing: false, syncAgain: false,
  sugIndex: -1, sugItems: []
};

function defaultSettings() {
  const h = location.hostname, parts = location.pathname.split('/').filter(Boolean);
  let owner = '', repo = '';
  if (h.endsWith('.github.io')) { owner = h.split('.')[0]; repo = parts[0] || `${owner}.github.io`; }
  return { name: '', token: '', owner, repo, branch: 'main', path: 'data/list.json' };
}
const connected = () => !!(S.settings.token && S.settings.owner && S.settings.repo);

// ---------- operations (merge-safe) ----------
function findItem(list, op) {
  return list.items.find(i => i.id === op.id) || (op.n && list.items.find(i => norm(i.n) === norm(op.n)));
}
function applyOp(list, op) {
  switch (op.t) {
    case 'add': {
      const ex = list.items.find(i => norm(i.n) === norm(op.n));
      if (ex) {
        if (ex.done) { ex.done = false; ex.q = op.q; } else ex.q += op.q;
        if (op.c && ex.c === 'other') ex.c = op.c;
      } else list.items.push({ id: op.id, n: op.n, c: op.c || 'other', q: op.q || 1, done: false, by: op.by, at: op.at });
      break;
    }
    case 'qty': { const it = findItem(list, op); if (it) it.q = Math.max(1, op.q); break; }
    case 'cat': { const it = findItem(list, op); if (it) it.c = op.c;
      const cu = list.custom.find(x => norm(x.n) === norm(op.n)); if (cu) cu.c = op.c; break; }
    case 'del': { const it = findItem(list, op); if (it) list.items = list.items.filter(i => i !== it); break; }
    case 'done': { const it = findItem(list, op); if (it) { it.done = op.v; it.doneAt = op.v ? op.at : null; } break; }
    case 'clearDone': list.items = list.items.filter(i => !i.done); break;
    case 'custom': if (!list.custom.some(x => norm(x.n) === norm(op.n))) list.custom.push({ n: op.n, c: op.c }); break;
  }
  return list;
}
const view = () => S.pending.reduce((l, op) => applyOp(l, op), structuredClone(S.base));

function dispatch(op) {
  op.at = Date.now(); op.by = S.settings.name || '';
  S.pending.push(op); save(LS.pending, S.pending);
  render(); scheduleSync(900);
}

// ---------- GitHub sync ----------
const b64enc = str => { const bytes = new TextEncoder().encode(str); let bin = ''; bytes.forEach(b => bin += String.fromCharCode(b)); return btoa(bin); };
const b64dec = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), c => c.charCodeAt(0)));

function apiUrl() {
  const { owner, repo, path } = S.settings;
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
}
function headers() {
  return { 'Authorization': `Bearer ${S.settings.token.trim()}`, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
}
async function ghGet() {
  const r = await fetch(`${apiUrl()}?ref=${encodeURIComponent(S.settings.branch || 'main')}&t=${Date.now()}`, { headers: headers(), cache: 'no-store' });
  if (r.status === 404) return { list: emptyList(), sha: null };
  if (!r.ok) throw httpErr(r.status);
  const j = await r.json();
  let list; try { list = Object.assign(emptyList(), JSON.parse(b64dec(j.content))); } catch { list = emptyList(); }
  return { list, sha: j.sha };
}
async function ghPut(list, sha) {
  const body = {
    message: `עדכון רשימה${S.settings.name ? ' – ' + S.settings.name : ''}`,
    content: b64enc(JSON.stringify(list, null, 1)),
    branch: S.settings.branch || 'main'
  };
  if (sha) body.sha = sha;
  const r = await fetch(apiUrl(), { method: 'PUT', headers: headers(), body: JSON.stringify(body) });
  if (r.status === 409 || r.status === 422) return { conflict: true };
  if (!r.ok) throw httpErr(r.status);
  const j = await r.json();
  return { sha: j.content.sha };
}
function httpErr(code) {
  const msg = { 401: 'הטוקן לא תקין או שפג תוקפו', 403: 'לטוקן אין הרשאת כתיבה – ב-GitHub ערוך את הטוקן: Contents ← Read and write', 404: 'הריפו לא נמצא – בדוק שם משתמש ושם ריפו' }[code] || `שגיאת GitHub (${code})`;
  const e = new Error(msg); e.code = code; return e;
}

let syncTimer = null;
function scheduleSync(ms) { clearTimeout(syncTimer); syncTimer = setTimeout(sync, ms); }

async function sync() {
  if (!connected()) { setStatus('off'); return; }
  if (!navigator.onLine) { setStatus('err', 'אין חיבור לאינטרנט – השינויים שמורים ויישלחו כשיחזור'); return; }
  if (S.syncing) { S.syncAgain = true; return; }
  S.syncing = true; setStatus('busy');
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { list: remote, sha } = await ghGet();
      const n = S.pending.length;
      if (!n) { S.base = remote; S.sha = sha; break; }
      const merged = S.pending.slice(0, n).reduce((l, op) => applyOp(l, op), structuredClone(remote));
      merged.updatedAt = new Date().toISOString(); merged.updatedBy = S.settings.name || '';
      const res = await ghPut(merged, sha);
      if (res.conflict) continue; // מישהו אחר שמר בדיוק עכשיו – מושכים שוב וממזגים
      S.base = merged; S.sha = res.sha; S.pending = S.pending.slice(n);
      if (!S.pending.length) break;
    }
    save(LS.base, S.base); save(LS.sha, S.sha); save(LS.pending, S.pending);
    S.lastSync = new Date(); setStatus('ok');
  } catch (e) {
    setStatus('err', e.message || 'שגיאת סנכרון');
  } finally {
    S.syncing = false; render();
    if (S.syncAgain) { S.syncAgain = false; scheduleSync(300); }
  }
}

function setStatus(st, msg) {
  S.status = st;
  $('#syncDot').className = 'dot ' + st;
  const b = $('#banner');
  if (st === 'off') { b.innerHTML = 'הרשימה שמורה רק בטלפון הזה. <button data-act="openSettings">חבר ל-GitHub</button> כדי לשתף.'; b.classList.remove('hidden'); }
  else if (st === 'err') { b.innerHTML = esc(msg) + ' · <button data-act="sync">נסה שוב</button>'; b.classList.remove('hidden'); }
  else b.classList.add('hidden');
}

// ---------- catalog & search ----------
async function loadCatalog() {
  try {
    const r = await fetch('products.json');
    const d = await r.json();
    S.cats = d.categories; S.products = d.products;
  } catch { S.cats = [{ id: 'other', name: 'אחר', icon: '📦' }]; S.products = []; }
  S.catMap = Object.fromEntries(S.cats.map((c, i) => [c.id, Object.assign({ order: i }, c)]));
}
const cat = id => S.catMap[id] || S.catMap.other || { id: 'other', name: 'אחר', icon: '📦', order: 99 };

function search(q) {
  const nq = norm(q); if (!nq) return [];
  const toks = nq.split(' ');
  const pool = new Map();
  const list = view();
  for (const p of S.products) pool.set(norm(p.n), { n: p.n, c: p.c });
  for (const p of list.custom) pool.set(norm(p.n), { n: p.n, c: p.c });
  for (const i of list.items) if (!pool.has(norm(i.n))) pool.set(norm(i.n), { n: i.n, c: i.c });
  const out = [];
  for (const [k, p] of pool) {
    if (!toks.every(t => k.includes(t))) continue;
    let score = k === nq ? 0 : k.startsWith(nq) ? 1 : k.split(' ').some(w => w.startsWith(toks[0])) ? 2 : 3;
    out.push({ ...p, score, len: k.length });
  }
  out.sort((a, b) => a.score - b.score || a.len - b.len);
  return out.slice(0, 8);
}
function guessCat(name) {
  const r = search(name); if (r.length && r[0].score <= 2) return r[0].c;
  const first = norm(name).split(' ')[0];
  const p = first.length > 1 && S.products.find(p => norm(p.n).split(' ')[0] === first);
  return p ? p.c : 'other';
}
function highlight(name, q) {
  const toks = norm(q).split(' ').filter(Boolean);
  let h = esc(name);
  for (const t of toks) {
    const i = h.toLowerCase().indexOf(esc(t));
    if (i >= 0) h = h.slice(0, i) + '<b>' + h.slice(i, i + esc(t).length) + '</b>' + h.slice(i + esc(t).length);
  }
  return h;
}

function renderSuggest() {
  const q = $('#search').value;
  $('#clearSearch').classList.toggle('hidden', !q);
  const ul = $('#suggest');
  if (!q.trim()) { ul.classList.add('hidden'); S.sugItems = []; return; }
  const res = search(q);
  const list = view();
  const items = res.map(r => ({ ...r, onList: list.items.find(i => norm(i.n) === norm(r.n) && !i.done) }));
  if (!res.some(r => norm(r.n) === norm(q))) items.push({ n: q.trim(), c: guessCat(q), isNew: true });
  S.sugItems = items; if (S.sugIndex >= items.length) S.sugIndex = -1;
  ul.innerHTML = items.map((it, idx) => `
    <li data-idx="${idx}" class="${it.isNew ? 's-new' : ''} ${idx === S.sugIndex ? 'sel' : ''}" role="option">
      <span class="s-ic">${it.isNew ? '➕' : cat(it.c).icon}</span>
      <span class="s-name">${it.isNew ? 'הוסף "' + esc(it.n) + '"' : highlight(it.n, q)}</span>
      ${it.onList ? `<span class="s-tag">ברשימה ×${it.onList.q}</span>` : ''}
    </li>`).join('');
  ul.classList.remove('hidden');
}

function addProduct(it) {
  const name = it.n.trim(); if (!name) return;
  const isKnown = S.products.some(p => norm(p.n) === norm(name)) || view().custom.some(p => norm(p.n) === norm(name));
  if (!isKnown) dispatch({ t: 'custom', n: name, c: it.c || 'other' });
  dispatch({ t: 'add', id: uid(), n: name, c: it.c || 'other', q: 1 });
  $('#search').value = ''; S.sugIndex = -1; renderSuggest();
  $('#search').focus();
  toast(`נוסף: ${name}`);
}

// ---------- render ----------
function render() {
  document.body.classList.toggle('store', S.mode === 'store');
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.mode === S.mode));
  $('#addBar').classList.toggle('hidden', S.mode === 'store');
  const list = view();
  const todo = list.items.filter(i => !i.done), done = list.items.filter(i => i.done);
  const byCat = {};
  for (const i of todo) (byCat[i.c] ||= []).push(i);
  const groups = Object.keys(byCat).sort((a, b) => cat(a).order - cat(b).order);
  groups.forEach(g => byCat[g].sort((a, b) => a.n.localeCompare(b.n, 'he')));
  done.sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));

  let html = groups.map(g => `
    <div class="group">
      <div class="group-h">${cat(g).icon} ${esc(cat(g).name)} <span class="cnt">${byCat[g].length}</span></div>
      <div class="card">${byCat[g].map(rowHtml).join('')}</div>
    </div>`).join('');
  if (done.length) html += `
    <div class="group done-group">
      <div class="group-h">✓ בעגלה <span class="cnt">${done.length}</span></div>
      <div class="card">${done.map(rowHtml).join('')}</div>
    </div>`;
  $('#list').innerHTML = html;
  $('#empty').classList.toggle('hidden', list.items.length > 0);
  $('#empty p').innerHTML = S.mode === 'store' ? 'אין מה לקנות כרגע 🎉' : 'הרשימה ריקה.<br>הקלד מוצר למעלה כדי להוסיף.';

  const total = list.items.length;
  $('#storeHead').classList.toggle('hidden', S.mode !== 'store' || !total);
  $('#progressFill').style.width = total ? (done.length / total * 100) + '%' : '0';
  const t = S.lastSync ? S.lastSync.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) : null;
  $('#progressText').innerHTML = `<span>${done.length} מתוך ${total} בעגלה</span><span>${connected() ? (t ? 'עודכן ' + t : 'מעדכן…') : 'לא מסונכרן'}</span>`;
  $('#finishWrap').classList.toggle('hidden', !(S.mode === 'store' && done.length));
}

function rowHtml(i) {
  const store = S.mode === 'store';
  const meta = [i.by && !store ? 'הוסיף/ה: ' + i.by : ''].filter(Boolean).join(' · ');
  return `
  <div class="row ${i.done ? 'done' : ''}" data-id="${esc(i.id)}" ${store ? 'data-act="toggle"' : ''}>
    <button class="chk" data-act="toggle" aria-label="סמן">${i.done ? '✓' : ''}</button>
    ${store ? '' : `<button class="cat-btn" data-act="cat" aria-label="מחלקה">${cat(i.c).icon}</button>`}
    <div class="name"><div class="n">${esc(i.n)}</div>${meta ? `<div class="meta">${esc(meta)}</div>` : ''}</div>
    ${store
      ? (i.q > 1 ? `<span class="qty-badge">×${i.q}</span>` : '')
      : `<div class="qty"><button data-act="minus">−</button><span>${i.q}</span><button data-act="plus">+</button></div>
         <button class="del" data-act="del" aria-label="מחק">🗑</button>`}
  </div>`;
}

// ---------- toast ----------
let toastTimer;
function toast(msg, undo) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button id="undoBtn">ביטול</button>' : ''}`;
  t.classList.remove('hidden');
  if (undo) $('#undoBtn').onclick = () => { undo(); t.classList.add('hidden'); };
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), undo ? 5000 : 1600);
}

// ---------- events ----------
function itemById(id) { return view().items.find(i => i.id === id); }

document.addEventListener('click', e => {
  const actEl = e.target.closest('[data-act]'); if (!actEl) return;
  const act = actEl.dataset.act;
  const row = e.target.closest('.row'); const it = row && itemById(row.dataset.id);
  if (act === 'toggle' && it) { e.stopPropagation(); dispatch({ t: 'done', id: it.id, n: it.n, v: !it.done }); if (navigator.vibrate) navigator.vibrate(15); }
  else if (act === 'plus' && it) dispatch({ t: 'qty', id: it.id, n: it.n, q: it.q + 1 });
  else if (act === 'minus' && it) { if (it.q > 1) dispatch({ t: 'qty', id: it.id, n: it.n, q: it.q - 1 }); }
  else if (act === 'del' && it) {
    dispatch({ t: 'del', id: it.id, n: it.n });
    toast(`נמחק: ${it.n}`, () => dispatch({ t: 'add', id: uid(), n: it.n, c: it.c, q: it.q }));
  }
  else if (act === 'cat' && it) openCat(it);
  else if (act === 'openSettings') openSettings();
  else if (act === 'sync') sync();
});

document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  S.mode = t.dataset.mode; save(LS.mode, S.mode);
  if (S.mode === 'store') { sync(); window.scrollTo(0, 0); }
  render();
}));

const search$ = $('#search');
search$.addEventListener('input', () => { S.sugIndex = -1; renderSuggest(); });
search$.addEventListener('keydown', e => {
  const n = S.sugItems.length;
  if (e.key === 'ArrowDown' && n) { S.sugIndex = (S.sugIndex + 1) % n; renderSuggest(); e.preventDefault(); }
  else if (e.key === 'ArrowUp' && n) { S.sugIndex = (S.sugIndex - 1 + n) % n; renderSuggest(); e.preventDefault(); }
  else if (e.key === 'Enter') {
    // Enter מוסיף בדיוק את מה שהוקלד (או הצעה שסומנה בחיצים); בחירה בהצעה אחרת – בלחיצה עליה
    e.preventDefault();
    const q = norm(search$.value);
    const it = S.sugIndex >= 0 ? S.sugItems[S.sugIndex]
      : S.sugItems.find(x => norm(x.n) === q) || S.sugItems.find(x => x.isNew);
    if (it) addProduct(it);
  }
  else if (e.key === 'Escape') { search$.value = ''; renderSuggest(); }
});
$('#suggest').addEventListener('mousedown', e => e.preventDefault());
$('#suggest').addEventListener('click', e => { const li = e.target.closest('li'); if (li) addProduct(S.sugItems[+li.dataset.idx]); });
$('#clearSearch').addEventListener('click', () => { search$.value = ''; renderSuggest(); search$.focus(); });
document.addEventListener('click', e => { if (!e.target.closest('.add-bar')) $('#suggest').classList.add('hidden'); });
search$.addEventListener('focus', renderSuggest);

$('#finishBtn').addEventListener('click', () => {
  const doneItems = view().items.filter(i => i.done);
  dispatch({ t: 'clearDone' });
  toast(`נוקו ${doneItems.length} מוצרים מהעגלה`, () => doneItems.forEach(i => dispatch({ t: 'add', id: uid(), n: i.n, c: i.c, q: i.q })));
});
$('#syncBtn').addEventListener('click', () => connected() ? sync() : openSettings());
$('#settingsBtn').addEventListener('click', openSettings);

// settings
function openSettings() {
  const s = S.settings;
  $('#sName').value = s.name; $('#sToken').value = s.token; $('#sOwner').value = s.owner;
  $('#sRepo').value = s.repo; $('#sBranch').value = s.branch; $('#sPath').value = s.path;
  $('#sStatus').textContent = ''; $('#sStatus').className = 's-status';
  $('#settingsModal').classList.remove('hidden');
}
$('#sClose').addEventListener('click', () => $('#settingsModal').classList.add('hidden'));
$('#sSave').addEventListener('click', async () => {
  S.settings = {
    name: $('#sName').value.trim(), token: $('#sToken').value.trim(),
    owner: $('#sOwner').value.trim(), repo: $('#sRepo').value.trim(),
    branch: $('#sBranch').value.trim() || 'main', path: $('#sPath').value.trim() || 'data/list.json'
  };
  save(LS.settings, S.settings);
  const st = $('#sStatus');
  if (!connected()) { st.textContent = 'חסר טוקן, משתמש או שם ריפו'; st.className = 's-status err'; return; }
  st.textContent = 'בודק חיבור…'; st.className = 's-status';
  try {
    await ghGet(); st.textContent = '✓ מחובר! הרשימה תסונכרן אוטומטית.'; st.className = 's-status ok';
    // שינויים שנעשו לפני החיבור נשמרים ונשלחים כ-pending
    await sync(); setTimeout(() => $('#settingsModal').classList.add('hidden'), 900);
  } catch (e) { st.textContent = e.message; st.className = 's-status err'; }
});

// category picker
let catTarget = null;
function openCat(it) {
  catTarget = it;
  $('#catTitle').textContent = `מחלקה עבור "${it.n}"`;
  $('#catGrid').innerHTML = S.cats.map(c => `<button data-c="${c.id}" class="${c.id === it.c ? 'cur' : ''}">${c.icon} ${esc(c.name)}</button>`).join('');
  $('#catModal').classList.remove('hidden');
}
$('#catGrid').addEventListener('click', e => {
  const b = e.target.closest('button[data-c]'); if (!b || !catTarget) return;
  dispatch({ t: 'cat', id: catTarget.id, n: catTarget.n, c: b.dataset.c });
  $('#catModal').classList.add('hidden');
});
$('#catClose').addEventListener('click', () => $('#catModal').classList.add('hidden'));
document.querySelectorAll('.modal').forEach(m => m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); }));

// refresh when coming back to the app + light polling
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
window.addEventListener('online', () => sync());
setInterval(() => { if (!document.hidden && !S.syncing) sync(); }, 20000);

// ---------- boot ----------
(async () => {
  await loadCatalog();
  render();
  setStatus(connected() ? 'busy' : 'off');
  sync();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();

// for tests
window.__SL = { S, applyOp, view, search };
})();
