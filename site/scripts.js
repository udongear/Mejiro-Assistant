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
    bets: [],
    strategies: [],  // { id, text }, in display order
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

const PREF_KEYS = ['settings', 'matrix', 'wrRange', 'strategies', 'wpsShown'];

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

function openModal(html, { bare = false } = {}) {
  $('#modalBody').onclick = null;
  $('#modalBody').innerHTML = html;
  $('.modal-card').classList.toggle('bare', bare);
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

function renderAll() {
  renderUser();
  renderTrackSelects();
  renderTracker();
  renderRaces();
  renderStrategies();
  renderMatrix();
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
  // Log bets: the Calendar's active tracks, by code
  const bet = $('#betForm').track, bv = bet.value;
  bet.innerHTML = '<option value="">Select track…</option>' + trackOptions(activeTracks().filter(t => tracksWithRaceDays.has(t.code)));
  bet.value = bv;

  // History filters by the tracks you've actually bet on
  const hist = $('#histTrack'), hv = hist.value;
  hist.innerHTML = '<option value="">All tracks</option>'
    + [...new Set(state.bets.map(b => b.track))].sort().map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  hist.value = hv;
}

/* =========================================================
   Tracker
   ========================================================= */

const WR_RANGES = [['all', 'All-time'], ['90', '90 days'], ['30', '30 days'], ['7', '7 days'], ['1', 'Today']];

// Win rate = won ÷ (won + lost), by bet date; scratches and pending bets don't count
function renderWinRate() {
  const range = WR_RANGES.some(([k]) => k === state.wrRange) ? state.wrRange : 'all';
  let from = '';
  if (range !== 'all') {
    const d = new Date();
    d.setDate(d.getDate() - (num(range) - 1));
    from = localISO(d);
  }
  const bets = state.bets.filter(b => !from || b.date >= from);
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

$('#winRate').addEventListener('click', e => {
  const b = e.target.closest('[data-range]');
  if (!b) return;
  state.wrRange = b.dataset.range;
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

const BET_TYPES = [['Win', '1st'], ['Place', '1st–2nd'], ['Show', '1st–3rd']];

// Rows start blank; only the Database tab's "Log bet" passes values in
function betRowHTML(prev = {}) {
  return `
    <tr>
      <td><input type="number" name="race" min="1" max="20" required class="w-xs" value="${esc(prev.race || '')}"></td>
      <td><input type="text" name="horse" required inputmode="numeric" placeholder="#" class="w-xs" value="${esc(prev.horse || '')}"></td>
      <td><select name="type" required><option value="">Select…</option>${BET_TYPES.map(([t, places]) =>
        `<option value="${t}" ${prev.type === t ? 'selected' : ''}>${t} (${places})</option>`).join('')}</select></td>
      <td><input type="number" name="stake" min="0" step="0.01" required class="w-sm" value="${esc(prev.stake ?? '')}"></td>
      <td><select name="result" required>
        <option value="">Select…</option><option value="won">Won</option><option value="lost">Lost</option><option value="scratched">Scratched</option>
      </select></td>
      <td><input type="number" name="payout" min="0" step="0.01" required placeholder="Incl. stake" class="w-sm"></td>
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

function updateBetRows() {
  const rows = $$('#betRows tr');
  rows.forEach(syncPayout);
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

$('#betRows').addEventListener('change', e => {
  if (e.target.name === 'result') syncPayout(e.target.closest('tr'));
});

$('#betRows').addEventListener('click', e => {
  const btn = e.target.closest('[data-remove-row]');
  if (!btn || $$('#betRows tr').length === 1) return;
  btn.closest('tr').remove();
  updateBetRows();
});

$('#betForm').addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target;
  const track = CAL.tracks.find(t => t.code === f.track.value);
  const logged = $$('#betRows tr').map(tr => {
    const v = n => tr.querySelector(`[name=${n}]`);
    const status = v('result').value;
    return {
      id: uid(),
      date: f.date.value,
      track: track ? track.name : f.track.value,
      trackCode: f.track.value,
      race: v('race').value,
      horse: v('horse').value.trim(),
      type: v('type').value,
      stake: num(v('stake').value),
      status,
      payout: status === 'won' ? num(v('payout').value) : 0,
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
     { date, tracks: { KEY: { name, code, total, races: { "N": { capturedAt, entrants: [...] } } } } }
   KEY is the calendar's track code, or "TS-<name>" for a track the calendar doesn't list.
   ========================================================= */

const MAX_RACES = 15;
const WPS = [['win', 'WIN'], ['place', 'PLACE'], ['show', 'SHOW']];
let racesView = { date: null, key: null, race: 1 };
let cardsLoading = false;

// Active tracks with a race day today, A–Z
function todaysTracks() {
  const t = today();
  const active = new Set(activeTracks().map(x => x.code));
  const codes = new Set(CAL.race_days
    .filter(d => d.race_date === t && d.status !== 'cancelled' && active.has(d.track_code))
    .map(d => d.track_code));
  return CAL.tracks.filter(x => codes.has(x.code)).sort((a, b) => a.name.localeCompare(b.name));
}

// TwinSpires and the calendar name tracks differently ("FINGER LAKES" vs "Finger Lakes Gaming & Racetrack"),
// so compare without the generic words
const normTrack = s => String(s || '').toLowerCase()
  .replace(/race ?course|race ?track|raceway|racing|gaming|casino|resort|park|downs|the\b|[^a-z]/g, '');

function matchTrack(name) {
  const n = normTrack(name);
  if (n.length < 3) return null;
  const fits = t => { const m = normTrack(t.name); return m.length >= 3 && (m.includes(n) || n.includes(m)); };
  return todaysTracks().find(fits) || CAL.tracks.find(fits) || null;
}

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

// Left column: today's calendar tracks plus any captured track the calendar doesn't list; captured first
function racesTracks(date) {
  const captured = state.cards && state.cards.date === date ? state.cards.tracks : {};
  const list = todaysTracks().map(t => ({ key: t.code, name: t.name, state: t.state }));
  Object.entries(captured).forEach(([key, t]) => { if (!list.some(x => x.key === key)) list.push({ key, name: t.name, state: '' }); });
  return list.map(x => ({ ...x, card: captured[x.key] || null, youtube: (CAL.tracks.find(t => t.code === x.key) || {}).youtube }))
    .sort((a, b) => (!!b.card - !!a.card) || a.name.localeCompare(b.name));
}

// Links to the track's channel once calendar\data\tracks.csv has its "youtube" column filled in; greyed out until then
const YT_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="1" y="4" width="22" height="16" rx="5" fill="currentColor"/><path d="M10 8.5v7l6-3.5z" fill="#fff"/></svg>';
function youtubeIcon(url) {
  return url
    ? `<a class="yt-link" href="${esc(url)}" target="_blank" rel="noopener" title="YouTube channel" aria-label="YouTube channel">${YT_SVG}</a>`
    : `<span class="yt-link off" title="No YouTube channel added yet">${YT_SVG}</span>`;
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
    <p><b>Race ${race} isn't captured yet.</b></p>
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
  if (racesView.date !== t || !tracks.some(x => x.key === racesView.key)) racesView = { date: t, key: tracks[0]?.key || null, race: 1 };
  $('#racesDate').textContent = parseDate(t).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  $('#racesTracks').innerHTML = tracks.map(x => {
    const n = x.card ? Object.keys(x.card.races).length : 0;
    return `
      <div class="race-track-row ${x.key === racesView.key ? 'active' : ''}">
        <button type="button" class="race-track" data-key="${esc(x.key)}">
          <span class="name">${esc(x.name)}</span>
          <span class="muted tiny">${n ? `${n} race${n === 1 ? '' : 's'}` : esc(x.state)}</span>
        </button>
        ${youtubeIcon(x.youtube)}
      </div>`;
  }).join('') || '<p class="muted small-text">No racing at active tracks today.</p>';

  const track = tracks.find(x => x.key === racesView.key);
  if (!track) {
    $('#racesTitle').textContent = 'Entrants';
    $('#racePicker').innerHTML = '';
    $('#racesEntrants').innerHTML = $('#racesCalc').innerHTML = '<p class="muted small-text">Nothing to show today.</p>';
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

$('#racesTracks').addEventListener('click', e => {
  const b = e.target.closest('[data-key]');
  if (!b) return;
  racesView.key = b.dataset.key;
  racesView.race = 1;
  renderRaces();
});

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

// A capture is one race ({ race, entrants }) or, from "All races", a whole card ({ races: [{ race, entrants }] })
async function importCapture(c) {
  const int = v => Math.max(0, Math.floor(+v) || 0);
  const list = !c ? [] : Array.isArray(c.races) ? c.races : [{ race: c.race, entrants: c.entrants }];
  const races = list.filter(r => r && Array.isArray(r.entrants) && r.entrants.length && int(r.race) >= 1 && int(r.race) <= MAX_RACES);
  if (!c || !c.track || !races.length) return toast('That capture is missing its track, race number or horses.');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(c.date) ? c.date : today();
  await ensureCards(date);
  const match = matchTrack(c.track);
  const key = match ? match.code : 'TS-' + normTrack(c.track);
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
    name: match ? match.name : String(c.track).slice(0, 60),
    code: match ? match.code : null,
    total: int(c.total) || prev.total || null,
    races: { ...prev.races, ...cleaned },
  };
  save();
  const numbers = Object.keys(cleaned).map(Number).sort((a, b) => a - b);
  if (date === today()) racesView = { date, key, race: numbers[0] };
  goTab('races');
  renderRaces();
  const horses = Object.values(cleaned).flatMap(r => r.entrants);
  const missing = horses.filter(e => e.starts == null).length;
  toast(`Captured ${state.cards.tracks[key].name} ` + (numbers.length === 1 ? `race ${numbers[0]}` : `races ${numbers[0]}–${numbers[numbers.length - 1]}`) +
    `: ${horses.length} horses` + (missing ? `, ${missing} without a record` : '') + (date === today() ? '' : ` (saved under ${date})`));
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
$('#racesEntrants').addEventListener('click', e => { if (e.target.closest('[data-setup-capture]')) openCaptureSetup(); });

// Every captured day in one CSV: one row per horse
$('#exportCards').addEventListener('click', async () => {
  await flushSave();
  let days = state.cards ? [state.cards] : [];
  if (fb && state.user) {
    try { days = (await userDoc().collection('racecards').get()).docs.map(d => d.data()); }
    catch (err) { return toast("Couldn't load your captures: " + err.message); }
  }
  const cols = ['date', 'track', 'track_code', 'race', 'pp', 'horse', 'starts', 'wins', 'places', 'shows', 'scratched', 'captured_at'];
  const cell = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;
  const rows = [];
  days.sort((a, b) => a.date.localeCompare(b.date)).forEach(day =>
    Object.values(day.tracks || {}).sort((a, b) => a.name.localeCompare(b.name)).forEach(t =>
      Object.entries(t.races || {}).sort((a, b) => a[0] - b[0]).forEach(([n, r]) =>
        r.entrants.forEach(e => rows.push([day.date, t.name, t.code || '', n, e.pp, e.horse, e.starts ?? '', e.wins ?? '',
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
  const show = inner => { box.innerHTML = '<div style="font-weight:700;color:#C8B4FF;margin-bottom:6px">Mejiro Capture</div>' + inner; };
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

  /* Three parts: the runner list, an open LIFE panel if any, and the short texts near the top of the page */
  const outline = () => {
    const strip = root => {
      const copy = root.cloneNode(true);
      copy.querySelectorAll('script,style,svg,img,iframe,noscript,#mejiro-capture').forEach(n => n.remove());
      copy.querySelectorAll('*').forEach(n => [...n.attributes].forEach(a => {
        if (!['class', 'id', 'role', 'aria-label', 'aria-expanded', 'href'].includes(a.name) && !a.name.startsWith('data-')) n.removeAttribute(a.name);
      }));
      return copy.outerHTML;
    };
    const runners = findRunners();
    const anchor = runners ? runners[0].row : leaves().find(el => /^runner$/i.test(clean(el.textContent)));
    const life = leaves().find(el => /^life$/i.test(clean(el.textContent)));
    const top = leaves().filter(el => { const r = el.getBoundingClientRect(); return r.top < 320 && r.height > 0; })
      .map(el => `${el.tagName.toLowerCase()}.${typeof el.className === 'string' ? el.className.trim().replace(/\s+/g, '.') : ''}: ${clean(el.textContent)}`)
      .filter(t => !/:\s*$/.test(t)).slice(0, 120);
    return ['<!-- RUNNER LIST -->', anchor ? strip(up(anchor, 2) || anchor) : '(not found)',
      '<!-- LIFE PANEL -->', life ? strip(up(life, 8) || life) : '(no "LIFE" text on the page: open a horse\'s record by hand first)',
      '<!-- TOP OF PAGE -->', top.join('\n')].join('\n').slice(0, 150000);
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

  const done = (races, track, total) => {
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
      note(list) +
      `<a id="mc-send" href="#" target="mejiro" style="display:inline-block;margin:10px 6px 0 0;padding:8px 12px;border-radius:8px;` +
      `background:#7B61FF;color:#fff;font:600 13px system-ui;text-decoration:none">Send to Mejiro</a>` + button('mc-close', 'Close') +
      (found < all.length ? note('Records missing? Open one horse\'s record by hand (click its name), then copy the page outline and paste it to Claude.') + button('mc-copy', 'Copy page outline') : ''));
    box.querySelector('#mc-close').onclick = finish;
    copyButton();
    const send = box.querySelector('#mc-send');
    send.onclick = () => {
      const name = clean(box.querySelector('#mc-track').value);
      const raceField = box.querySelector('#mc-race');
      if (raceField) races[0].race = +raceField.value;
      if (!name || races.some(r => !(r.race >= 1 && r.race <= 15))) { alert('Enter the track and a race number from 1 to 15.'); return false; }
      const now = new Date(), date = new Date(now - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
      send.href = site + '#capture=' + encodeURIComponent(JSON.stringify(
        { v: 2, source: 'twinspires', date, track: name, total, capturedAt: now.toISOString(), races }));
      setTimeout(finish, 500);
    };
  };

  const first = findRunners();
  if (!first || !first.length) {
    show("Couldn't find the runners on this page. Open a race's <b>PROGRAM</b> tab and try again." +
      note('If it still fails, copy the page outline and paste it to Claude.') + button('mc-copy', 'Copy page outline', true) + button('mc-close', 'Close'));
    copyButton();
    box.querySelector('#mc-close').onclick = finish;
    return;
  }
  const track = trackName(), start = raceNow();
  show(`<div><b>${html(track) || 'This track'}</b>${start ? ` · Race ${start}` : ''}: ${first.length} runners.</div>` +
    button('mc-one', 'This race', true) + button('mc-all', 'All races') + button('mc-close', 'Close') +
    note('<b>All races</b> goes back to Race 1, then reads every race on the card (about a second per horse). Leave this tab open while it works.'));
  box.querySelector('#mc-close').onclick = finish;
  box.querySelector('#mc-one').onclick = async () => {
    const entrants = await readRace('');
    done([{ race: start, entrants: entrants || [] }], track, null);
  };
  box.querySelector('#mc-all').onclick = async () => {
    const races = [];
    let n = raceNow() || 1;
    while (n > 1) {
      show(`Going back to Race ${n - 1}…`);
      if (!await goTo(n - 1)) break;
      n = raceNow();
    }
    let total = null;
    while (races.length < 15) {
      const entrants = await readRace(`Race ${n}: `);
      if (entrants) races.push({ race: n, entrants });
      if (!raceButton(n + 1)) { total = n; break; }  /* no next-race button: this is the last race */
      show(`Opening Race ${n + 1}…`);
      if (!await goTo(n + 1)) break;
      n = raceNow();
      if (races.some(r => r.race === n)) break;
    }
    done(races, track, total);
  };
}

/* =========================================================
   Strategies — short notes, reordered by dragging the ☰ handle
   ========================================================= */

function renderStrategies() {
  $('#strategyList').innerHTML = (state.strategies || []).map(s => `
    <li class="strategy" data-id="${s.id}">
      <button type="button" class="drag-handle" title="Drag to reorder" aria-label="Drag to reorder">☰</button>
      <textarea rows="2" placeholder="Describe a strategy…">${esc(s.text)}</textarea>
      <button type="button" class="btn tiny-btn ghost danger" data-delete-strategy title="Delete">✕</button>
    </li>`).join('') || '<li class="empty">No strategies yet. Click <b>+ Add strategy</b> to write one.</li>';
}

const strategyById = id => state.strategies.find(s => s.id === id);

$('#addStrategy').addEventListener('click', () => {
  state.strategies = [...(state.strategies || []), { id: uid(), text: '' }];
  save();
  renderStrategies();
  $$('#strategyList textarea').pop().focus();
});

// Typing saves without re-rendering, so the cursor stays put
$('#strategyList').addEventListener('input', e => {
  if (e.target.tagName !== 'TEXTAREA') return;
  strategyById(e.target.closest('.strategy').dataset.id).text = e.target.value;
  save();
});

$('#strategyList').addEventListener('click', async e => {
  if (!e.target.closest('[data-delete-strategy]')) return;
  const s = strategyById(e.target.closest('.strategy').dataset.id);
  if (s.text.trim() && !await confirmModal('Delete strategy?', 'This removes it permanently.', 'Delete', true)) return;
  state.strategies = state.strategies.filter(x => x !== s);
  save();
  renderStrategies();
});

// Drag with pointer events (works with mouse and touch): the row follows the handle,
// and the list reorders as it passes other rows
$('#strategyList').addEventListener('pointerdown', e => {
  const handle = e.target.closest('.drag-handle');
  if (!handle) return;
  e.preventDefault();
  const row = handle.closest('.strategy');
  const list = $('#strategyList');
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
    const order = [...list.children].map(li => li.dataset.id);
    state.strategies = order.map(strategyById).filter(Boolean);
    save();
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', end, { once: true });
  handle.addEventListener('pointercancel', end, { once: true });
});

/* =========================================================
   Calendar data — calendar-data.js, generated by the calendar folder's Sync Calendar.bat.
   Today's Races uses it for which tracks race today and their YouTube links (the "youtube"
   column of calendar\data\tracks.csv); Log bets uses it for its track list.
   ========================================================= */

const CAL = window.MEJIRO_CALENDAR || { tracks: [], meets: [], race_days: [], events: [] };

function parseDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

const activeTracks = () => CAL.tracks.filter(t => t.status === 'active');

// Tracks with at least one race day on file (harness tracks that only publish season dates have none)
const tracksWithRaceDays = new Set(CAL.race_days.map(d => d.track_code));

// <option>s grouped by state
function trackOptions(tracks) {
  const byState = new Map();
  tracks.forEach(t => {
    if (!byState.has(t.state)) byState.set(t.state, []);
    byState.get(t.state).push(t);
  });
  return [...byState.keys()].sort().map(st => `<optgroup label="${esc(st)}">${byState.get(st)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(t => `<option value="${esc(t.code)}">${esc(t.name)}</option>`)
    .join('')}</optgroup>`).join('');
}

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

  $('#matrixTable').innerHTML = `
    <thead><tr><th>Portfolio size ($)</th><th>Risk %</th><th class="num">Stake at tier start</th><th></th></tr></thead>
    <tbody>${tiers.map((t, i) => `
      <tr class="${cur && t === cur ? 'current' : ''}">
        <td><input type="number" min="0" step="any" value="${t.size}" data-i="${i}" data-field="size"></td>
        <td><input type="number" min="0" max="100" step="any" value="${t.pct}" data-i="${i}" data-field="pct"></td>
        <td class="num">${money(t.size * t.pct / 100)}</td>
        <td><div class="row-actions"><button class="btn tiny-btn ghost danger" data-remove="${i}" title="Remove">✕</button></div></td>
      </tr>`).join('')}</tbody>`;
}

$('#matrixTable').addEventListener('change', e => {
  const inp = e.target.closest('input[data-i]');
  if (!inp) return;
  const tiers = sortedMatrix();
  tiers[+inp.dataset.i][inp.dataset.field] = num(inp.value);
  state.matrix = tiers;
  save(); renderMatrix(); renderTracker();
});

$('#matrixTable').addEventListener('click', e => {
  const btn = e.target.closest('[data-remove]');
  if (!btn) return;
  const tiers = sortedMatrix();
  tiers.splice(+btn.dataset.remove, 1);
  state.matrix = tiers;
  save(); renderMatrix(); renderTracker();
});

$('#matrixAdd').addEventListener('click', () => {
  const tiers = sortedMatrix();
  const last = tiers[tiers.length - 1];
  state.matrix.push({ size: last ? last.size * 2 : 2, pct: last ? last.pct : 100 });
  save(); renderMatrix();
});

$('#matrixReset').addEventListener('click', async () => {
  if (!await confirmModal('Reset risk matrix?', 'Restores the original 12 tiers.', 'Reset')) return;
  state.matrix = DEFAULT_MATRIX.map(t => ({ ...t }));
  save(); renderMatrix(); renderTracker();
});

/* =========================================================
   History
   ========================================================= */

// Program numbers show as "#5" (or "#1A" for coupled entries); older bets saved a horse's name
function horseLabel(h) { return /^\d+[A-Z]?$/i.test(String(h).trim()) ? '#' + String(h).trim().toUpperCase() : h; }

function historyRows() {
  const track = $('#histTrack').value, result = $('#histResult').value;
  const from = $('#histFrom').value, to = $('#histTo').value;
  return state.bets
    .filter(b => (!track || b.track === track) && (!result || b.status === result) && (!from || b.date >= from) && (!to || b.date <= to))
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

  const body = withRunning.reverse().map(({ b, running }) => {
    const p = profitOf(b);
    return `
      <tr>
        <td>${fmtDate(b.date)}</td><td>${esc(b.track)}</td><td>R${esc(b.race)}</td>
        <td>${esc(horseLabel(b.horse))}</td><td>${esc(b.type)}</td>
        <td><span class="badge ${b.status}">${b.status === 'open' ? 'PENDING' : b.status.toUpperCase()}</span></td>
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
    <thead><tr><th>Date</th><th>Track</th><th>Race</th><th>Horse #</th><th>Type</th><th>Result</th>
      <th class="num">Stake</th><th class="num">Return</th><th class="num">P/L</th><th class="num">Running</th><th></th></tr></thead>
    <tbody>${body || '<tr><td colspan="11" class="empty">No bets logged yet. Log one from the Tracker.</td></tr>'}</tbody>`;
}

['#histTrack', '#histResult', '#histFrom', '#histTo'].forEach(id => $(id).addEventListener('change', renderHistory));

$('#histTable').addEventListener('click', async e => {
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
  const cols = ['date', 'track', 'race', 'horse', 'type', 'stake', 'status', 'payout', 'profit'];
  const cell = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;
  const lines = state.bets.map(b => cols.map(c => cell(c === 'profit' ? profitOf(b).toFixed(2) : b[c] ?? '')).join(','));
  download(`mejiro-bets-${today()}.csv`, [cols.join(','), ...lines].join('\n'), 'text/csv');
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
