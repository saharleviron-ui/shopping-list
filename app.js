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
const emptyList = () => ({ version: 1, items: [], custom: [], history: [], updatedAt: null, updatedBy: null });

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
    case 'finish': { // הקנייה הושלמה: רושמים בהיסטוריה ומוחקים את מה שנקנה
      const bought = list.items.filter(i => i.done); if (!bought.length) break;
      list.history = list.history || [];
      if (!list.history.some(h => h.id === op.id))
        list.history.unshift({ id: op.id, at: op.at, by: op.by, items: bought.map(i => ({ n: i.n, c: i.c, q: i.q })) });
      list.history = list.history.slice(0, 60);
      list.items = list.items.filter(i => !i.done); break;
    }
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
// בדיקה מפורטת של הטוקן: האם יש לו הרשאת כתיבה לריפו, ואם לא – מה בדיוק לתקן
async function checkToken() {
  const { owner, repo, token } = S.settings;
  const r = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}?t=${Date.now()}`, { headers: headers(), cache: 'no-store' });
  if (r.status === 401) throw new Error('הטוקן לא תקין או שפג תוקפו – צור טוקן חדש והדבק אותו');
  if (r.status === 404) throw new Error(`הריפו ${owner}/${repo} לא נמצא, או שהטוקן לא כולל אותו`);
  if (!r.ok) throw httpErr(r.status);
  const j = await r.json();
  if (j.permissions && j.permissions.push) return true;
  const classic = token.trim().startsWith('ghp_');
  throw new Error(classic
    ? 'טוקן קלאסי בלי הרשאה: צור טוקן חדש וסמן V ליד public_repo (או repo)'
    : 'טוקן בלי הרשאת כתיבה: בהגדרות הטוקן ב-GitHub, Repository access ← בחר shopping-list, ו-Contents ← Read and write');
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
    let msg = e.message || 'שגיאת סנכרון';
    if (e.code === 403) { try { await checkToken(); } catch (e2) { msg = e2.message; } }
    setStatus('err', msg);
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
      <span class="s-ic" style="--c:${catColor(it.c)}">${it.isNew ? '+' : cat(it.c).icon}</span>
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
// צבע לכל מחלקה – כמו שלטי המעברים בסופר
const CAT_COLORS = {
  produce: '#4dff88', bakery: '#ffc94d', dairy: '#4db8ff', meat: '#ff5a6e', deli: '#ff8a4d',
  dry: '#e0b07a', cans: '#ff6b4d', baking: '#b48cff', breakfast: '#ffe14d', snacks: '#ff47e6',
  drinks: '#27e3ff', coffee: '#d49a6a', frozen: '#8ae9ff', baby: '#ff9ccf', hygiene: '#8c9dff',
  cleaning: '#2effd2', pets: '#c9a27e', other: '#a5a3b8'
}
const catColor = id => CAT_COLORS[id] || CAT_COLORS.other;
const ICON = {
  minus: '<svg viewBox="0 0 24 24"><path d="M6 12h12"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 6v12M6 12h12"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'
};

function render() {
  document.body.dataset.mode = S.mode;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.mode === S.mode));
  $('#addBar').classList.toggle('hidden', S.mode !== 'list');
  const list = view();
  if (S.mode === 'history') return renderHistory(list);
  const todo = list.items.filter(i => !i.done), done = list.items.filter(i => i.done);
  const byCat = {};
  for (const i of todo) (byCat[i.c] ||= []).push(i);
  const groups = Object.keys(byCat).sort((a, b) => cat(a).order - cat(b).order);
  groups.forEach(g => byCat[g].sort((a, b) => a.n.localeCompare(b.n, 'he')));
  done.sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));

  let html = groups.map(g => `
    <section class="aisle" style="--c:${catColor(g)}">
      <h2 class="aisle-sign"><span class="aisle-ic">${cat(g).icon}</span><span class="aisle-name">${esc(cat(g).name)}</span><span class="aisle-n">${byCat[g].length}</span></h2>
      <div class="shelf">${byCat[g].map(rowHtml).join('')}</div>
    </section>`).join('');
  if (done.length) html += `
    <section class="aisle cart" style="--c:#58ff9c">
      <h2 class="aisle-sign"><span class="aisle-ic">🛒</span><span class="aisle-name">כבר בעגלה</span><span class="aisle-n">${done.length}</span></h2>
      <div class="shelf">${done.map(rowHtml).join('')}</div>
    </section>`;
  $('#list').innerHTML = html;
  S.justDone = null;
  $('#empty').classList.toggle('hidden', list.items.length > 0);
  $('#empty').innerHTML = S.mode === 'store'
    ? '<div class="empty-big">הכל בעגלה</div><p>אין מה לקנות כרגע.</p>'
    : '<div class="empty-big">הרשימה ריקה</div><p>כתבו למעלה מה חסר בבית, למשל "חלב" או "במבה".</p>';

  const total = list.items.length;
  const t = S.lastSync ? S.lastSync.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) : null;
  const syncTxt = connected() ? (t ? `מעודכן מ-${t}` : 'מתעדכן…') : 'לא מסונכרן';
  const nCats = groups.length;
  $('#subline').textContent = S.mode === 'store'
    ? syncTxt
    : (todo.length ? `${todo.length} מוצרים ב-${nCats} מחלקות` : 'אין מוצרים ברשימה');

  $('#storeHead').classList.toggle('hidden', S.mode !== 'store' || !total);
  $('#storeCount').innerHTML = `<b>${done.length}</b><span>/${total}</span>`;
  $('#storeLabel').textContent = todo.length ? `נשארו ${todo.length} לאסוף` : 'הכל נאסף';
  $('#segments').innerHTML = list.items.map((_, k) => `<i class="${k < done.length ? 'on' : ''}"></i>`).join('');
  $('#finishWrap').classList.toggle('hidden', !(S.mode === 'store' && done.length));
}

function renderHistory(list) {
  const h = list.history || [];
  const fmtDay = ts => new Date(ts).toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric' });
  const fmtTime = ts => new Date(ts).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  $('#list').innerHTML = h.map(e => `
    <details class="receipt">
      <summary>
        <span class="r-day">${esc(fmtDay(e.at))}</span>
        <span class="r-meta">${esc(fmtTime(e.at))}${e.by ? ', ' + esc(e.by) : ''}</span>
        <span class="r-n">${e.items.length}<small>מוצרים</small></span>
      </summary>
      <ul class="r-items">${e.items.map(i => `<li style="--c:${catColor(i.c)}"><span>${esc(i.n)}</span>${i.q > 1 ? `<b>×${i.q}</b>` : ''}</li>`).join('')}</ul>
      <button class="r-again" data-act="again" data-hid="${esc(e.id)}">הוסף את כל המוצרים שוב לרשימה</button>
    </details>`).join('');
  $('#empty').classList.toggle('hidden', h.length > 0);
  $('#empty').innerHTML = '<div class="empty-big">עוד אין קניות</div><p>כשמסיימים קנייה היא נשמרת כאן, ואפשר להוסיף אותה שוב לרשימה בלחיצה.</p>';
  $('#subline').textContent = h.length ? `${h.length} קניות קודמות` : 'קניות קודמות';
  $('#storeHead').classList.add('hidden');
  $('#finishWrap').classList.add('hidden');
}

function rowHtml(i) {
  const store = S.mode === 'store';
  
  return `
  <div class="row ${i.done ? 'done' : ''} ${S.justDone === i.id ? 'just' : ''}" data-id="${esc(i.id)}" ${store ? 'data-act="toggle"' : ''}>
    <button class="chk" data-act="toggle" aria-label="${i.done ? 'הוצא מהעגלה' : 'סמן שנכנס לעגלה'}">${ICON.check}</button>
    <div class="name"><span class="n">${esc(i.n)}</span></div>
    ${store
      ? (i.q > 1 ? `<span class="qty-badge">×${i.q}</span>` : '')
      : `${i.done ? '' : `<div class="qty"><button data-act="minus" aria-label="פחות">${ICON.minus}</button><span>${i.q}</span><button data-act="plus" aria-label="יותר">${ICON.plus}</button></div>`}
         <button class="cat-btn" data-act="cat" aria-label="שנה מחלקה">${cat(i.c).icon}</button>
         <button class="del" data-act="del" aria-label="מחק">${ICON.x}</button>`}
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
  if (act === 'toggle' && it) { e.stopPropagation(); S.justDone = it.done ? null : it.id; dispatch({ t: 'done', id: it.id, n: it.n, v: !it.done }); if (navigator.vibrate) navigator.vibrate(15); checkComplete(); }
  else if (act === 'again') {
    const e2 = (view().history || []).find(h => h.id === actEl.dataset.hid);
    if (e2) { e2.items.forEach(i => dispatch({ t: 'add', id: uid(), n: i.n, c: i.c, q: i.q })); toast(`נוספו ${e2.items.length} מוצרים לרשימה`); }
  }
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

function finishShopping(auto) {
  const n = view().items.filter(i => i.done).length; if (!n) return;
  dispatch({ t: 'finish', id: uid() });
  toast(auto ? `🎉 הרשימה בוצעה במלואה – נרשמה בהיסטוריה (${n} מוצרים)` : `✓ נרשם בהיסטוריה ונמחק מהרשימה (${n} מוצרים)`);
}
// כשכל המוצרים סומנו – רושמים את הקנייה בהיסטוריה ומוחקים את הרשימה שבוצעה
let completeTimer;
function checkComplete() {
  clearTimeout(completeTimer);
  completeTimer = setTimeout(() => {
    const items = view().items;
    if (items.length && items.every(i => i.done)) finishShopping(true);
  }, 1500);
}
$('#finishBtn').addEventListener('click', () => finishShopping(false));
$('#syncBtn').addEventListener('click', () => connected() ? sync() : openSettings());
$('#settingsBtn').addEventListener('click', openSettings);

// הורדת PDF של הרשימה – גיבוי לסופר בלי קליטה (נוצר בטלפון, עובד גם אופליין)
$('#pdfBtn').addEventListener('click', async () => {
  const list = view();
  const todo = list.items.filter(i => !i.done);
  if (!todo.length) { toast('אין מוצרים ברשימה'); return; }
  const byCat = {};
  for (const i of todo) (byCat[i.c] ||= []).push(i);
  const groups = Object.keys(byCat).sort((a, b) => cat(a).order - cat(b).order)
    .map(c => ({ icon: cat(c).icon, name: cat(c).name, items: byCat[c].sort((a, b) => a.n.localeCompare(b.n, 'he')) }));
  const now = new Date();
  const date = now.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric', year: 'numeric' });
  const time = now.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  toast('מכין PDF…');
  try {
    const blob = await window.ListPdf.makeListPdf({
      groups, title: 'רשימת הקניות שלנו',
      subtitle: `${date} · ${time} · ${todo.length} מוצרים`
    });
    const name = `רשימת-קניות-${now.toISOString().slice(0, 10)}.pdf`;
    const file = new File([blob], name, { type: 'application/pdf' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    toast('✓ ה-PDF ירד לטלפון');
  } catch (e) { toast('לא הצלחתי ליצור PDF'); }
});

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
    await checkToken(); st.textContent = '✓ מחובר עם הרשאת כתיבה! הרשימה תסונכרן אוטומטית.'; st.className = 's-status ok';
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
