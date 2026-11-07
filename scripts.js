/* =========================================================
   Mejiro Assistant — horse betting tracker
   Signed in with Google (Firebase Auth); each account's data lives in Firestore.
   ========================================================= */

// Where the pre-account version kept its data in this browser (offered for import on first sign-in)
const STORAGE_KEY = 'mejiro.v1';

// [portfolio size ($), risk %]
const DEFAULT_MATRIX = [
  [2, 100], [5, 75], [10, 66], [20, 50], [50, 33], [100, 20],
  [500, 5], [1000, 3.33], [10000, 1], [25000, 0.66], [50000, 0.5], [100000, 0.33],
].map(([size, pct]) => ({ size, pct }));


const DEFAULT_SETTINGS = {
  startingBankroll: 100,
  minBet: 2,
  roundTo: 1,
};

/* ---------- State ---------- */

let state = freshState();

function freshState() {
  return {
    user: null,
    mode: 'basic',  // 'basic' (Win / Place / Show) or 'exotic'; see "Basic / Exotic mode"
    bets: [],
    strategies: [],  // { id, text, mode, category }, in display order; category is a strategyCategories id or ''
    strategyCategories: [],  // { id, name }, in display order
    exoticInfo: {},  // your edits to the Risk Matrix's exotic wager table: { "Exacta": { min, payout } }
    matrix: DEFAULT_MATRIX.map(t => ({ ...t })),
    settings: { ...DEFAULT_SETTINGS },
  };
}

// Data the pre-account version saved in this browser, if any. Browsers keep it per address, so only the
// page opened from disk can see it; that page offers it as a backup file to restore after signing in.
function readLocalState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return saved && Array.isArray(saved.bets) ? saved : null;
  } catch (e) {
    return null;
  }
}

/* ---------- Cloud storage (Firestore) ----------
   users/{uid}                     the PREF_KEYS below
   users/{uid}/bets/{betId}        one document per bet
   users/{uid}/racecards/{date}    that day's races captured from TwinSpires (state.cards holds one day)
   save() is called after every change; it writes only what differs from the last sync. */

const PREF_KEYS = ['mode', 'settings', 'matrix', 'wrRange', 'hrBet', 'strategies', 'strategyCategories', 'wpsShown', 'exoticInfo', 'exoticField'];

let fb = null;  // { auth, db } once Firebase is set up
let synced = { prefs: '', bets: new Map(), cards: '' };  // last known Firestore copy (bet id → JSON)
let saveTimer = null;

const userDoc = () => fb.db.collection('users').doc(state.user.uid);
const prefsOf = s => Object.fromEntries(PREF_KEYS.filter(k => s[k] !== undefined).map(k => [k, s[k]]));
const snapshot = () => ({
  prefs: JSON.stringify(prefsOf(state)),
  bets: new Map(state.bets.map(b => [b.id, JSON.stringify(b)])),
  cards: state.cards ? JSON.stringify(state.cards) : '',
});

function save() {
  if (!fb || !state.user) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 300);
}

async function flushSave() {
  clearTimeout(saveTimer);
  if (!fb || !state.user) return;
  const now = snapshot();
  const bets = userDoc().collection('bets');
  const ops = [];
  // JSON round-trips drop undefined values, which Firestore rejects
  if (now.prefs !== synced.prefs) ops.push(batch => batch.set(userDoc(), JSON.parse(now.prefs)));
  now.bets.forEach((json, id) => { if (synced.bets.get(id) !== json) ops.push(batch => batch.set(bets.doc(id), JSON.parse(json))); });
  synced.bets.forEach((_, id) => { if (!now.bets.has(id)) ops.push(batch => batch.delete(bets.doc(id))); });
  if (now.cards && now.cards !== synced.cards) {
    const cards = JSON.parse(now.cards);
    ops.push(batch => batch.set(userDoc().collection('racecards').doc(cards.date), cards));
  }
  if (!ops.length) return;
  try {
    // A batch holds at most 500 writes
    for (let i = 0; i < ops.length; i += 450) {
      const batch = fb.db.batch();
      ops.slice(i, i + 450).forEach(op => op(batch));
      await batch.commit();
    }
    synced = now;
  } catch (err) {
    console.error(err);
    toast('Could not save to your account: ' + err.message);
  }
}

// Don't lose a change made just before the tab is closed or hidden
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });

async function loadAccount(user) {
  const ref = fb.db.collection('users').doc(user.uid);
  const [doc, bets, cards] = await Promise.all([ref.get(), ref.collection('bets').get(), ref.collection('racecards').doc(today()).get()]);
  state = freshState();
  state.cards = cards.exists ? cards.data() : { date: today(), tracks: {} };
  state.user = { uid: user.uid, name: user.displayName || user.email, email: user.email, photo: user.photoURL };
  if (doc.exists) {
    const data = doc.data();
    PREF_KEYS.forEach(k => { if (data[k] !== undefined) state[k] = data[k]; });
    state.settings = { ...DEFAULT_SETTINGS, ...state.settings };
  }
  state.bets = bets.docs.map(d => d.data());
  synced = snapshot();
}

/* ---------- Helpers ---------- */

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function localISO(d) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function today() { return localISO(new Date()); }

function parseDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function money(n, signed = false) {
  const s = Math.abs(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  if (!signed) return n < 0 ? '-' + s : s;
  return (n > 0 ? '+' : n < 0 ? '-' : '') + s;
}

function plClass(n) { return n > 0 ? 'profit' : n < 0 ? 'loss' : ''; }

function fmtSize(n) {
  if (n >= 1000 && n % 1000 === 0) return '$' + n / 1000 + 'k';
  if (n >= 1000) return '$' + +(n / 1000).toFixed(2) + 'k';
  return '$' + n;
}

function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/* ---------- Money math ---------- */

function profitOf(b) {
  if (b.status === 'won') return num(b.payout) - num(b.stake);
  if (b.status === 'lost') return -num(b.stake);
  return 0;
}

function totalProfit() { return state.bets.reduce((s, b) => s + profitOf(b), 0); }
function bankroll() { return num(state.settings.startingBankroll) + totalProfit(); }

function sortedMatrix() { return [...state.matrix].sort((a, b) => a.size - b.size); }

function currentTier(br = bankroll()) {
  const tiers = sortedMatrix();
  if (!tiers.length) return null;
  let tier = tiers[0];
  for (const t of tiers) if (br >= t.size) tier = t;
  return tier;
}


function suggestedStake() {
  const tier = currentTier();
  const { minBet, roundTo } = state.settings;
  if (!tier) return num(minBet);
  const raw = Math.max(0, bankroll()) * tier.pct / 100;
  const step = num(roundTo) || 0.01;
  const rounded = Math.floor(raw / step + 1e-9) * step;
  return +Math.max(num(minBet), rounded).toFixed(2);
}

/* ---------- Toast / modal / tooltip ---------- */

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2800);
}

function openModal(html, { bare = false, wide = false } = {}) {
  $('#modalBody').onclick = null;
  $('#modalBody').innerHTML = html;
  $('.modal-card').classList.toggle('bare', bare);
  $('.modal-card').classList.toggle('wide', wide);
  $('#modal').classList.remove('hidden');
  const first = $('#modalBody input, #modalBody select');
  if (first) first.focus();
}

function closeModal() { $('#modal').classList.add('hidden'); $('#modalBody').innerHTML = ''; }

function confirmModal(title, message, okLabel = 'Confirm', danger = false) {
  return new Promise(resolve => {
    openModal(`
      <h3>${esc(title)}</h3>
      <p>${esc(message)}</p>
      <div class="modal-actions">
        <button class="btn ghost" data-answer="no">Cancel</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-answer="yes">${esc(okLabel)}</button>
      </div>`);
    $('#modalBody').onclick = e => {
      const a = e.target.closest('[data-answer]');
      if (!a) return;
      $('#modalBody').onclick = null;
      closeModal();
      resolve(a.dataset.answer === 'yes');
    };
  });
}

$('#modal').addEventListener('mousedown', e => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

function showTip(html, x, y) {
  const tip = $('#tooltip');
  tip.innerHTML = html;
  tip.classList.remove('hidden');
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = Math.min(window.innerWidth - w - 8, Math.max(8, x - w / 2)) + 'px';
  tip.style.top = Math.max(8, y - h - 12) + 'px';
}
function hideTip() { $('#tooltip').classList.add('hidden'); }

/* =========================================================
   Sign-in (Google, via Firebase Auth)
   ========================================================= */

function showScreen(id) {
  ['#loading', '#login', '#app'].forEach(s => $(s).classList.toggle('hidden', s !== id));
}

function showLogin(error = '') {
  $('#loginError').textContent = error;
  $('#loginError').classList.toggle('hidden', !error);
  showScreen('#login');
}

function showApp() {
  showScreen('#app');
  renderAll();
  applyPendingCaptures();
}

function initFirebase() {
  const cfg = window.FIREBASE_CONFIG;
  if (location.protocol === 'file:') {
    $('#legacyExport').classList.toggle('hidden', !readLocalState());
    return showLogin('Google sign-in needs a web address. Open the published site, or use VS Code Live Server at http://localhost:5500 (see FIREBASE_SETUP.md).');
  }
  if (!window.firebase || !cfg || !cfg.apiKey) {
    return showLogin("Firebase isn't set up yet. Paste your project's config into firebase-config.js.");
  }
  firebase.initializeApp(cfg);
  fb = { auth: firebase.auth(), db: firebase.firestore() };
  // Offline cache, so the app opens fast and queues writes without a connection (unavailable in some private windows)
  fb.db.enablePersistence({ synchronizeTabs: true }).catch(() => {});

  fb.auth.onAuthStateChanged(async user => {
    if (!user) {
      state = freshState();
      synced = { prefs: '', bets: new Map(), cards: '' };
      return showLogin();
    }
    showScreen('#loading');
    try {
      await loadAccount(user);
      showApp();
    } catch (err) {
      console.error(err);
      showLogin('Could not load your data: ' + err.message);
    }
  });
}

$('#googleBtn').addEventListener('click', async () => {
  if (!fb) return;
  const provider = new firebase.auth.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    await fb.auth.signInWithPopup(provider);
  } catch (err) {
    // Some browsers block popups; a full-page redirect works everywhere
    if (err.code === 'auth/popup-blocked' || err.code === 'auth/operation-not-supported-in-this-environment') {
      return fb.auth.signInWithRedirect(provider);
    }
    if (err.code !== 'auth/popup-closed-by-user' && err.code !== 'auth/cancelled-popup-request') {
      showLogin(err.code === 'auth/unauthorized-domain'
        ? `This address (${location.hostname}) isn't allowed to sign in yet. Add it in Firebase console → Authentication → Settings → Authorized domains.${location.hostname === '127.0.0.1' ? ' Or use localhost instead of 127.0.0.1.' : ''}`
        : 'Sign-in failed: ' + err.message);
    }
  }
});

// Opened from disk: hand over what the pre-account version saved, to restore in Settings after signing in
$('#legacyExport').addEventListener('click', () => {
  download(`mejiro-backup-browser-${today()}.json`, JSON.stringify(readLocalState(), null, 2), 'application/json');
  toast('Saved. After signing in, use Settings → Restore backup');
});

async function signOut() {
  if (!await confirmModal('Sign out?', 'Your data is saved to your account.', 'Sign out')) return;
  await flushSave();
  await fb.auth.signOut();
}

/* =========================================================
   Navigation
   ========================================================= */

function goTab(name) {
  $$('#nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
  window.scrollTo(0, 0);
}

$('#nav').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab]');
  if (b) goTab(b.dataset.tab);
});

/* ---------- Basic / Exotic mode ----------
   The toggle at the top of the sidebar switches every tab between straight bets (Win / Place / Show)
   and exotic wagers. Bets, strategies and History follow the mode; the bankroll, balance and
   Risk Matrix tiers are shared by both. */

const isExotic = () => state.mode === 'exotic';
const isExoticType = type => EXOTIC_INFO.some(d => d.name === type);
const modeBets = () => state.bets.filter(b => isExoticType(b.type) === isExotic());
const modeBetTypes = () => BET_TYPES.filter(([t]) => isExoticType(t) === isExotic());

// Static parts of the page carry .only-basic or .only-exotic; the body's class hides the other mode's
function applyMode() {
  document.body.classList.toggle('mode-exotic', isExotic());
  document.body.classList.toggle('mode-basic', !isExotic());
  $$('#modeToggle [data-mode]').forEach(b => {
    const on = b.dataset.mode === (isExotic() ? 'exotic' : 'basic');
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on);
  });
}

$('#modeToggle').addEventListener('click', e => {
  const b = e.target.closest('[data-mode]');
  if (!b || b.dataset.mode === (isExotic() ? 'exotic' : 'basic')) return;
  state.mode = b.dataset.mode;
  save();
  renderAll();
});

function renderAll() {
  applyMode();
  renderUser();
  renderTrackSelects();
  syncBetTypes();
  renderTracker();
  renderRaces();
  renderStrategies();
  renderMatrix();
  renderExoticTable();
  renderHistory();
  renderSettings();
}

function renderUser() {
  const u = state.user || { name: '?', email: '' };
  $('#userChip').innerHTML = `
    <span class="av">${u.photo
      ? `<img src="${esc(u.photo)}" alt="" referrerpolicy="no-referrer">`
      : esc(u.name.charAt(0).toUpperCase())}</span>
    <div>${esc(u.name)}<small>${esc(u.email)}</small></div>`;
}

function renderTrackSelects() {
  const betTracks = [...new Set(state.bets.map(b => b.track))].sort();

  // Log bets suggests today's scraped tracks first, then any track you've bet on before
  const scraped = state.cards && state.cards.date === today() ? Object.values(state.cards.tracks).map(t => t.name).sort() : [];
  $('#trackList').innerHTML = [...new Set([...scraped, ...betTracks])].map(n => `<option value="${esc(n)}"></option>`).join('');

  // History filters by the tracks you've bet on in this mode
  const histTracks = [...new Set(modeBets().map(b => b.track))].sort();
  const hist = $('#histTrack'), hv = hist.value;
  hist.innerHTML = '<option value="">All tracks</option>' + histTracks.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  hist.value = histTracks.includes(hv) ? hv : '';

  // History's wager types: this mode's types, plus any older ones found in its bets
  const types = [...new Set([...modeBetTypes().map(([t]) => t), ...modeBets().map(b => b.type).filter(Boolean)])];
  const ht = $('#histType'), tv = ht.value;
  ht.innerHTML = '<option value="">All types</option>' + types.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
  ht.value = types.includes(tv) ? tv : '';
}

/* =========================================================
   Tracker
   ========================================================= */

const WR_RANGES = [['all', 'All-time'], ['90', '90 days'], ['30', '30 days'], ['7', '7 days'], ['1', 'Today']];

// Win rate (Basic) = won ÷ (won + lost) of Win / Place / Show bets, by bet date; scratches and pending bets don't count.
// Exotic mode shows the hit rate per wager type instead.
function renderWinRate() {
  if (isExotic()) return renderHitRate();
  const range = WR_RANGES.some(([k]) => k === state.wrRange) ? state.wrRange : 'all';
  let from = '';
  if (range !== 'all') {
    const d = new Date();
    d.setDate(d.getDate() - (num(range) - 1));
    from = localISO(d);
  }
  const bets = modeBets().filter(b => !from || b.date >= from);
  const count = s => bets.filter(b => b.status === s).length;
  const won = count('won'), lost = count('lost'), scratched = count('scratched');
  const rate = won + lost ? won / (won + lost) * 100 : null;
  $('#winRate').innerHTML = `
    <div class="winrate-head">
      <h3>Win rate</h3>
      <div class="seg-group">${WR_RANGES.map(([k, label]) =>
        `<button type="button" class="seg ${k === range ? 'active' : ''}" data-range="${k}">${label}</button>`).join('')}</div>
    </div>
    <div class="winrate-value">${rate == null ? '—' : +rate.toFixed(1) + '%'}</div>
    <div class="winrate-bar"><span style="width:${rate || 0}%"></span></div>
    <div class="sub">${won + lost
      ? `<span class="profit">${won} won</span> · <span class="loss">${lost} lost</span>${scratched ? ` · ${scratched} scratched` : ''}`
      : 'No settled bets in this period'}</div>`;
}

// Hit rate = hit ÷ (hit + missed) for one exotic wager type, all time. Each button shows its own rate,
// with the best in green and the worst in red, so the types compare at a glance.
function renderHitRate() {
  const types = [...EXOTIC_INFO].sort((a, b) => a.stars - b.stars).map(d => d.name);
  const stats = Object.fromEntries(types.map(t => {
    const bets = state.bets.filter(b => b.type === t);
    const count = s => bets.filter(b => b.status === s).length;
    const won = count('won'), lost = count('lost');
    return [t, { won, lost, scratched: count('scratched'), rate: won + lost ? won / (won + lost) * 100 : null }];
  }));
  const pick = types.includes(state.hrBet) ? state.hrBet : types[0];
  const rates = types.map(t => stats[t].rate).filter(r => r != null);
  const hi = Math.max(...rates), lo = Math.min(...rates);
  const mark = r => r == null || rates.length < 2 || hi === lo ? '' : r === hi ? 'hi' : r === lo ? 'lo' : '';
  const s = stats[pick];
  $('#winRate').innerHTML = `
    <div class="winrate-head">
      <h3>Hit rate</h3>
      <div class="seg-group">${types.map(t => `
        <button type="button" class="seg hr-seg ${t === pick ? 'active' : ''}" data-hr="${esc(t)}">${esc(t)}
          <small class="${mark(stats[t].rate)}">${stats[t].rate == null ? '—' : +stats[t].rate.toFixed(1) + '%'}</small></button>`).join('')}</div>
    </div>
    <div class="winrate-value">${s.rate == null ? '—' : +s.rate.toFixed(1) + '%'}</div>
    <div class="winrate-bar"><span style="width:${s.rate || 0}%"></span></div>
    <div class="sub">${s.won + s.lost
      ? `<span class="profit">${s.won} hit</span> · <span class="loss">${s.lost} missed</span>${s.scratched ? ` · ${s.scratched} scratched` : ''} · ${esc(pick)}, all time`
      : `No settled ${esc(pick)} bets yet`}</div>`;
}

$('#winRate').addEventListener('click', e => {
  const range = e.target.closest('[data-range]'), hr = e.target.closest('[data-hr]');
  if (range) state.wrRange = range.dataset.range;
  else if (hr) state.hrBet = hr.dataset.hr;
  else return;
  save();
  renderWinRate();
});

// Roll Today's Races over to the new day if the page stays open past midnight
setInterval(() => { if (state.user && racesView.date !== today()) renderRaces(); }, 60000);

function renderTracker() {
  renderWinRate();
  const br = bankroll();
  const tier = currentTier(br);
  $('#stats').innerHTML = `
    <div class="stat"><div class="label">Percent Risk</div><div class="value">${tier ? tier.pct + '%' : '—'}</div></div>
    <div class="stat accent balance"><div class="label">Balance</div><div class="value">${money(br)}</div></div>
    <div class="stat"><div class="label">Suggested stake</div><div class="value stake-value">${money(suggestedStake())}</div></div>`;
}

/* ----- Log bets: shared date & track, one row per bet ----- */

const BET_TYPES = [['Win', '1st'], ['Place', '1st–2nd'], ['Show', '1st–3rd'],
  ['Exacta', '1st–2nd in order'], ['Trifecta', '1st–3rd in order'], ['Superfecta', '1st–4th in order'],
  ['Super High Five', '1st–5th in order'], ['Pick 3', 'winners of 3 races'], ['Pick 5', 'winners of 5 races']];

// The Bet type list holds only the current mode's types
const betTypeOptions = selected => '<option value="">Select…</option>' + modeBetTypes().map(([t, places]) =>
  `<option value="${t}" ${selected === t ? 'selected' : ''}>${t} (${places})</option>`).join('');

// After a mode switch, each row keeps its type if the new mode offers it, and is cleared otherwise
function syncBetTypes() {
  $$('#betRows [name=type]').forEach(sel => {
    const was = sel.value;
    sel.innerHTML = betTypeOptions(was);
    if (sel.value !== was) sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  $$('#betRows tr').forEach(syncHorse);
}

// Rows start blank. Horse # is a text box in Basic (one horse), and a number picker in Exotic,
// where a bet needs one horse per place or race; Pick bets log the first race in Race #.
function betRowHTML(prev = {}) {
  return `
    <tr>
      <td><input type="number" name="race" min="1" max="20" required class="w-xs" value="${esc(prev.race || '')}"></td>
      <td><input type="text" name="horse" required inputmode="numeric" placeholder="#" class="w-xs only-basic" value="${esc(prev.horse || '')}">
        <button type="button" class="horse-btn only-exotic" data-picks="" disabled>—</button></td>
      <td><select name="type" required>${betTypeOptions(prev.type)}</select></td>
      <td><input type="number" name="stake" min="0" step="0.01" required class="w-sm" value="${esc(prev.stake ?? '')}"></td>
      <td><select name="result" required>
        <option value="">Select…</option><option value="won">Won</option><option value="lost">Lost</option><option value="scratched">Scratched</option>
      </select></td>
      <td><input type="number" name="payout" min="0" step="0.01" required placeholder="Incl. stake" class="w-sm"></td>
      <td class="only-exotic"><button type="button" class="winners-btn" data-winners="" disabled>—</button></td>
      <td><button type="button" class="btn tiny-btn ghost danger" data-remove-row title="Remove this bet">✕</button></td>
    </tr>`;
}

// Total return only applies to winning bets
function syncPayout(tr) {
  const won = tr.querySelector('[name=result]').value === 'won';
  const payout = tr.querySelector('[name=payout]');
  payout.disabled = !won;
  if (!won) payout.value = '';
}

/* ----- Actual winners: for an exotic bet you lost, the horses that really finished
   (or won each race, for a Pick bet), saved on the bet as program numbers in order ----- */

const betInfo = type => EXOTIC_INFO.find(d => d.name === type);

// Saddle cloths in order: 4–7–1 for one race, 4 / 7 / 1 for a Pick bet
function winnersHTML(winners, info) {
  if (!info || !winners || !winners.length) return '';
  return `<span class="xc-cloths">${winners.map(n => cloth(n)).join(`<span class="xc-sep">${info.kind === 'vertical' ? '–' : '/'}</span>`)}</span>`;
}

const picksOf = text => (text ? String(text).split(/[-/,\s]+/).filter(Boolean).map(Number) : []);

// Exotic Horse #: the picker button, ready once a bet type is chosen. The hidden text box is switched off
// so the browser doesn't ask for it.
function syncHorse(tr) {
  tr.querySelector('[name=horse]').disabled = isExotic();
  const btn = tr.querySelector('.horse-btn');
  const info = betInfo(tr.querySelector('[name=type]').value);
  btn.disabled = !info;
  if (!info) btn.dataset.picks = '';
  const picks = picksOf(btn.dataset.picks);
  if (!info || picks.length === info.legs) btn.classList.remove('invalid');
  btn.innerHTML = winnersHTML(picks, info) || (info ? `Choose ${info.legs}…` : '—');
  btn.title = info ? `Your ${info.legs} horses, in order` : 'Choose a bet type first';
  if (!$('#betRows .horse-btn.invalid')) $('#betError').classList.add('hidden');
}

// The row's Actual winners button works only for a lost exotic bet; changing the type or result clears it
function syncWinners(tr) {
  const btn = tr.querySelector('.winners-btn');
  const info = betInfo(tr.querySelector('[name=type]').value);
  btn.disabled = !info || tr.querySelector('[name=result]').value !== 'lost';
  if (btn.disabled) btn.dataset.winners = '';
  btn.innerHTML = winnersHTML(picksOf(btn.dataset.winners), info) || (btn.disabled ? '—' : 'Pick…');
  btn.title = btn.disabled ? 'For exotic bets you lost' : 'Pick the horses that actually finished';
}

let numPicker = null;  // { anchor, close, undo } while the number picker is open

// A small popup of program numbers 1–16 in saddle-cloth colors, like an emoji picker. Each press fills
// the next slot (1st, 2nd… or each Pick race), and it closes by itself once every slot is filled.
// However it closes, onClose gets the numbers picked so far. Used for your picks and the actual winners.
function openNumPicker(anchor, info, current, firstRace, onClose, title) {
  closeNumPicker();
  const vertical = info.kind === 'vertical';
  title = title || (vertical ? 'Actual finish' : 'Race winners');
  let seq = (current || []).slice(0, info.legs);
  let closed = false;
  const el = document.createElement('div');
  el.className = 'num-picker';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', `${title} for the ${info.name}`);
  const slotName = i => vertical ? ['1st', '2nd', '3rd', '4th', '5th'][i] : firstRace ? `R${firstRace + i}` : `Leg ${i + 1}`;
  const draw = () => {
    el.innerHTML = `
      <div class="np-head"><b>${esc(title)}</b><span>${esc(info.name)}</span></div>
      <div class="np-slots">${Array.from({ length: info.legs }, (_, i) => `
        <span class="np-slot ${i === seq.length ? 'next' : ''}"><small>${slotName(i)}</small>${seq[i] ? cloth(seq[i]) : '<span class="np-blank"></span>'}</span>`).join('')}</div>
      <div class="np-grid">${Array.from({ length: 16 }, (_, i) => i + 1).map(n => `
        <button type="button" data-n="${n}" aria-label="Number ${n}"
          ${seq.length >= info.legs || (vertical && seq.includes(n)) ? 'disabled' : ''}>${cloth(n)}</button>`).join('')}</div>
      <div class="np-actions">
        <button type="button" data-np="undo" ${seq.length ? '' : 'disabled'}>⌫ Undo</button>
        <button type="button" data-np="clear" ${seq.length ? '' : 'disabled'}>Clear</button>
        <button type="button" data-np="done" class="np-done">Done</button>
      </div>`;
  };
  const close = () => {
    if (closed) return;
    closed = true;
    el.remove();
    document.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('resize', close);
    window.removeEventListener('scroll', close, true);
    numPicker = null;
    onClose(seq);
  };
  const outside = e => { if (!el.contains(e.target) && !anchor.contains(e.target)) close(); };
  el.addEventListener('click', e => {
    const n = e.target.closest('[data-n]'), act = e.target.closest('[data-np]');
    if (n && !n.disabled) {
      seq.push(+n.dataset.n);
      draw();
      if (seq.length === info.legs) setTimeout(close, 180);  // a moment to see the last number land
    } else if (act) {
      if (act.dataset.np === 'done') return close();
      if (act.dataset.np === 'undo') seq.pop();
      if (act.dataset.np === 'clear') seq = [];
      draw();
    }
  });
  draw();
  document.body.appendChild(el);
  // Under the button, or above it when there's no room below
  const r = anchor.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
  el.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
  el.style.top = (r.bottom + 6 + h > window.innerHeight && r.top - 6 - h > 0 ? r.top - 6 - h : r.bottom + 6) + 'px';
  document.addEventListener('pointerdown', outside, true);
  window.addEventListener('resize', close);
  window.addEventListener('scroll', close, true);
  numPicker = { anchor, close, undo: () => { seq.pop(); draw(); } };
}

function closeNumPicker() { if (numPicker) numPicker.close(); }

// Esc closes the picker; Backspace takes back the last number
document.addEventListener('keydown', e => {
  if (!numPicker) return;
  if (e.key === 'Escape') numPicker.close();
  else if (e.key === 'Backspace' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) { e.preventDefault(); numPicker.undo(); }
});

// The same button opens the picker, or closes it if it's already open there
function toggleNumPicker(btn, info, current, firstRace, onClose, title) {
  if (numPicker && numPicker.anchor === btn) return closeNumPicker();
  openNumPicker(btn, info, current, firstRace, onClose, title);
}

function updateBetRows() {
  const rows = $$('#betRows tr');
  rows.forEach(syncPayout);
  rows.forEach(syncHorse);
  rows.forEach(syncWinners);
  $$('#betRows [data-remove-row]').forEach(b => { b.disabled = rows.length === 1; });
  $('#logBetsBtn').textContent = rows.length === 1 ? 'Log bet' : `Log ${rows.length} bets`;
}

function resetBetForm(first) {
  const f = $('#betForm');
  f.date.value = '';
  f.track.value = '';
  $('#betRows').innerHTML = betRowHTML(first);
  updateBetRows();
}

$('#addBetRow').addEventListener('click', () => {
  $('#betRows').insertAdjacentHTML('beforeend', betRowHTML());
  updateBetRows();
  $$('#betRows tr').pop().querySelector('[name=race]').focus();
});

// Exotic bets take several horses ("3-5-1"), so the Horse # box hints at the format and offers a full keyboard
// A different bet type needs a different number of horses, so its picks and winners start over
$('#betRows').addEventListener('change', e => {
  if (e.target.name !== 'type') return;
  const tr = e.target.closest('tr');
  tr.querySelector('.horse-btn').dataset.picks = '';
  tr.querySelector('.winners-btn').dataset.winners = '';
  syncHorse(tr);
  syncWinners(tr);
});

$('#betRows').addEventListener('change', e => {
  if (e.target.name !== 'result') return;
  syncPayout(e.target.closest('tr'));
  syncWinners(e.target.closest('tr'));
});

$('#betRows').addEventListener('click', e => {
  const horse = e.target.closest('.horse-btn');
  if (horse) {
    const tr = horse.closest('tr');
    return toggleNumPicker(horse, betInfo(tr.querySelector('[name=type]').value), picksOf(horse.dataset.picks), num(tr.querySelector('[name=race]').value),
      seq => { horse.dataset.picks = seq.join(','); syncHorse(tr); }, 'Your picks');
  }
  const pick = e.target.closest('.winners-btn');
  if (pick) {
    const tr = pick.closest('tr');
    return toggleNumPicker(pick, betInfo(tr.querySelector('[name=type]').value), picksOf(pick.dataset.winners), num(tr.querySelector('[name=race]').value),
      seq => { pick.dataset.winners = seq.join(','); syncWinners(tr); });
  }
  const btn = e.target.closest('[data-remove-row]');
  if (!btn || $$('#betRows tr').length === 1) return;
  btn.closest('tr').remove();
  updateBetRows();
});

$('#betForm').addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target;
  const rows = $$('#betRows tr');

  // An exotic bet needs every horse its type calls for: 2 for an Exacta, 5 for a Pick 5…
  const short = rows.map((tr, i) => {
    const info = betInfo(tr.querySelector('[name=type]').value), btn = tr.querySelector('.horse-btn');
    const have = picksOf(btn.dataset.picks).length;
    btn.classList.toggle('invalid', !!info && have < info.legs);
    return info && have < info.legs
      ? `${rows.length > 1 ? `Row ${i + 1}: ` : ''}${info.name} needs ${info.legs} horses, but ${have ? `only ${have} ${have === 1 ? 'is' : 'are'}` : 'none are'} picked.` : '';
  }).filter(Boolean);
  if (short.length) {
    $('#betError').innerHTML = short.map(esc).join('<br>');
    $('#betError').classList.remove('hidden');
    $('#betRows .horse-btn.invalid').focus();
    return;
  }

  const logged = rows.map(tr => {
    const v = n => tr.querySelector(`[name=${n}]`);
    const status = v('result').value;
    const info = betInfo(v('type').value);
    const winners = tr.querySelector('.winners-btn').dataset.winners;
    return {
      id: uid(),
      date: f.date.value,
      track: f.track.value.trim(),
      race: v('race').value,
      // Exotic picks are saved like 3-5-1, or 3/5/1 for a Pick bet
      horse: info ? picksOf(tr.querySelector('.horse-btn').dataset.picks).join(info.kind === 'vertical' ? '-' : '/') : v('horse').value.trim(),
      type: v('type').value,
      stake: num(v('stake').value),
      status,
      payout: status === 'won' ? num(v('payout').value) : 0,
      ...(status === 'lost' && info && winners ? { winners: picksOf(winners) } : {}),
      settledAt: new Date().toISOString(),
    };
  });
  state.bets.push(...logged);
  save();
  renderTrackSelects();
  renderTracker();
  renderMatrix();
  renderHistory();
  resetBetForm();
  const pl = logged.reduce((s, b) => s + profitOf(b), 0);
  toast(`Logged ${logged.length === 1 ? '1 bet' : logged.length + ' bets'}: ${money(pl, true)}`);
});

// Bets saved before the Tracker logged results are still "open"; History settles them
function openWonModal(bet) {
  openModal(`
    <h3>${esc(horseLabel(bet.horse))} won 🎉</h3>
    <p>Enter the total return shown on TwinSpires (payout including your stake).</p>
    <form id="wonForm" class="form">
      <label class="full">Total return ($)<input type="number" name="payout" min="0" step="0.01" required></label>
    </form>
    <div class="modal-actions">
      <button class="btn ghost" id="wonCancel">Cancel</button>
      <button class="btn primary" form="wonForm">Settle as won</button>
    </div>`);
  $('#wonCancel').onclick = closeModal;
  $('#wonForm').onsubmit = ev => {
    ev.preventDefault();
    settleBet(bet, 'won', num(ev.target.payout.value));
    closeModal();
  };
}

function settleBet(bet, status, payout) {
  bet.status = status;
  bet.payout = payout;
  bet.settledAt = new Date().toISOString();
  save();
  renderTracker();
  renderMatrix();
  renderHistory();
  const p = profitOf(bet);
  toast(status === 'scratched' ? 'Marked as scratched (stake returned)' : `Settled: ${money(p, true)}`);
}

/* =========================================================
   Today's Races — race cards captured from TwinSpires with the Mejiro Capture bookmark.
   Pick a track, then a race: entrants in the middle, win/place/show % on the right.
   Each day's captures are one Firestore document, users/{uid}/racecards/{YYYY-MM-DD}:
     { date, tracks: { KEY: { name, total, races: { "N": { capturedAt, entrants: [...] } } } } }
   KEY is the TwinSpires track name in lowercase letters and digits ("parxracing").
   The day starts empty: "Scrape all tracks" fills it.
   ========================================================= */

const MAX_RACES = 15;
const WPS = [['win', 'WIN'], ['place', 'PLACE'], ['show', 'SHOW']];
let racesView = { date: null, key: null, race: 1 };
let cardsLoading = false;

const trackKey = name => String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Makes state.cards the given day's captures (today's arrive with the account)
async function ensureCards(date) {
  if (state.cards && state.cards.date === date) return;
  await flushSave();  // the previous day's captures first
  let data = null;
  if (fb && state.user) {
    try {
      const d = await userDoc().collection('racecards').doc(date).get();
      if (d.exists) data = d.data();
    } catch (err) { console.error(err); }
  }
  state.cards = data || { date, tracks: {} };
  synced.cards = JSON.stringify(state.cards);
}

// A track opens on its first scraped race (races already run are usually skipped)
const firstRace = track => track ? Math.min(...Object.keys(track.card.races).map(Number)) : 1;

// Left column: the tracks scraped today, A–Z
function racesTracks(date) {
  const captured = state.cards && state.cards.date === date ? state.cards.tracks : {};
  return Object.entries(captured).map(([key, card]) => ({ key, name: card.name, card }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// WIN = 1st ÷ starts, PLACE = (1st + 2nd) ÷ starts, SHOW = (1st + 2nd + 3rd) ÷ starts
function wpsPercents(e) {
  if (!e.starts) return null;
  const pct = n => n / e.starts * 100;
  return { win: pct(e.wins), place: pct(e.wins + e.places), show: pct(e.wins + e.places + e.shows) };
}
const fmtPct = v => +v.toFixed(1) + '%';
// starts is missing when the capture couldn't read that horse's record, and 0 for a debut
const lifeText = e => e.starts == null ? 'No record found' : e.starts ? `${e.starts}-${e.wins}-${e.places}-${e.shows}` : 'Debut';

// Which of WIN / PLACE / SHOW the right column shows; SHOW alone until you change it
const wpsShown = () => (Array.isArray(state.wpsShown) && state.wpsShown.length ? state.wpsShown : ['show']);
const wpsToggle = () => `<div class="wps-toggle" role="group" aria-label="Rates to show">${WPS.map(([k, label]) =>
  `<button type="button" class="seg ${wpsShown().includes(k) ? 'active' : ''}" data-wps="${k}" aria-pressed="${wpsShown().includes(k)}">${label}</button>`).join('')}</div>`;

function captureSteps(trackName, race) {
  return `<div class="capture-steps">
    <p><b>Race ${race} wasn't scraped</b> (it may have run already). To add it:</p>
    <ol>
      <li>On TwinSpires, open ${esc(trackName)} Race ${race} on the <b>PROGRAM</b> tab.</li>
      <li>Click your <b>Mejiro Capture</b> bookmark. It opens each horse and reads its record.</li>
      <li>Click <b>Send to Mejiro</b>.</li>
    </ol>
    <button type="button" class="btn tiny-btn" data-setup-capture>Set up the Mejiro Capture bookmark</button>
  </div>`;
}

function renderRaces() {
  const t = today();
  if (!state.cards || state.cards.date !== t) {
    // Past midnight, or after importing another day: switch to today's captures, then draw again
    if (!cardsLoading) { cardsLoading = true; ensureCards(t).finally(() => { cardsLoading = false; renderRaces(); }); }
  }
  const tracks = racesTracks(t);
  if (racesView.date !== t || !tracks.some(x => x.key === racesView.key)) racesView = { date: t, key: tracks[0]?.key || null, race: firstRace(tracks[0]) };
  $('#racesDate').textContent = parseDate(t).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  $('#racesTracks').innerHTML = tracks.map(x => {
    const n = Object.keys(x.card.races).length;
    return `
      <div class="race-track-row ${x.key === racesView.key ? 'active' : ''}">
        <button type="button" class="race-track" data-key="${esc(x.key)}">
          <span class="name">${esc(x.name)}</span>
          <span class="muted tiny">${n} race${n === 1 ? '' : 's'}</span>
        </button>
        <button type="button" class="track-remove" data-remove-track="${esc(x.key)}" title="Remove this track's captures" aria-label="Remove ${esc(x.name)}">✕</button>
      </div>`;
  }).join('');

  $('#exoticCard').classList.toggle('hidden', !tracks.length);
  // Easiest to hardest, by the same difficulty stars as the Risk Matrix's exotic wager table,
  // colored the same way: vertical (one race) in cyan, horizontal (several races) in pink.
  // Each shows today's 10 most likely tickets for that wager underneath (Exotic mode only).
  $('#exoticTiles').innerHTML = [...EXOTIC_INFO].sort((a, b) => a.stars - b.stars).map(d => `
    <button type="button" class="exotic-tile ${d.kind}" data-calc="${esc(d.name)}" title="Today's 10 most likely ${esc(d.name)} tickets">
      <span class="tile-play" aria-hidden="true">${PLAY_SVG}</span>
      <b>${esc(d.name)}</b>${starsHTML(d.stars)}<span class="tile-desc">${esc(d.short)}</span>
      <span class="kind-tag ${d.kind}">${d.kind === 'vertical' ? 'Single Race' : 'Multiple Races'}</span></button>`).join('');
  if (isExotic() && tracks.length) renderExoticResults();

  const track = tracks.find(x => x.key === racesView.key);
  if (!track) {
    $('#racesTitle').textContent = 'Entrants';
    $('#racePicker').innerHTML = '';
    $('#racesEntrants').innerHTML = '<p class="muted small-text">Start the day with <b>Scrape all tracks</b>.</p>';
    $('#racesCalc').innerHTML = '';
    return;
  }

  const races = track.card ? track.card.races : {};
  const total = track.card && track.card.total;
  if (total && racesView.race > total) racesView.race = 1;
  $('#racesTitle').textContent = `${track.name} · Race ${racesView.race}`;
  // Captured races are marked; races beyond the card's last race (when TwinSpires showed it) are greyed out
  $('#racePicker').innerHTML = Array.from({ length: MAX_RACES }, (_, i) => i + 1).map(n =>
    `<button type="button" class="seg ${n === racesView.race ? 'active' : ''} ${races[n] ? 'has-data' : ''}" data-race="${n}"
      ${total && n > total ? `disabled title="No race ${n} today"` : ''}>${n}</button>`).join('');

  const race = races[racesView.race];
  if (!race) {
    $('#racesEntrants').innerHTML = captureSteps(track.name, racesView.race);
    $('#racesCalc').innerHTML = wpsToggle() + '<p class="muted small-text">Percentages appear once this race is captured.</p>';
    return;
  }

  const entrants = race.entrants;
  const when = new Date(race.capturedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  $('#racesEntrants').innerHTML = `
    <p class="muted tiny captured-at">Captured from TwinSpires at ${esc(when)}. Capture again to update.</p>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>PP</th><th>Horse</th><th class="num" title="Starts-1st-2nd-3rd">Life</th></tr></thead>
      <tbody>${entrants.map(e => `
        <tr class="${e.scratched ? 'scratched' : ''}"><td>${esc(e.pp)}</td>
          <td>${esc(e.horse)}${e.scratched ? ' <span class="badge scr">SCR</span>' : ''}</td>
          <td class="num">${e.starts ? lifeText(e) : `<span class="muted">${lifeText(e)}</span>`}</td></tr>`).join('')}</tbody>
    </table></div>`;

  // Green = the race's highest rate of that type; yellow = 50% or more.
  // Scratched horses keep their numbers, in grey, and don't count toward the highest.
  const all = entrants.map(e => ({ e, p: wpsPercents(e) }));
  const best = k => Math.max(...all.filter(x => x.p && !x.e.scratched).map(x => x.p[k]));
  const top = { win: best('win'), place: best('place'), show: best('show') };
  const cell = (e, p, k) => !p ? '<span class="muted">—</span>'
    : e.scratched ? `<span class="muted">${fmtPct(p[k])}</span>`
    : `<span class="${p[k] === top[k] ? 'best' : p[k] >= 50 ? 'strong' : ''}">${fmtPct(p[k])}</span>`;
  const shown = wpsShown();
  $('#racesCalc').innerHTML = `${wpsToggle()}
    <div class="calc-list">${all.map(({ e, p }) => `
      <div class="calc-item ${e.scratched ? 'scratched' : ''}">
        <div class="calc-head"><span><span class="muted">#${esc(e.pp)}</span> <b>${esc(e.horse)}</b>${e.scratched ? ' <span class="badge scr">SCR</span>' : ''}</span>
          <span class="muted tiny">${e.starts ? lifeText(e) : lifeText(e) === 'Debut' ? 'Debut, no record' : 'No record found'}</span></div>
        ${WPS.filter(([k]) => shown.includes(k)).map(([k, label]) =>
          `<div class="calc-row"><span>${label} %</span>${cell(e, p, k)}</div>`).join('')}
      </div>`).join('')}</div>`;
}

$('#racesTracks').addEventListener('click', async e => {
  // A track you don't want today can be removed
  const remove = e.target.closest('[data-remove-track]');
  if (remove) {
    const t = state.cards.tracks[remove.dataset.removeTrack];
    if (!t || !await confirmModal(`Remove ${t.name}?`, "This deletes today's captured races for it.", 'Remove', true)) return;
    delete state.cards.tracks[remove.dataset.removeTrack];
    save();
    return renderRaces();
  }
  const b = e.target.closest('[data-key]');
  if (!b) return;
  racesView.key = b.dataset.key;
  racesView.race = firstRace(racesTracks(today()).find(x => x.key === b.dataset.key));
  renderRaces();
});

// Pressing a tile shows its top 10 under the tiles; pressing it again hides them
$('#exoticCard').addEventListener('click', e => {
  const tile = e.target.closest('[data-calc]');
  if (!tile) return;
  exoticPick = exoticPick === tile.dataset.calc ? null : tile.dataset.calc;
  renderExoticResults();
});

/* =========================================================
   Exotic calculator — each Exotic Wagering tile runs it over every race scraped today. It turns
   each runner's career record into chances for its race, then chains them into combinations;
   the day's 10 most likely tickets for that wager show under the tiles.
   1. Shrink each record toward an average horse (1 in 8 to finish 1st, 2nd or 3rd) by adding
      K = 10 average starts: short records move a lot, long ones barely.
   2. Win chances = adjusted win rates, scaled so the field adds up to 100%.
   3. Later positions use their own strength: 2nd = adjusted rate of finishing exactly 2nd,
      3rd = exactly 3rd, 4th and 5th = adjusted top-3 rate (there's no 4th/5th data). A horse's
      chance at a position = its strength ÷ the strengths of the runners not yet placed.
   4. Pick 3 / Pick 5: one winner per race, races independent, so the legs' win chances multiply.
   Runners with fewer than 3 starts (or no record) still count against everyone, but are never
   suggested; a race where they're over a third of the field is skipped. Scratches are removed.
   1 and 1A are one betting interest.
   ========================================================= */

const CALC = { K: 10, minStarts: 3, maxUnknownShare: 1 / 3, results: 10 };
const PLAY_SVG = '<svg viewBox="0 0 24 24" width="22" height="22"><circle cx="12" cy="12" r="11" fill="currentColor"/><path d="M10 7.5v9l7-4.5z" fill="#0D0A14"/></svg>';

// Standard saddle-cloth colors by program number: [background, number]
const CLOTHS = {
  1: ['#D7262E', '#FFFFFF'], 2: ['#FFFFFF', '#111111'], 3: ['#1E5BC6', '#FFFFFF'], 4: ['#F5D90A', '#111111'],
  5: ['#0F8A3C', '#FFFFFF'], 6: ['#111111', '#F5D90A'], 7: ['#F58220', '#111111'], 8: ['#F7A8C4', '#111111'],
  9: ['#3CC8C8', '#111111'], 10: ['#6A2C91', '#FFFFFF'], 11: ['#9AA0A6', '#D7262E'], 12: ['#A6D84A', '#111111'],
  13: ['#7A4A2A', '#FFFFFF'], 14: ['#7A1F2B', '#F5D90A'], 15: ['#C3B091', '#111111'], 16: ['#8EC9EE', '#D7262E'],
  17: ['#1F2A5A', '#FFFFFF'], 18: ['#1F4D2E', '#F5D90A'],
};
const cloth = num => {
  const [bg, fg] = CLOTHS[parseInt(num, 10)] || ['#3A3350', '#FFFFFF'];
  return `<span class="cloth" style="background:${bg};color:${fg}">${esc(num)}</span>`;
};

// One race's runners with their adjusted strengths, plus why the race can't be used ('' if it can).
// `need` is how many qualified runners the bet needs in this race.
function raceModel(race, need) {
  const { K, minStarts, maxUnknownShare } = CALC;
  const field = race.entrants.filter(e => !e.scratched).map(e => {
    const n = e.starts ?? 0;
    const rate = (count, prior) => ((count || 0) + K * prior) / (n + K);
    const top3 = rate((e.wins || 0) + (e.places || 0) + (e.shows || 0), 3 / 8);
    return {
      pp: String(e.pp), horse: e.horse, starts: e.starts,
      key: String(e.pp).replace(/[A-Z]+$/i, '') || String(e.pp),
      ok: e.starts != null && e.starts >= minStarts,
      // Strength at each finishing position: 1st, exactly 2nd, exactly 3rd, then top 3 for 4th and 5th
      pos: [rate(e.wins, 1 / 8), rate(e.places, 1 / 8), rate(e.shows, 1 / 8), top3, top3],
    };
  });
  const total = field.reduce((s, h) => s + h.pos[0], 0);
  field.forEach(h => { h.win = h.pos[0] / total; });
  const thin = field.filter(h => !h.ok);
  const why = !field.length ? 'no runners'
    : thin.length / field.length > maxUnknownShare ? `${thin.length} of ${field.length} runners have fewer than ${minStarts} starts`
    : field.length - thin.length < need ? `fewer than ${need} runners with ${minStarts}+ starts` : '';
  return { field, thin, why, scratched: race.entrants.length - field.length };
}

// Exacta to Super High Five: the most likely finishing orders, filling one position at a time
function topVertical(model, legs) {
  const { field } = model;
  const picks = field.filter(h => h.ok);
  // With a coupled entry (1 and 1A), orders that read the same on a ticket are added together
  const coupled = new Set(field.map(h => h.key)).size < field.length;
  const top = [], sums = new Map();
  const floor = () => (coupled || top.length < CALC.results ? 0 : top[top.length - 1].p);
  const add = (seq, p) => {
    if (coupled) {
      const k = seq.map(h => h.key).join('-'), prev = sums.get(k);
      sums.set(k, { seq: prev ? prev.seq : seq, p: (prev ? prev.p : 0) + p });
      return;
    }
    top.push({ seq, p });
    top.sort((a, b) => b.p - a.p);
    if (top.length > CALC.results) top.pop();
  };
  const placed = new Set();
  const walk = (seq, p) => {
    const at = seq.length;
    if (at === legs) return add(seq, p);
    let rest = 0;
    field.forEach(h => { if (!placed.has(h)) rest += h.pos[at]; });
    for (const h of picks) {
      if (placed.has(h) || (coupled && seq.some(x => x.key === h.key))) continue;
      const q = p * h.pos[at] / rest;
      if (q <= floor()) continue;  // later positions only make it smaller
      placed.add(h);
      walk([...seq, h], q);
      placed.delete(h);
    }
  };
  walk([], 1);
  const best = coupled ? [...sums.values()].sort((a, b) => b.p - a.p).slice(0, CALC.results) : top;
  return best.map(({ seq, p }) => ({ p, legs: seq.map(h => ({ num: h.key, name: h.horse })) }));
}

// Pick 3 / Pick 5: one winner per race. Keeping the 10 best after each leg is exact,
// since every combination shares the same choices for the legs still to come.
function topHorizontal(models, raceNums) {
  let combos = [{ p: 1, legs: [] }];
  models.forEach((m, i) => {
    const byKey = new Map();
    m.field.forEach(h => {
      const x = byKey.get(h.key) || { num: h.key, names: [], win: 0, ok: false, race: raceNums[i] };
      x.names.push(h.horse);
      x.win += h.win;
      x.ok = x.ok || h.ok;
      byKey.set(h.key, x);
    });
    const options = [...byKey.values()].filter(x => x.ok);
    combos = combos.flatMap(c => options.map(o => ({ p: c.p * o.win, legs: [...c.legs, { num: o.num, name: o.names.join(' & '), race: o.race }] })))
      .sort((a, b) => b.p - a.p).slice(0, CALC.results);
  });
  return combos;
}

const chanceText = p => { const v = p * 100; return (v >= 1 ? v.toFixed(1) : v >= 0.1 ? v.toFixed(2) : v.toFixed(3)) + '%'; };
// Fair odds: what a winning ticket should pay, to 1, for the bet to break even
const fairOdds = p => { const o = (1 - p) / p; return (o < 10 ? +o.toFixed(1) : Math.round(o)).toLocaleString() + '-1'; };

let exoticPick = null;  // the wager whose top 10 shows under the tiles

// The races a bet can use at a track: single races, or runs of consecutive races for Pick bets
function calcOptions(track, bet) {
  const races = track.card.races;
  const nums = Object.keys(races).map(Number).sort((a, b) => a - b);
  if (bet.kind === 'vertical') {
    return nums.map(n => { const m = raceModel(races[n], bet.legs); return { n, label: `Race ${n}`, why: m.why, models: [m], nums: [n] }; });
  }
  const last = nums[nums.length - 1];
  return nums.filter(n => n + bet.legs - 1 <= last).map(n => {
    const legNums = Array.from({ length: bet.legs }, (_, i) => n + i);
    const label = `Races ${n}–${n + bet.legs - 1}`;
    const missing = legNums.find(x => !races[x]);
    if (missing) return { n, label, why: `race ${missing} wasn't scraped` };
    const models = legNums.map(x => raceModel(races[x], 1));
    const bad = models.findIndex(m => m.why);
    return { n, label, why: bad < 0 ? '' : `race ${legNums[bad]}: ${models[bad].why}`, models, nums: legNums };
  });
}

// Every race (or run of races, for Pick bets) scraped today, searched for the wager's most likely tickets.
// Each race's own top 10 holds everything it could add to the day's top 10, so those are merged.
function dayTopCombos(bet) {
  const tracks = racesTracks(today());
  const found = [], skipped = [];
  let searched = 0;
  tracks.forEach(t => calcOptions(t, bet).forEach(o => {
    if (o.why) return skipped.push({ track: t.name, label: o.label, why: o.why });
    searched++;
    const combos = bet.kind === 'horizontal' ? topHorizontal(o.models, o.nums) : topVertical(o.models[0], bet.legs);
    combos.forEach(c => found.push({ ...c, track: t.name, label: o.label }));
  }));
  return { top: found.sort((a, b) => b.p - a.p).slice(0, CALC.results), searched, skipped, tracks: tracks.length };
}

function renderExoticResults() {
  $$('#exoticTiles [data-calc]').forEach(t => {
    const on = t.dataset.calc === exoticPick;
    t.classList.toggle('active', on);
    t.setAttribute('aria-pressed', on);
  });
  const box = $('#exoticResults');
  const bet = EXOTIC_INFO.find(d => d.name === exoticPick);
  if (!bet) {
    box.dataset.key = '';
    box.innerHTML = `<p class="muted small-text xc-hint">Press a wager to see today's 10 most likely tickets across every scraped race.</p>`;
    return;
  }
  // Recalculated only when the wager or today's races change, so open sections stay open
  const key = bet.name + '|' + JSON.stringify(state.cards && state.cards.tracks);
  if (box.dataset.key === key) return;
  box.dataset.key = key;

  const { top, searched, skipped, tracks } = dayTopCombos(bet);
  const horizontal = bet.kind === 'horizontal';
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  box.innerHTML = `
    <div class="xc-panel ${bet.kind}">
      <div class="xc-head">
        <h3>${esc(bet.name)}: today's top 10 <span class="kind-tag ${bet.kind}">${horizontal ? 'Multiple Races' : 'Single Race'}</span></h3>
        <span class="muted small-text">Searched ${horizontal ? plural(searched, `run`) + ` of ${bet.legs} races` : plural(searched, 'race')} at ${plural(tracks, 'track')}</span>
      </div>
      ${top.length ? `
        <ol class="xc-results">${top.map((r, i) => `
          <li class="xc-row">
            <span class="xc-rank">${i + 1}</span>
            <div class="xc-where"><b>${esc(r.track)}</b><span>${esc(r.label)}</span></div>
            <div class="xc-combo">
              <div class="xc-cloths">${r.legs.map(l => horizontal
                ? `<span class="xc-leg"><small>R${l.race}</small>${cloth(l.num)}</span>` : cloth(l.num)).join(`<span class="xc-sep">${horizontal ? '/' : '–'}</span>`)}</div>
              <div class="xc-names">${r.legs.map(l => esc(l.name)).join(' › ')}</div>
            </div>
            <div class="xc-odds"><b>${chanceText(r.p)}</b><span title="Fair odds: a winning ticket needs to pay more than this to be worth it">${fairOdds(r.p)}</span></div>
          </li>`).join('')}</ol>
        <p class="muted tiny xc-note">Chance of the ticket hitting, and its <b>fair odds</b>: it's only worth playing when TwinSpires' payout beats them.
          Runners with fewer than ${CALC.minStarts} starts are never suggested.</p>`
      : `<p class="xc-empty">No ${horizontal ? `run of ${bet.legs} races in a row` : 'race'} scraped today has enough data for a ${esc(bet.name)}.
          ${horizontal ? `Every race in the run must be scraped, and most of its runners need ${CALC.minStarts}+ starts.` : ''}</p>`}
      ${skipped.length ? `
        <details class="xc-how">
          <summary>${plural(skipped.length, horizontal ? 'run' : 'race')} skipped</summary>
          <ul class="xc-skipped">${skipped.map(s => `<li><b>${esc(s.track)}</b> ${esc(s.label)}: ${esc(s.why)}</li>`).join('')}</ul>
        </details>` : ''}
      <details class="xc-how">
        <summary>How it's calculated</summary>
        <ol>
          <li>Each runner's record is blended with an average horse's, as if it had 10 more ordinary starts, so a hot 2-for-4 doesn't outrank a steady 8-for-40.</li>
          <li>Win chances are scaled so the field adds up to 100%.</li>
          <li>2nd and 3rd use how often each horse finishes exactly 2nd or 3rd; 4th and 5th use its top-3 rate. Horses already placed are taken out at each step.</li>
          <li>Pick 3 and Pick 5 multiply each race's win chances together.</li>
          <li>Every scraped race is searched, and the 10 most likely tickets of the day are kept.</li>
        </ol>
        <p>Runners with fewer than ${CALC.minStarts} starts still count against everyone's chances, but are never suggested. Races where they're more than a third of the field are skipped. Career records are all it uses: morning-line odds, recent form and surface or distance records would sharpen it.</p>
      </details>
    </div>`;
}

$('#racesCalc').addEventListener('click', e => {
  const b = e.target.closest('[data-wps]');
  if (!b) return;
  const shown = wpsShown();
  const next = shown.includes(b.dataset.wps) ? shown.filter(k => k !== b.dataset.wps) : [...shown, b.dataset.wps];
  if (!next.length) return;  // keep at least one on
  state.wpsShown = WPS.map(([k]) => k).filter(k => next.includes(k));
  save();
  renderRaces();
});

$('#racePicker').addEventListener('click', e => {
  const b = e.target.closest('[data-race]');
  if (!b) return;
  racesView.race = +b.dataset.race;
  renderRaces();
});

/* ----- Receiving a capture: the bookmark opens Mejiro with #capture=<race JSON> ----- */

// Kept until you're signed in (and in this tab's session storage, in case sign-in reloads the page)
let pendingCaptures = [];
try { pendingCaptures = JSON.parse(sessionStorage.getItem('mejiro.captures')) || []; } catch (e) { /* storage blocked */ }
const keepPending = () => { try { sessionStorage.setItem('mejiro.captures', JSON.stringify(pendingCaptures)); } catch (e) { /* storage blocked */ } };

function takeCaptureFromAddress() {
  const m = location.hash.match(/^#capture=(.+)$/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    pendingCaptures.push(JSON.parse(decodeURIComponent(m[1])));
    keepPending();
  } catch (err) {
    toast("That capture couldn't be read. Try capturing the race again.");
  }
}

async function applyPendingCaptures() {
  while (state.user && pendingCaptures.length) {
    const c = pendingCaptures.shift();
    keepPending();
    await importCapture(c);
  }
}

// The bookmark reuses one Mejiro tab, so later captures arrive as a change of address
window.addEventListener('hashchange', () => { takeCaptureFromAddress(); applyPendingCaptures(); });

// A capture is one track: one race ({ race, entrants }) or, from "All races", its card ({ races: [{ race, entrants }] }).
// "Every track" sends several: { tracks: [{ track, total, races }] }
async function importCapture(c) {
  const date = c && /^\d{4}-\d{2}-\d{2}$/.test(c.date) ? c.date : today();
  const parts = !c ? [] : Array.isArray(c.tracks) ? c.tracks.map(t => ({ capturedAt: c.capturedAt, ...t })) : [c];
  await ensureCards(date);
  const saved = parts.map(mergeTrack).filter(Boolean);
  if (!saved.length) return toast('That capture is missing its track, race number or horses.');
  save();
  if (date === today()) racesView = { date, key: saved[0].key, race: saved[0].numbers[0] };
  goTab('races');
  renderRaces();
  renderTrackSelects();
  const horses = saved.flatMap(s => s.horses);
  const missing = horses.filter(e => e.starts == null).length;
  const { name, numbers } = saved[0];
  const what = saved.length > 1 ? `${saved.length} tracks, ${saved.reduce((n, s) => n + s.numbers.length, 0)} races`
    : `${name} ` + (numbers.length === 1 ? `race ${numbers[0]}` : `races ${numbers[0]}–${numbers[numbers.length - 1]}`);
  toast(`Captured ${what}: ${horses.length} horses` + (missing ? `, ${missing} without a record` : '') + (date === today() ? '' : ` (saved under ${date})`));
}

// Puts one track's capture into state.cards (already the capture's day); null if it's unusable
function mergeTrack(c) {
  const int = v => Math.max(0, Math.floor(+v) || 0);
  const list = !c ? [] : Array.isArray(c.races) ? c.races : [{ race: c.race, entrants: c.entrants }];
  const races = list.filter(r => r && Array.isArray(r.entrants) && r.entrants.length && int(r.race) >= 1 && int(r.race) <= MAX_RACES);
  if (!c || !c.track || !races.length) return null;
  const key = trackKey(c.track);
  if (!key) return null;
  const prev = state.cards.tracks[key] || { races: {} };
  const capturedAt = c.capturedAt || new Date().toISOString();
  const cleaned = Object.fromEntries(races.map(r => [int(r.race), {
    capturedAt,
    entrants: r.entrants.slice(0, 30).map((e, i) => ({
      pp: String(e.pp || i + 1).slice(0, 4),
      horse: String(e.horse || `Horse ${i + 1}`).slice(0, 60),
      scratched: !!e.scratched,
      ...(e.found ? { starts: int(e.starts), wins: int(e.wins), places: int(e.places), shows: int(e.shows) } : {}),
    })),
  }]));
  // Capturing a race again replaces it; the track's other races stay
  state.cards.tracks[key] = {
    name: String(c.track).slice(0, 60),
    total: int(c.total) || prev.total || null,
    races: { ...prev.races, ...cleaned },
  };
  return { key, name: state.cards.tracks[key].name, numbers: Object.keys(cleaned).map(Number).sort((a, b) => a - b),
    horses: Object.values(cleaned).flatMap(r => r.entrants) };
}

/* ----- Setting up the bookmark, and exporting everything captured ----- */

function captureBookmarkUrl() {
  const site = location.origin + location.pathname;
  return 'javascript:' + encodeURIComponent('(' + mejiroCapture.toString() + ')(' + JSON.stringify(site) + ')');
}

function openCaptureSetup() {
  openModal(`
    <h3>Set up Mejiro Capture</h3>
    <p><b>On a computer:</b> show your bookmarks bar (Ctrl+Shift+B), then drag this button onto it.</p>
    <p><a class="btn primary" id="captureBookmark" href="${esc(captureBookmarkUrl())}">Mejiro Capture</a></p>
    <p><b>On a phone:</b> copy the code, bookmark any page, then edit that bookmark: name it <i>Mejiro Capture</i> and paste the code as its address.
      To use it, open a race on TwinSpires, type <i>Mejiro Capture</i> in the address bar and tap the bookmark.</p>
    <div class="modal-actions">
      <button class="btn" id="copyCapture" type="button">Copy code</button>
      <button class="btn ghost" id="closeCapture" type="button">Close</button>
    </div>`);
  $('#captureBookmark').onclick = e => { e.preventDefault(); toast('Drag it to your bookmarks bar instead of clicking it'); };
  $('#copyCapture').onclick = () => navigator.clipboard.writeText(captureBookmarkUrl())
    .then(() => toast('Copied. Paste it as a bookmark\'s address.'), () => toast("Couldn't copy"));
  $('#closeCapture').onclick = closeModal;
}

$('#setupCapture').addEventListener('click', openCaptureSetup);

// The capture itself runs in the bookmark on TwinSpires (a site can't read another site's pages), so this explains the steps
$('#scrapeAll').addEventListener('click', () => {
  openModal(`
    <h3>Scrape all tracks</h3>
    <ol class="scrape-steps">
      <li>Open TwinSpires' <b>Today's Races</b> list, filtered how you like (e.g. Thoroughbred, North American).</li>
      <li>Click your <b>Mejiro Capture</b> bookmark. Every track it finds comes ticked; use <b>Deselect all</b> to pick just a few.</li>
      <li>Click <b>Capture ticked tracks</b> and keep that tab on screen while it works (about a second per horse). Browsers slow down hidden tabs.</li>
      <li>When it finishes, click <b>Send to Mejiro</b>. Every track lands here at once.</li>
    </ol>
    <p class="muted small-text">Programs open in whichever view you used last on TwinSpires. Leave it on <b>Advanced</b>, the view the bookmark reads.</p>
    <div class="modal-actions">
      <a class="btn primary" href="https://www.twinspires.com/bet/todays-races/time" target="twinspires" rel="noopener">Open Today's Races</a>
      <button class="btn" id="scrapeSetup" type="button">Set up the bookmark</button>
      <button class="btn ghost" id="scrapeClose" type="button">Close</button>
    </div>`);
  $('#scrapeSetup').onclick = openCaptureSetup;
  $('#scrapeClose').onclick = closeModal;
});
$('#racesEntrants').addEventListener('click', e => { if (e.target.closest('[data-setup-capture]')) openCaptureSetup(); });

// Every captured day in one CSV: one row per horse
$('#exportCards').addEventListener('click', async () => {
  await flushSave();
  let days = state.cards ? [state.cards] : [];
  if (fb && state.user) {
    try { days = (await userDoc().collection('racecards').get()).docs.map(d => d.data()); }
    catch (err) { return toast("Couldn't load your captures: " + err.message); }
  }
  const cols = ['date', 'track', 'race', 'pp', 'horse', 'starts', 'wins', 'places', 'shows', 'scratched', 'captured_at'];
  const cell = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;
  const rows = [];
  days.sort((a, b) => a.date.localeCompare(b.date)).forEach(day =>
    Object.values(day.tracks || {}).sort((a, b) => a.name.localeCompare(b.name)).forEach(t =>
      Object.entries(t.races || {}).sort((a, b) => a[0] - b[0]).forEach(([n, r]) =>
        r.entrants.forEach(e => rows.push([day.date, t.name, n, e.pp, e.horse, e.starts ?? '', e.wins ?? '',
          e.places ?? '', e.shows ?? '', e.scratched ? 'yes' : '', r.capturedAt].map(cell).join(','))))));
  if (!rows.length) return toast('Nothing captured yet');
  download(`mejiro-race-cards-${today()}.csv`, [cols.join(','), ...rows].join('\n'), 'text/csv');
});

/* =========================================================
   Mejiro Capture — the bookmark's code. It runs on a TwinSpires program page in your own
   signed-in browser: opens each runner in turn, reads the LIFE row of its record, then sends
   the race to Mejiro. It must be self-contained (the bookmark holds this function's source),
   so it repeats small helpers instead of using the ones above, and uses only block comments.
   ========================================================= */

function mejiroCapture(site) {
  if (window.__mejiroBusy) return;
  window.__mejiroBusy = true;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const html = s => clean(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const box = document.createElement('div');
  box.id = 'mejiro-capture';
  box.style.cssText = 'position:fixed;z-index:2147483647;right:12px;bottom:12px;width:min(360px,calc(100vw - 24px));' +
    'max-height:75vh;overflow:auto;padding:14px 16px;border-radius:12px;background:#0D0A14;color:#F1ECFF;text-align:left;' +
    'font:14px/1.45 system-ui,sans-serif;border:1px solid #7B61FF;box-shadow:0 10px 30px rgba(0,0,0,.5)';
  document.body.appendChild(box);
  /* While a long capture runs, every screen offers a way to stop early and keep what's read so far */
  let running = false, stop = false;
  const show = inner => {
    box.innerHTML = '<div style="font-weight:700;color:#C8B4FF;margin-bottom:6px">Mejiro Capture</div>' + inner +
      (running ? button('mc-stop', stop ? 'Stopping after this race…' : 'Stop and send what\'s done') : '');
    const s = box.querySelector('#mc-stop');
    if (s) s.onclick = () => { stop = true; s.textContent = 'Stopping after this race…'; };
  };
  const button = (id, label, primary) => `<button id="${id}" type="button" style="margin:10px 6px 0 0;padding:8px 12px;` +
    `border-radius:8px;border:1px solid #7B61FF;background:${primary ? '#7B61FF' : 'transparent'};color:#fff;font:600 13px system-ui;cursor:pointer">${label}</button>`;
  const note = text => `<div style="margin-top:10px;font-size:12px;color:#9C92BC">${text}</div>`;
  const field = 'display:block;width:100%;margin-top:4px;padding:6px 8px;border-radius:6px;border:1px solid #2A2240;background:#16111F;color:#F1ECFF;font:14px system-ui';
  const finish = () => { box.remove(); window.__mejiroBusy = false; };
  const elements = () => [...document.body.querySelectorAll('*')].filter(el => !box.contains(el));
  const leaves = () => elements().filter(el => !el.children.length);
  const up = (el, k) => { while (el && k-- > 0) el = el.parentElement; return el; };
  /* Text of each innermost element, separately: a row's textContent runs its cells together ("LIFE25203") */
  const cellTexts = el => [...el.querySelectorAll('*')].filter(c => !c.children.length).map(c => clean(c.textContent)).filter(Boolean);
  /* A real mouse press: some pages listen for pointer or mouse down/up rather than click */
  const press = el => {
    const r = el.getBoundingClientRect(), at = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(type =>
      el.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, { ...at, pointerType: 'mouse', isPrimary: true }) : new MouseEvent(type, at)));
    el.click();
  };

  /* The runner list as it is right now. Each runner has a description like "Bay, Gelding, 4 yrs (KY) L" under its name. */
  const DESC = /\b(colt|filly|mare|horse|gelding|ridgling)\b.*?\b\d{1,2}\s*yrs?\b/i;
  const findRunners = () => {
    let descs = elements().filter(el => el.textContent.length < 90 && DESC.test(clean(el.textContent)));
    descs = descs.filter(el => !descs.some(o => o !== el && el.contains(o)));
    /* Runner rows: the lowest ancestors that are distinct for every runner and share one parent */
    let rows = descs.length === 1 ? [descs[0].closest('tr') || up(descs[0], 3)] : null;
    for (let k = 1; k <= 12 && !rows && descs.length > 1; k++) {
      const r = descs.map(d => up(d, k));
      if (r.every(Boolean) && new Set(r).size === r.length && r.every(x => x.parentElement === r[0].parentElement)) rows = r;
    }
    if (!rows || !rows.length) return null;
    return descs.map((d, i) => {
      const row = rows[i];
      const nameBox = d.previousElementSibling || d.parentElement;
      /* Press the innermost element holding the name: the page listens there, and a press on a parent never reaches it */
      const inner = [...nameBox.querySelectorAll('*')].filter(el => !el.children.length && clean(el.textContent) && !d.contains(el));
      const nameEl = row.querySelector('.entry-runner-name') || inner[0] || nameBox;
      const horse = nameEl === d.parentElement ? clean(nameEl.textContent.replace(d.textContent, '')) : clean(nameEl.textContent);
      /* Program number: the saddle cloth, else the leftmost short number in the row */
      const cloth = row.querySelector('.program-number, .saddle-cloth');
      const nums = [...row.querySelectorAll('*')].filter(el => !el.children.length && /^\d{1,2}[A-Z]?$/.test(clean(el.textContent)))
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      const pp = cloth && clean(cloth.textContent) ? clean(cloth.textContent) : nums.length ? clean(nums[0].textContent) : String(i + 1);
      const scratched = cellTexts(row).includes('SCR') || /scratch/i.test(row.className) || !!row.querySelector('[class*="scratch"], [class*="Scratch"]');
      return { row, nameEl, horse, pp, scratched };
    }).filter(r => r.horse);
  };

  /* A horse's LIFE row, read only from a panel that names that horse (never from another runner's row) */
  const lifeOf = (name, rows) => {
    const key = name.toUpperCase();
    for (const label of leaves()) {
      if (clean(label.textContent).toUpperCase() !== 'LIFE') continue;
      let p = label;
      for (let i = 0; i < 15 && (p = p.parentElement); i++) {
        if (rows.some(r => r !== p && p.contains(r))) break;
        if (!clean(p.textContent).toUpperCase().includes(key)) continue;
        /* Starts, wins, places, shows: the first four whole numbers after LIFE (earnings has a "$") */
        const row = label.closest('tr') || label.parentElement;
        let n = cellTexts(row).filter(t => /^\d+$/.test(t));
        if (n.length < 4) n = ((row.innerText || '').match(/LIFE\D*?(\d+)\D+?(\d+)\D+?(\d+)\D+?(\d+)/i) || []).slice(1);
        if (n.length >= 4) return { starts: +n[0], wins: +n[1], places: +n[2], shows: +n[3] };
        break;
      }
    }
    return null;
  };

  const texts = () => leaves().map(el => [el, clean(el.textContent)]).filter(([, t]) => t && t.length < 40);
  const raceNow = () => { const hit = texts().find(([, t]) => /^RACE\s*\d{1,2}$/i.test(t)); return hit ? +hit[1].match(/\d+/)[0] : 0; };
  /* The previous/next race buttons read "R7", "R9" */
  const raceButton = n => leaves().find(el => clean(el.textContent) === 'R' + n);
  const trackName = () => {
    const named = document.querySelector('.track-name');
    if (named && clean(named.textContent)) return clean(named.textContent);
    const NAV = /^(PROGRAM|POOLS|PPS|STATS|RESULTS|VIDEO|CLASSIC|BASIC|ADVANCED|SPEED|CLASS|PACE|SUMMARY|TIPS|OFFICIAL|GLOSSARY|RUNNER|JOCKEY|TRAINER|ODDS|PL|RECORD|LIFE|SCR|NEW|FAQ)$/;
    const hit = texts().find(([el, t]) => /^[A-Z][A-Za-z .'&-]{2,34}$/.test(t) && !NAV.test(t.toUpperCase()) && !/^R(ACE)?\s*\d/i.test(t)
      && el.getBoundingClientRect().top < 250 && !el.closest('nav, header'));
    return hit ? hit[1] : '';
  };

  /* TwinSpires' Today's Races list (your filters apply): one row per track, with an id like
     "featured-track-ind-race-10" (track code, the race it's on) and a badge with minutes to post, or OFFICIAL once that race is run */
  const listRows = () => {
    const found = new Map();
    document.querySelectorAll('.track-list--row[id*="-track-"]').forEach(row => {
      const m = row.id.match(/-track-([a-z0-9]+)-race-(\d+)$/i);
      const nameEl = [...row.querySelectorAll('.track-name')].pop();
      if (!m || !nameEl || found.has(m[1])) return;  /* Featured tracks are listed twice */
      const badge = row.querySelector('.mtp-badge');
      const status = badge ? cellTexts(badge).join(' ') : '';
      found.set(m[1], { code: m[1], name: clean(nameEl.textContent), race: +m[2], status, finished: /official/i.test(status) });
    });
    return [...found.values()];
  };

  /* Change pages inside TwinSpires (as its own Back button does), so this panel keeps running */
  const waitFor = async (test, tries) => { for (let i = 0; i < tries; i++) { if (test()) return true; await sleep(200); } return !!test(); };
  const toList = async () => {
    if (listRows().length) return true;
    history.pushState(null, '', '/bet/todays-races/time');
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    return waitFor(() => listRows().length, 75);
  };
  /* Open a track's program by pressing its name in the list, then wait for its runners */
  const openFromList = async t => {
    if (!await toList()) return false;
    const row = document.querySelector(`.track-list--row[id*="-track-${t.code}-race-"]`);
    if (!row) return false;
    const target = [...row.querySelectorAll('.track-name')].pop() || row;
    target.scrollIntoView({ block: 'center' });
    press(target);
    if (!await waitFor(() => !listRows().length && (findRunners() || []).length && raceNow(), 100)) return false;
    await sleep(800);
    return true;
  };

  /* Three parts: the runner list, an open LIFE panel if any, and the short texts near the top of the page */
  const outline = () => {
    const strip = root => {
      const copy = root.cloneNode(true);
      copy.querySelectorAll('script,style,svg,img,iframe,noscript,#mejiro-capture').forEach(n => n.remove());
      copy.querySelectorAll('*').forEach(n => [...n.attributes].forEach(a => {
        if (!['class', 'id', 'role', 'aria-label', 'aria-expanded', 'href'].includes(a.name) && !a.name.startsWith('data-')) n.removeAttribute(a.name);
      }));
      /* Long repeats (40 tracks, 12 runners) only need their first few to show the pattern */
      [copy, ...copy.querySelectorAll('*')].forEach(n => {
        if (n.children.length <= 4) return;
        const extra = [...n.children].slice(4);
        extra.forEach(c => c.remove());
        n.append(document.createComment(` +${extra.length} more `));
      });
      return copy.outerHTML;
    };
    const runners = findRunners();
    const anchor = runners ? runners[0].row : leaves().find(el => /^runner$/i.test(clean(el.textContent)));
    const life = leaves().find(el => /^life$/i.test(clean(el.textContent)));
    const top = leaves().filter(el => { const r = el.getBoundingClientRect(); return r.top < 320 && r.height > 0; })
      .map(el => `${el.tagName.toLowerCase()}.${typeof el.className === 'string' ? el.className.trim().replace(/\s+/g, '.') : ''}: ${clean(el.textContent)}`)
      .filter(t => !/:\s*$/.test(t)).slice(0, 120);
    /* On a list page (Today's Races) there are no runners: show the track list itself */
    const group = !runners && document.querySelector('[class*="track-list"]');
    const listRoot = group && (group.closest('main, [class*="content"]') || up(group, 3));
    return [
      '<!-- TRACK LIST -->', listRoot ? strip(listRoot) : '(none)',
      '<!-- RUNNER LIST -->', anchor ? strip(up(anchor, 2) || anchor) : '(not found)',
      '<!-- LIFE PANEL -->', life ? strip(up(life, 8) || life) : '(no "LIFE" text on the page: open a horse\'s record by hand first)',
      '<!-- TOP OF PAGE -->', top.join('\n'),
      '<!-- ADDRESS -->', location.pathname + location.search].join('\n').slice(0, 200000);
  };
  const copyButton = () => {
    const b = box.querySelector('#mc-copy');
    if (b) b.onclick = () => navigator.clipboard.writeText(outline()).then(() => { b.textContent = 'Copied'; });
  };

  /* Open each runner in turn and read its record */
  const readRace = async prefix => {
    const runners = findRunners();
    if (!runners) return null;
    const rows = runners.map(r => r.row);
    const out = [];
    for (let i = 0; i < runners.length; i++) {
      const r = runners[i];
      show(`${prefix}Reading ${i + 1} of ${runners.length}: <b>${html(r.horse)}</b>…`);
      let life = lifeOf(r.horse, rows);  /* already open */
      for (const target of [r.nameEl, r.row].filter((t, k, a) => t && a.indexOf(t) === k)) {
        if (life) break;
        target.scrollIntoView({ block: 'center' });
        press(target);
        for (let t = 0; t < (r.scratched ? 10 : 25) && !life; t++) { await sleep(150); life = lifeOf(r.horse, rows); }
      }
      out.push(Object.assign({ pp: r.pp, horse: r.horse, scratched: r.scratched, found: !!life }, life || {}));
      await sleep(200);
    }
    return out;
  };

  /* Switch races with the page's own R7/R9 buttons, then wait until the new race's runners are showing */
  const goTo = async n => {
    const control = raceButton(n);
    if (!control) return false;
    const before = (findRunners() || []).map(r => r.horse).join('|');
    press(control);
    for (let t = 0; t < 80; t++) {
      await sleep(150);
      const now = findRunners();
      if (raceNow() === n && now && now.length && now.map(r => r.horse).join('|') !== before) { await sleep(500); return true; }
    }
    return raceNow() === n;
  };

  /* The track that's showing, from race `from` (1 for the whole card) forward until there's no next-race button */
  const readCard = async (prefix, from) => {
    const races = [];
    let n = raceNow() || 1;
    while (n > from) {
      show(`${prefix}Going back to Race ${n - 1}…`);
      if (!await goTo(n - 1)) break;
      n = raceNow();
    }
    while (n < from) {
      show(`${prefix}Going to Race ${n + 1}…`);
      if (!await goTo(n + 1)) break;
      n = raceNow();
    }
    let total = null;
    while (races.length < 15) {
      const entrants = await readRace(`${prefix}Race ${n}: `);
      if (entrants) races.push({ race: n, entrants });
      if (!raceButton(n + 1)) { total = n; break; }  /* no next-race button: this is the last race */
      if (stop) break;
      show(`${prefix}Opening Race ${n + 1}…`);
      if (!await goTo(n + 1)) break;
      n = raceNow();
      if (races.some(r => r.race === n)) break;
    }
    return { races, total };
  };

  /* "Send to Mejiro" opens the site with the capture in the address (after the #, so it never leaves your browser) */
  const sendLink = `<a id="mc-send" href="#" target="mejiro" style="display:inline-block;margin:10px 6px 0 0;padding:8px 12px;border-radius:8px;` +
    `background:#7B61FF;color:#fff;font:600 13px system-ui;text-decoration:none">Send to Mejiro</a>`;
  const wireSend = payload => {
    const send = box.querySelector('#mc-send');
    send.onclick = () => {
      const p = payload();
      if (!p) return false;
      const now = new Date(), date = new Date(now - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
      send.href = site + '#capture=' + encodeURIComponent(JSON.stringify({ v: 3, source: 'twinspires', date, capturedAt: now.toISOString(), ...p }));
      setTimeout(finish, 500);
    };
  };

  const doneAll = (cards, failed, over) => {
    running = false;
    const all = cards.flatMap(c => c.races.flatMap(r => r.entrants));
    const found = all.filter(e => e.found).length;
    const list = cards.map(c => { const n = c.races.flatMap(r => r.entrants), f = n.filter(e => e.found).length;
      return `<b>${html(c.track)}</b>: ${c.races.length} race${c.races.length === 1 ? '' : 's'}, ${n.length} horse${n.length === 1 ? '' : 's'}` + (f < n.length ? ` <span style="color:#FF5C6C">(${n.length - f} without a record)</span>` : ''); });
    show(`<div>Read ${found} of ${all.length} records across ${cards.length} tracks.</div>` + note(list.join('<br>')) +
      (failed.length ? note(`<span style="color:#FF5C6C">Couldn't open: ${failed.map(html).join(', ')}</span>`) : '') +
      (over.length ? note(`Already finished for the day: ${over.map(html).join(', ')}`) : '') +
      (cards.length ? sendLink : '') + button('mc-close', 'Close') +
      (failed.length ? note('If no track opened, copy the page outline and paste it to Claude.') + button('mc-copy', 'Copy page outline') : ''));
    box.querySelector('#mc-close').onclick = finish;
    copyButton();
    if (cards.length) wireSend(() => ({ tracks: cards }));
  };

  const done = (races, track, total) => {
    running = false;
    const all = races.flatMap(r => r.entrants);
    const found = all.filter(e => e.found).length;
    const single = races.length === 1;
    const list = single
      ? races[0].entrants.map(e => `#${html(e.pp)} ${html(e.horse)}${e.scratched ? ' (SCR)' : ''}: ` +
          (e.found ? `${e.starts}-${e.wins}-${e.places}-${e.shows}` : '<span style="color:#FF5C6C">no record</span>')).join('<br>')
      : races.map(r => { const f = r.entrants.filter(e => e.found).length; return `Race ${r.race}: ${r.entrants.length} horses` +
          (f < r.entrants.length ? ` <span style="color:#FF5C6C">(${r.entrants.length - f} without a record)</span>` : ''); }).join('<br>');
    show(`<div>Read ${found} of ${all.length} records${single ? '' : ` across ${races.length} races`}.</div>` +
      `<label style="display:block;margin-top:10px;font-size:12px;color:#9C92BC">Track<input id="mc-track" style="${field}" value="${html(track)}"></label>` +
      (single ? `<label style="display:block;margin-top:8px;font-size:12px;color:#9C92BC">Race<input id="mc-race" type="number" min="1" max="15" style="${field}" value="${races[0].race || ''}"></label>` : '') +
      note(list) + sendLink + button('mc-close', 'Close') +
      (found < all.length ? note('Records missing? Open one horse\'s record by hand (click its name), then copy the page outline and paste it to Claude.') + button('mc-copy', 'Copy page outline') : ''));
    box.querySelector('#mc-close').onclick = finish;
    copyButton();
    wireSend(() => {
      const name = clean(box.querySelector('#mc-track').value);
      const raceField = box.querySelector('#mc-race');
      if (raceField) races[0].race = +raceField.value;
      if (!name || races.some(r => !(r.race >= 1 && r.race <= 15))) { alert('Enter the track and a race number from 1 to 15.'); return null; }
      return { track: name, total, races };
    });
  };

  /* Every track: pick from TwinSpires' Today's Races list, then open each track from it in turn */
  const chooseTracks = async () => {
    show("Opening TwinSpires' Today's Races list…");
    await toList();
    const tracks = listRows();
    if (!tracks.length) {
      show("Couldn't open TwinSpires' Today's Races list. Go to <b>Bet Now → Today's Races</b> yourself, then press <b>Look again</b>." +
        button('mc-again', 'Look again', true) + button('mc-copy', 'Copy page outline') + button('mc-close', 'Close') +
        note('Still nothing? Copy the page outline and paste it to Claude.'));
      box.querySelector('#mc-again').onclick = chooseTracks;
      box.querySelector('#mc-close').onclick = finish;
      copyButton();
      return;
    }
    /* Every track TwinSpires lists starts ticked */
    const label = 'display:flex;gap:8px;align-items:center;padding:2px 0;cursor:pointer';
    show(`<div>Today's tracks on TwinSpires (${tracks.length}).</div>` +
      `<label style="${label};margin-top:8px;color:#C8B4FF"><input type="checkbox" id="mc-upcoming" checked> Only races that haven't run yet</label>` +
      `<div style="margin-top:6px;max-height:40vh;overflow:auto">` +
      tracks.map((t, i) => `<label style="${label}"><input type="checkbox" data-i="${i}" checked> ${html(t.name)}` +
        `<span style="margin-left:auto;font-size:12px;color:#9C92BC">${t.finished ? 'finished' : `R${t.race}${t.status ? ' · ' + html(t.status) : ''}`}</span></label>`).join('') + '</div>' +
      button('mc-toggle', 'Deselect all') + '<br>' + button('mc-go', 'Capture ticked tracks', true) + button('mc-close', 'Close') +
      note('About a second per horse. Keep this tab on screen until it finishes: browsers slow down hidden tabs.'));
    const boxes = [...box.querySelectorAll('input[data-i]')], toggle = box.querySelector('#mc-toggle');
    const allOn = () => boxes.every(c => c.checked);
    const syncToggle = () => { toggle.textContent = allOn() ? 'Deselect all' : 'Select all'; };
    toggle.onclick = () => { const on = !allOn(); boxes.forEach(c => { c.checked = on; }); syncToggle(); };
    boxes.forEach(c => { c.onchange = syncToggle; });
    box.querySelector('#mc-close').onclick = finish;
    box.querySelector('#mc-go').onclick = async () => {
      const picked = boxes.filter(c => c.checked).map(c => tracks[+c.dataset.i]);
      const upcoming = box.querySelector('#mc-upcoming').checked;
      if (!picked.length) return;
      running = true;
      const cards = [], failed = [], over = [];
      for (let i = 0; i < picked.length && !stop; i++) {
        const t = picked[i], prefix = `<b>${html(t.name)}</b> (track ${i + 1} of ${picked.length}) · `;
        /* With "only races that haven't run yet", a finished card has nothing left to read */
        if (upcoming && t.finished) { over.push(t.name); continue; }
        show(`${prefix}opening…`);
        if (!await openFromList(t)) { failed.push(t.name); continue; }
        const { races, total } = await readCard(prefix, upcoming ? t.race : 1);
        if (races.length) cards.push({ track: t.name, total, races });
        else failed.push(t.name);
      }
      doneAll(cards, failed, over);
    };
  };

  const first = findRunners();
  if (!first || !first.length) {
    /* On the Today's Races list itself: straight to picking tracks */
    if (listRows().length) return chooseTracks();
    show("No horses on this page. Open a track's <b>PROGRAM</b>, or TwinSpires' <b>Today's Races</b> list, then click the bookmark again." +
      note('If it still fails, copy the page outline and paste it to Claude.') +
      button('mc-copy', 'Copy page outline', true) + button('mc-close', 'Close'));
    copyButton();
    box.querySelector('#mc-close').onclick = finish;
    return;
  }
  const track = trackName(), start = raceNow();
  show(`<div><b>${html(track) || 'This track'}</b>${start ? ` · Race ${start}` : ''}: ${first.length} runners.</div>` +
    button('mc-one', 'This race', true) + button('mc-all', 'All races') + button('mc-every', 'Every track') + button('mc-close', 'Close') +
    note('<b>All races</b> goes back to Race 1, then reads every race on the card (about a second per horse). ' +
      '<b>Every track</b> goes to TwinSpires\' Today\'s Races list so you can pick tracks. Keep this tab on screen while it works: browsers slow down hidden tabs.'));
  box.querySelector('#mc-close').onclick = finish;
  box.querySelector('#mc-one').onclick = async () => {
    const entrants = await readRace('');
    done([{ race: start, entrants: entrants || [] }], track, null);
  };
  box.querySelector('#mc-all').onclick = async () => {
    running = true;
    const { races, total } = await readCard('', 1);
    done(races, track, total);
  };
  box.querySelector('#mc-every').onclick = chooseTracks;
}

/* =========================================================
   Strategies — short notes, kept per mode. Basic is one list of Win / Place / Show notes;
   Exotic groups its notes by categories you name (Edit categories).
   Drag the ☰ handle to reorder within a group; a note's menu moves it to another category.
   ========================================================= */

const strategyById = id => state.strategies.find(s => s.id === id);
const categories = () => state.strategyCategories || [];
// Notes from before the modes have no mode: categorized ones were exotic, the rest Win / Place / Show
const strategyMode = s => s.mode || (s.category ? 'exotic' : 'basic');

function renderStrategies() {
  // Stamp older notes with their mode, so clearing a category later can't move them to Basic
  (state.strategies || []).forEach(s => { if (!s.mode) s.mode = strategyMode(s); });
  const cats = isExotic() ? categories() : [];
  const known = new Set(cats.map(c => c.id));
  const notes = (state.strategies || []).filter(s => strategyMode(s) === (isExotic() ? 'exotic' : 'basic'));
  // One group per category, then Uncategorized (shown when it has notes, or before any category exists)
  const groups = [...cats, { id: '', name: cats.length ? 'Uncategorized' : 'Your strategies' }];
  const inGroup = g => notes.filter(s => (known.has(s.category) ? s.category : '') === g.id);
  const catSelect = s => `<select class="strategy-cat" aria-label="Category"><option value="">Uncategorized</option>${cats.map(c =>
    `<option value="${esc(c.id)}" ${s.category === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`;
  $('#strategyGroups').innerHTML = groups.filter(g => g.id || inGroup(g).length || !cats.length).map(g => `
    <div class="card strategy-group">
      <div class="card-head">
        <h3>${esc(g.name)} <span class="muted small-text">${inGroup(g).length || ''}</span></h3>
        <button type="button" class="btn tiny-btn" data-add-strategy="${esc(g.id)}">+ Add</button>
      </div>
      <ul class="strategy-list">${inGroup(g).map(s => `
        <li class="strategy" data-id="${s.id}">
          <button type="button" class="drag-handle" title="Drag to reorder" aria-label="Drag to reorder">☰</button>
          <textarea rows="2" placeholder="Describe a strategy…">${esc(s.text)}</textarea>
          <div class="strategy-side">
            ${cats.length ? catSelect(s) : ''}
            <button type="button" class="btn tiny-btn ghost danger" data-delete-strategy title="Delete">✕</button>
          </div>
        </li>`).join('') || `<li class="empty">${notes.length ? 'Nothing here yet.' : 'No strategies yet. Click <b>+ Add strategy</b> to write one.'}</li>`}</ul>
    </div>`).join('');
}

function addStrategy(category) {
  const s = { id: uid(), text: '', mode: isExotic() ? 'exotic' : 'basic', category };
  state.strategies = [...(state.strategies || []), s];
  save();
  renderStrategies();
  $(`.strategy[data-id="${s.id}"] textarea`).focus();
}

$('#addStrategy').addEventListener('click', () => addStrategy(''));

// Typing saves without re-rendering, so the cursor stays put
$('#strategyGroups').addEventListener('input', e => {
  if (e.target.tagName !== 'TEXTAREA') return;
  strategyById(e.target.closest('.strategy').dataset.id).text = e.target.value;
  save();
});

$('#strategyGroups').addEventListener('change', e => {
  if (!e.target.classList.contains('strategy-cat')) return;
  strategyById(e.target.closest('.strategy').dataset.id).category = e.target.value;
  save();
  renderStrategies();
});

$('#strategyGroups').addEventListener('click', async e => {
  const add = e.target.closest('[data-add-strategy]');
  if (add) return addStrategy(add.dataset.addStrategy);
  if (!e.target.closest('[data-delete-strategy]')) return;
  const s = strategyById(e.target.closest('.strategy').dataset.id);
  if (s.text.trim() && !await confirmModal('Delete strategy?', 'This removes it permanently.', 'Delete', true)) return;
  state.strategies = state.strategies.filter(x => x !== s);
  save();
  renderStrategies();
});

// Add, rename and delete categories; changes apply on Save. A deleted category's strategies become Uncategorized.
function openCategoryEditor() {
  const draft = categories().map(c => ({ ...c }));
  const draw = () => {
    openModal(`
      <h3>Edit categories</h3>
      <p class="muted small-text">Group your exotic strategies however you like: Exactas, Trifecta boxes, Pick 5s… Deleting a category moves its strategies to Uncategorized.</p>
      <ul class="cat-list">${draft.map((c, i) => `
        <li><input type="text" data-i="${i}" value="${esc(c.name)}" placeholder="Category name" maxlength="40">
          <button type="button" class="btn tiny-btn ghost danger" data-del="${i}" title="Delete category">✕</button></li>`).join('')
        || '<li class="empty">No categories yet.</li>'}</ul>
      <button class="btn" id="catAdd" type="button">+ Add category</button>
      <div class="modal-actions">
        <button class="btn ghost" id="catCancel" type="button">Cancel</button>
        <button class="btn primary" id="catSave" type="button">Save</button>
      </div>`);
    $$('.cat-list input').forEach(inp => { inp.oninput = () => { draft[+inp.dataset.i].name = inp.value; }; });
    $$('.cat-list [data-del]').forEach(b => { b.onclick = () => { draft.splice(+b.dataset.del, 1); draw(); }; });
    $('#catAdd').onclick = () => { draft.push({ id: uid(), name: '' }); draw(); $$('.cat-list input').pop().focus(); };
    $('#catCancel').onclick = closeModal;
    $('#catSave').onclick = () => {
      state.strategyCategories = draft.map(c => ({ id: c.id, name: c.name.trim() })).filter(c => c.name);
      const ids = new Set(state.strategyCategories.map(c => c.id));
      (state.strategies || []).forEach(s => { if (s.category && !ids.has(s.category)) s.category = ''; });
      save();
      renderStrategies();
      closeModal();
    };
  };
  draw();
}

$('#editCategories').addEventListener('click', openCategoryEditor);

// Drag with pointer events (works with mouse and touch): the row follows the handle,
// and its group's list reorders as it passes other rows
$('#strategyGroups').addEventListener('pointerdown', e => {
  const handle = e.target.closest('.drag-handle');
  if (!handle) return;
  e.preventDefault();
  const row = handle.closest('.strategy');
  const list = row.closest('.strategy-list');
  row.classList.add('dragging');
  try { handle.setPointerCapture(e.pointerId); } catch (err) { /* capture is a nicety; dragging still works */ }

  const move = ev => {
    const others = [...list.children].filter(li => li !== row);
    const after = others.find(li => ev.clientY < li.getBoundingClientRect().top + li.offsetHeight / 2);
    if (after) { if (row.nextElementSibling !== after) list.insertBefore(row, after); }
    else if (list.lastElementChild !== row) list.appendChild(row);
  };
  const end = () => {
    handle.removeEventListener('pointermove', move);
    row.classList.remove('dragging');
    // This mode's notes in their new order, then the other mode's, untouched
    const order = $$('#strategyGroups .strategy').map(li => li.dataset.id);
    state.strategies = [...order.map(strategyById).filter(Boolean), ...state.strategies.filter(s => !order.includes(s.id))];
    save();
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', end, { once: true });
  handle.addEventListener('pointercancel', end, { once: true });
});

/* =========================================================
   Risk Matrix
   ========================================================= */

function renderMatrix() {
  const tiers = sortedMatrix();
  const br = bankroll();
  const cur = currentTier(br);
  $('#matrixCurrent').textContent = cur ? `Bankroll ${money(br)} → ${cur.pct}% risk` : '';

  // Chart: one series, one bar per tier; current tier highlighted
  const W = 760, H = 260, padL = 40, padR = 8, padT = 22, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxY = Math.max(100, ...tiers.map(t => t.pct));
  const band = tiers.length ? plotW / tiers.length : plotW;
  const barW = Math.min(44, band - 6);
  const y = v => padT + plotH - (v / maxY) * plotH;

  const grid = [0, 25, 50, 75, 100].filter(v => v <= maxY).map(v => `
    <g class="grid"><line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/></g>
    <g class="axis"><text x="${padL - 8}" y="${y(v) + 4}" text-anchor="end">${v}%</text></g>`).join('');

  const bars = tiers.map((t, i) => {
    const cx = padL + band * i + band / 2;
    const top = y(t.pct), h = Math.max(2, padT + plotH - top);
    const r = Math.min(4, h / 2, barW / 2);
    const x0 = cx - barW / 2, base = padT + plotH;
    // Rounded top, square base
    const d = `M${x0},${base}V${base - h + r}Q${x0},${base - h} ${x0 + r},${base - h}H${x0 + barW - r}Q${x0 + barW},${base - h} ${x0 + barW},${base - h + r}V${base}Z`;
    const isCur = cur && t.size === cur.size && t.pct === cur.pct;
    return `
      <g class="col" data-i="${i}">
        <rect class="hit" x="${padL + band * i}" y="${padT}" width="${band}" height="${plotH + padB}"/>
        <path class="bar ${isCur ? 'current' : ''}" d="${d}"/>
        <text class="bar-label" x="${cx}" y="${base - h - 6}">${t.pct}%</text>
        <g class="axis"><text x="${cx}" y="${H - 10}" text-anchor="middle">${fmtSize(t.size)}</text></g>
      </g>`;
  }).join('');

  $('#matrixChart').innerHTML = tiers.length
    ? `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Risk percentage by portfolio size">${grid}${bars}</svg>`
    : '<p class="muted">No tiers. Add one below.</p>';

  $$('#matrixChart g.col').forEach(g => {
    const t = tiers[+g.dataset.i];
    g.addEventListener('mousemove', e => showTip(
      `<b>${fmtSize(t.size)}+ portfolio</b>Risk ${t.pct}% · ${money(t.size * t.pct / 100)} stake at tier start`,
      e.clientX, e.clientY));
    g.addEventListener('mouseleave', hideTip);
  });
}

// Tiers are edited in a popup; nothing changes until Save (closing it any other way discards the edits)
function openTierEditor() {
  const cur = currentTier();
  let draft = sortedMatrix().map(t => ({ ...t, current: t === cur }));
  openModal(`
    <h3>Edit tiers</h3>
    <p class="small-text">A tier applies once your bankroll reaches its portfolio size. Below the smallest tier, the smallest tier's risk % is used.
      Your current tier is highlighted.</p>
    <div class="table-wrap"><table class="table tier-table">
      <thead><tr><th>Portfolio size ($)</th><th>Risk %</th><th class="num">Stake at tier start</th><th></th></tr></thead>
      <tbody id="tierRows"></tbody>
    </table></div>
    <div class="tier-tools">
      <button class="btn" id="tierAdd" type="button">+ Add tier</button>
      <button class="btn ghost" id="tierDefaults" type="button">Reset to defaults</button>
    </div>
    <div class="modal-actions">
      <button class="btn ghost" id="tierCancel" type="button">Cancel</button>
      <button class="btn primary" id="tierSave" type="button">Save</button>
    </div>`, { wide: true });

  const body = $('#tierRows');
  const draw = () => {
    body.innerHTML = draft.map((t, i) => `
      <tr class="${t.current ? 'current' : ''}">
        <td><input type="number" min="0" step="any" value="${t.size}" data-i="${i}" data-field="size" aria-label="Portfolio size"></td>
        <td><input type="number" min="0" max="100" step="any" value="${t.pct}" data-i="${i}" data-field="pct" aria-label="Risk percent"></td>
        <td class="num" data-stake="${i}">${money(t.size * t.pct / 100)}</td>
        <td><button class="btn tiny-btn ghost danger" type="button" data-remove="${i}" title="Remove tier">✕</button></td>
      </tr>`).join('') || '<tr><td colspan="4" class="empty">No tiers. Add one below.</td></tr>';
  };
  draw();
  // Typing updates the stake as you go; rows re-sort by size when you save
  body.oninput = e => {
    const inp = e.target.closest('input[data-i]');
    if (!inp) return;
    const t = draft[+inp.dataset.i];
    t[inp.dataset.field] = num(inp.value);
    $(`[data-stake="${inp.dataset.i}"]`).textContent = money(t.size * t.pct / 100);
  };
  body.onclick = e => {
    const b = e.target.closest('[data-remove]');
    if (!b) return;
    draft.splice(+b.dataset.remove, 1);
    draw();
  };
  $('#tierAdd').onclick = () => {
    const last = [...draft].sort((a, b) => a.size - b.size).pop();
    draft.push({ size: last ? last.size * 2 : 2, pct: last ? last.pct : 100 });
    draw();
    $$('#tierRows input[data-field="size"]').pop().focus();
  };
  $('#tierDefaults').onclick = () => { draft = DEFAULT_MATRIX.map(t => ({ ...t })); draw(); };
  $('#tierCancel').onclick = closeModal;
  $('#tierSave').onclick = () => {
    state.matrix = draft.map(({ size, pct }) => ({ size, pct })).sort((a, b) => a.size - b.size);
    save(); renderMatrix(); renderTracker();
    closeModal();
    toast('Tiers saved');
  };
}

$('#editTiers').addEventListener('click', openTierEditor);

/* ----- Exotic wagers at a glance: a sortable reference table. Difficulty is a fixed 1–6 ranking
   (no two bets share one); min bet and average payout start as ballpark defaults you can edit.
     ROI               = average payout ÷ min bet
     Possible outcomes = every result with N horses per race: N×(N−1)×… for a vertical bet's
                         `legs` places, N^legs for a horizontal bet's `legs` races
     Break-even        = how often a min-bet ticket must hit to pay for itself: 1 in ROI ----- */

const STAR_MAX = 6;
const starsHTML = n => `<span class="stars" title="${n} of ${STAR_MAX}" aria-label="${n} of ${STAR_MAX} stars">${'★'.repeat(n)}<span class="off">${'★'.repeat(STAR_MAX - n)}</span></span>`;
const EXOTIC_INFO = [
  // kind: vertical = several finishers in one race; horizontal = one winner in each of several races
  // short: the one-liner on Today's Races' Exotic Wagering tiles
  { name: 'Exacta', kind: 'vertical', legs: 2, stars: 1, min: 1, payout: 30, short: '1st and 2nd, in order',
    about: 'Pick the horses that finish 1st and 2nd, in that exact order. A "box" covers both orders for twice the cost.' },
  { name: 'Pick 3', kind: 'horizontal', legs: 3, stars: 2, min: 0.5, payout: 40, short: 'Winners of 3 races in a row',
    about: 'Pick the winner of 3 races in a row on one ticket, placed before the first of them. More horses per race means more combinations, and the cost multiplies.' },
  { name: 'Trifecta', kind: 'vertical', legs: 3, stars: 3, min: 0.5, payout: 100, short: '1st, 2nd and 3rd, in order',
    about: 'Pick the horses that finish 1st, 2nd and 3rd, in that exact order. Boxing 3 horses covers all 6 orders for 6× the cost.' },
  { name: 'Superfecta', kind: 'vertical', legs: 4, stars: 4, min: 0.1, payout: 150, short: '1st through 4th, in order',
    about: 'Pick the horses that finish 1st through 4th, in that exact order. Usually played for 10¢ with several horses boxed, since one exact order rarely hits.' },
  { name: 'Pick 5', kind: 'horizontal', legs: 5, stars: 5, min: 0.5, payout: 1000, short: 'Winners of 5 races in a row',
    about: 'Pick the winners of 5 races in a row on one ticket. When nobody hits all five, the pool often carries over to the next day, which is how the big payouts build.' },
  { name: 'Super High Five', kind: 'vertical', legs: 5, stars: 6, min: 0.2, payout: 1500, short: '1st through 5th, in order',
    about: 'Pick the horses that finish 1st through 5th, in that exact order. Some tracks run it as a jackpot: the whole pool pays only when exactly one ticket hits, otherwise most of it carries over.' },
];
const EXOTIC_COLS = [
  ['name', 'Bet name'], ['stars', 'Difficulty to land'], ['min', 'Min bet'], ['payout', 'Avg payout'], ['roi', 'ROI (payout ÷ min bet)'],
  ['outcomes', 'Possible outcomes', 'Every possible result with this many horses in each race'],
  ['breakeven', 'Break-even', 'How often a min-bet ticket has to hit to pay for itself at the average payout'],
];
let exoticSort = { key: 'stars', dir: 1 };
let exoticEditing = false;

const fieldSize = () => Math.min(14, Math.max(5, Math.round(num(state.exoticField) || 10)));
// N×(N−1)×… for places in one race; N×N×… for winners of separate races
const outcomes = (kind, legs, n) => kind === 'vertical'
  ? Array.from({ length: legs }, (_, i) => n - i).reduce((p, x) => p * Math.max(0, x), 1)
  : n ** legs;

const exoticRows = () => EXOTIC_INFO.map(d => {
  const mine = (state.exoticInfo || {})[d.name] || {};
  const min = mine.min ?? d.min, payout = mine.payout ?? d.payout;
  const roi = min > 0 ? payout / min : 0;
  return { ...d, min, payout, roi, outcomes: outcomes(d.kind, d.legs, fieldSize()), breakeven: roi ? 1 / roi : Infinity };
});

function renderExoticTable() {
  const { key, dir } = exoticSort;
  const rows = exoticRows().sort((a, b) => (key === 'name' ? a.name.localeCompare(b.name) : a[key] - b[key]) * dir || a.name.localeCompare(b.name));
  $('#exoticField').value = fieldSize();
  // ROI spans 30× to several thousand ×, so its bars use a log scale
  const top = Math.log10(Math.max(10, ...rows.map(r => r.roi)));
  const pct = v => v >= 0.01 ? (v * 100).toFixed(1) + '%' : (v * 100).toFixed(2) + '%';
  const field = (r, f) => exoticEditing
    ? `<input type="number" class="w-sm" min="0" step="0.01" data-exotic="${esc(r.name)}" data-field="${f}" value="${r[f]}" aria-label="${esc(r.name)} ${f === 'min' ? 'min bet' : 'average payout'}">`
    : money(r[f]);
  $('#exoticTable').innerHTML = `
    <thead><tr>${EXOTIC_COLS.map(([k, label, hint]) => `
      <th class="${k === 'name' || k === 'stars' ? '' : 'num'}" aria-sort="${k === key ? (dir > 0 ? 'ascending' : 'descending') : 'none'}">
        <button type="button" class="sort-btn ${k === key ? 'active' : ''}" data-sort="${k}" ${hint ? `title="${esc(hint)}"` : ''}>${label}<span class="sort-arrow">${k === key ? (dir > 0 ? '▲' : '▼') : '↕'}</span></button></th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `
      <tr>
        <td class="bet-cell ${r.kind}"><span class="bet-name" tabindex="0" data-about="${esc(r.name)}"><b>${esc(r.name)}</b><span class="info-dot" aria-hidden="true">i</span></span>
          <span class="kind-tag ${r.kind}">${r.kind === 'vertical' ? 'Vertical' : 'Horizontal'}</span></td>
        <td>${starsHTML(r.stars)}</td>
        <td class="num">${field(r, 'min')}</td>
        <td class="num">${field(r, 'payout')}</td>
        <td class="num"><div class="roi-cell"><span class="roi-track"><span style="width:${r.roi > 1 ? Math.log10(r.roi) / top * 100 : 0}%"></span></span>
          <b>${Math.round(r.roi).toLocaleString()}×</b></div></td>
        <td class="num">${r.outcomes ? r.outcomes.toLocaleString() : '—'}</td>
        <td class="num">${r.roi ? `1 in ${Math.round(r.roi).toLocaleString()} <span class="muted tiny">(${pct(r.breakeven)})</span>` : '—'}</td>
      </tr>`).join('')}</tbody>`;
  $('#exoticEdit').textContent = exoticEditing ? 'Done' : 'Edit numbers';
}

// Same column again flips the order; a new column starts ascending
$('#exoticTable').addEventListener('click', e => {
  const b = e.target.closest('[data-sort]');
  if (!b) return;
  exoticSort = { key: b.dataset.sort, dir: exoticSort.key === b.dataset.sort ? -exoticSort.dir : 1 };
  renderExoticTable();
});

// What each bet is: on hover, or on focus (tapping on a phone, Tab on a keyboard)
const showAbout = e => {
  const el = e.target.closest('[data-about]');
  if (!el) return;
  const d = EXOTIC_INFO.find(x => x.name === el.dataset.about);
  const r = el.getBoundingClientRect();
  showTip(`<b>${esc(d.name)} <span class="kind-tag ${d.kind}">${d.kind === 'vertical' ? 'Vertical' : 'Horizontal'}</span></b>${esc(d.about)}`,
    r.left + r.width / 2, r.top);
};
const hideAbout = e => { if (e.target.closest('[data-about]')) hideTip(); };
$('#exoticTable').addEventListener('mouseover', showAbout);
$('#exoticTable').addEventListener('focusin', showAbout);
$('#exoticTable').addEventListener('mouseout', hideAbout);
$('#exoticTable').addEventListener('focusout', hideAbout);

$('#exoticTable').addEventListener('change', e => {
  const inp = e.target.closest('[data-exotic]');
  if (!inp) return;
  const info = { ...(state.exoticInfo || {}) };
  info[inp.dataset.exotic] = { ...info[inp.dataset.exotic], [inp.dataset.field]: Math.max(0, num(inp.value)) };
  state.exoticInfo = info;
  save();
  renderExoticTable();
});

$('#exoticField').addEventListener('change', e => {
  state.exoticField = num(e.target.value);
  save();
  renderExoticTable();
});

$('#exoticEdit').addEventListener('click', () => { exoticEditing = !exoticEditing; renderExoticTable(); });

$('#exoticReset').addEventListener('click', async () => {
  if (!await confirmModal('Reset exotic wager numbers?', 'Restores the ballpark min bets and average payouts.', 'Reset')) return;
  state.exoticInfo = {};
  save();
  renderExoticTable();
});

/* =========================================================
   History
   ========================================================= */

// Program numbers show as "#5" (or "#1A" for coupled entries); older bets saved a horse's name
function horseLabel(h) { return /^\d+[A-Z]?$/i.test(String(h).trim()) ? '#' + String(h).trim().toUpperCase() : h; }

// This mode's bets only: Win / Place / Show in Basic, exotic wagers in Exotic
function historyRows() {
  const track = $('#histTrack').value, type = $('#histType').value, result = $('#histResult').value;
  const from = $('#histFrom').value, to = $('#histTo').value;
  return modeBets()
    .filter(b => (!track || b.track === track) && (!type || b.type === type) && (!result || b.status === result) && (!from || b.date >= from) && (!to || b.date <= to))
    .sort((a, b) => a.date.localeCompare(b.date) || num(a.race) - num(b.race) || (a.settledAt || '').localeCompare(b.settledAt || ''));
}

function renderHistory() {
  const rows = historyRows();
  let running = 0;
  const withRunning = rows.map(b => { running += profitOf(b); return { b, running }; });
  const net = running;
  const decided = rows.filter(b => b.status === 'won' || b.status === 'lost');
  const wins = decided.filter(b => b.status === 'won');
  const staked = decided.reduce((s, b) => s + num(b.stake), 0);
  const best = wins.reduce((m, b) => Math.max(m, profitOf(b)), 0);

  $('#histStats').innerHTML = `
    <div class="stat accent"><div class="label">Net P/L</div><div class="value ${plClass(net)}">${money(net, true)}</div>
      <div class="sub">ROI ${staked ? (net / staked * 100).toFixed(1) : '0.0'}%</div></div>
    <div class="stat"><div class="label">Bets</div><div class="value">${rows.length}</div>
      <div class="sub">${money(staked)} staked</div></div>
    <div class="stat"><div class="label">Won / Lost</div><div class="value"><span class="profit">${wins.length}</span> / <span class="loss">${decided.length - wins.length}</span></div>
      <div class="sub">${decided.length ? (wins.length / decided.length * 100).toFixed(0) + '% hit rate' : '—'}</div></div>
    <div class="stat"><div class="label">Best win</div><div class="value ${plClass(best)}">${money(best, true)}</div></div>`;

  // Exotic mode: what actually came in, for bets you lost (pick or change it any time)
  const winnersCell = b => {
    if (!isExotic()) return '';
    const info = betInfo(b.type);
    if (b.status !== 'lost' || !info) return '<td class="muted">—</td>';
    return `<td><button type="button" class="winners-btn" data-hist-winners="${b.id}"
      title="${b.winners && b.winners.length ? 'Change' : 'Add'} the horses that actually finished">${winnersHTML(b.winners, info) || '+ Add'}</button></td>`;
  };
  // Exotic picks show as saddle cloths, to line up with the actual winners; anything else as typed
  const horseCell = b => {
    const info = betInfo(b.type), picks = picksOf(b.horse);
    return info && picks.length && picks.every(n => Number.isInteger(n) && n > 0)
      ? `<span class="pick-cloths">${winnersHTML(picks, info)}</span>` : esc(horseLabel(b.horse));
  };
  const body = withRunning.reverse().map(({ b, running }) => {
    const p = profitOf(b);
    return `
      <tr>
        <td>${fmtDate(b.date)}</td><td>${esc(b.track)}</td><td>R${esc(b.race)}</td>
        <td>${horseCell(b)}</td><td>${esc(b.type)}</td>
        <td><span class="badge ${b.status}">${b.status === 'open' ? 'PENDING' : b.status.toUpperCase()}</span></td>
        ${winnersCell(b)}
        <td class="num">${money(num(b.stake))}</td>
        <td class="num">${b.status === 'won' ? money(num(b.payout)) : '—'}</td>
        <td class="num ${plClass(p)}">${money(p, true)}</td>
        <td class="num ${plClass(running)}">${money(running, true)}</td>
        <td><div class="row-actions">${b.status === 'open' ? `
          <button class="btn tiny-btn" data-settle="won" data-id="${b.id}">Won</button>
          <button class="btn tiny-btn" data-settle="lost" data-id="${b.id}">Lost</button>
          <button class="btn tiny-btn ghost" data-settle="scratched" data-id="${b.id}">Scratch</button>`
          : `<button class="btn tiny-btn ghost" data-reopen="${b.id}" title="Clear the result so you can set it again">Change result</button>`}
          <button class="btn tiny-btn ghost danger" data-delete="${b.id}" title="Delete">✕</button>
        </div></td>
      </tr>`;
  }).join('');

  $('#histTable').innerHTML = `
    <thead><tr><th>Date</th><th>Track</th><th>Race</th><th>Horse #</th><th>Type</th><th>Result</th>${isExotic() ? '<th>Actual winners</th>' : ''}
      <th class="num">Stake</th><th class="num">Return</th><th class="num">P/L</th><th class="num">Running</th><th></th></tr></thead>
    <tbody>${body || `<tr><td colspan="${isExotic() ? 12 : 11}" class="empty">No ${isExotic() ? 'exotic' : 'Win / Place / Show'} bets here yet. Log one from the Tracker.</td></tr>`}</tbody>`;
}

['#histTrack', '#histType', '#histResult', '#histFrom', '#histTo'].forEach(id => $(id).addEventListener('change', renderHistory));

$('#histTable').addEventListener('click', async e => {
  const pick = e.target.closest('[data-hist-winners]');
  if (pick) {
    const bet = state.bets.find(b => b.id === pick.dataset.histWinners);
    return toggleNumPicker(pick, betInfo(bet.type), bet.winners, num(bet.race), seq => {
      if (seq.join() === (bet.winners || []).join()) return;
      if (seq.length) bet.winners = seq; else delete bet.winners;
      save();
      renderHistory();
    });
  }
  const del = e.target.closest('[data-delete]');
  if (del) {
    if (!await confirmModal('Delete bet?', 'This removes it permanently.', 'Delete', true)) return;
    state.bets = state.bets.filter(b => b.id !== del.dataset.delete);
    save(); renderHistory(); renderTracker(); renderMatrix();
    return;
  }
  const settle = e.target.closest('[data-settle]');
  if (settle) {
    const bet = state.bets.find(b => b.id === settle.dataset.id);
    if (settle.dataset.settle === 'won') return openWonModal(bet);
    return settleBet(bet, settle.dataset.settle, 0);
  }
  const btn = e.target.closest('[data-reopen]');
  if (!btn) return;
  const bet = state.bets.find(b => b.id === btn.dataset.reopen);
  bet.status = 'open';
  bet.payout = 0;
  delete bet.settledAt;
  save(); renderHistory(); renderTracker(); renderMatrix();
  toast('Result cleared — set it again with Won, Lost or Scratch');
});

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$('#exportCsv').addEventListener('click', () => {
  const cols = ['date', 'track', 'race', 'horse', 'type', 'stake', 'status', 'payout', 'profit', ...(isExotic() ? ['winners'] : [])];
  const cell = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;
  // Winners read like the Horse # column: 4-7-1, or 4/7/1 for a Pick bet
  const value = (b, c) => c === 'profit' ? profitOf(b).toFixed(2)
    : c === 'winners' ? (b.winners || []).join(betInfo(b.type) && betInfo(b.type).kind === 'horizontal' ? '/' : '-')
    : b[c] ?? '';
  // This mode's bets, like the History table
  const lines = modeBets().map(b => cols.map(c => cell(value(b, c))).join(','));
  download(`mejiro-${isExotic() ? 'exotic' : 'basic'}-bets-${today()}.csv`, [cols.join(','), ...lines].join('\n'), 'text/csv');
});

/* =========================================================
   Settings
   ========================================================= */

function renderSettings() {
  const f = $('#settingsForm');
  Object.entries(state.settings).forEach(([k, v]) => { if (f[k]) f[k].value = v; });
}

$('#settingsForm').addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target;
  state.settings = {
    ...state.settings,
    startingBankroll: num(f.startingBankroll.value),
    roundTo: num(f.roundTo.value),
  };
  save(); renderAll();
  toast('Settings saved');
});

$('#backupBtn').addEventListener('click', () => {
  download(`mejiro-backup-${today()}.json`, JSON.stringify(state, null, 2), 'application/json');
});

$('#restoreInput').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.bets)) throw new Error('not a Mejiro backup');
    if (!await confirmModal('Restore backup?', 'This replaces all current data with the backup.', 'Restore', true)) return;
    const user = state.user;
    state = { ...freshState(), ...data, settings: { ...DEFAULT_SETTINGS, ...data.settings }, user };
    save(); renderAll();
    toast('Backup restored');
  } catch (err) {
    toast('Could not restore: ' + err.message);
  }
});

$('#resetAllBtn').addEventListener('click', async () => {
  if (!await confirmModal('Reset everything?', 'Deletes all bets, tiers and settings from your account. Export a backup first if you want to keep them.', 'Reset all', true)) return;
  const user = state.user;
  state = { ...freshState(), user };
  save(); renderAll(); resetBetForm();
  toast('All data reset');
});

$('#signOutBtn').addEventListener('click', signOut);

/* ---------- Boot ---------- */

resetBetForm();
takeCaptureFromAddress();
initFirebase();
