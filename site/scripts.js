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

// The Calendar opens on the first of these (Emerald Downs, Keeneland, Los Alamitos) until you pick a track
const HOME_TRACKS = ['EMD', 'KEE', 'LRC'];

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
    calTrack: null,
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
   users/{uid}               the PREF_KEYS below
   users/{uid}/bets/{betId}  one document per bet
   save() is called after every change; it writes only what differs from the last sync. */

const PREF_KEYS = ['settings', 'matrix', 'calTrack', 'calHideInactive', 'calHideNoDays', 'wrRange', 'todayTz'];

let fb = null;  // { auth, db } once Firebase is set up
let synced = { prefs: '', bets: new Map() };  // last known Firestore copy (bet id → JSON)
let saveTimer = null;

const userDoc = () => fb.db.collection('users').doc(state.user.uid);
const prefsOf = s => Object.fromEntries(PREF_KEYS.filter(k => s[k] !== undefined).map(k => [k, s[k]]));
const snapshot = () => ({
  prefs: JSON.stringify(prefsOf(state)),
  bets: new Map(state.bets.map(b => [b.id, JSON.stringify(b)])),
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
  const [doc, bets] = await Promise.all([ref.get(), ref.collection('bets').get()]);
  state = freshState();
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
      synced = { prefs: '', bets: new Map() };
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
  renderCalendarTab();
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
  bet.innerHTML = '<option value="">Select track…</option>' + trackOptions(withRaceDays(activeTracks()));
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

/* ----- Racing today (from the Calendar data) ----- */

const TZ_CHOICES = [['local', 'My time'], ['America/New_York', 'Eastern'], ['America/Chicago', 'Central'],
  ['America/Denver', 'Mountain'], ['America/Phoenix', 'Arizona'], ['America/Los_Angeles', 'Pacific']];
const CARD_HOURS = 5;  // a card usually runs about this long after first post; "LIVE" until then

// A date + wall-clock time at the track, as an absolute moment (handles daylight saving)
const tzFormatters = {};
function zonedTime(date, time, tz) {
  const [y, m, d] = date.split('-').map(Number), [hh, mm] = time.split(':').map(Number);
  if (!tz) return new Date(y, m - 1, d, hh, mm);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const fmt = tzFormatters[tz] || (tzFormatters[tz] = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  }));
  const p = Object.fromEntries(fmt.formatToParts(new Date(guess)).map(x => [x.type, +x.value]));
  return new Date(guess - (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - guess));
}

function renderToday() {
  const t = today();
  const active = new Set(activeTracks().map(x => x.code));
  // One entry per track: its earliest card today (a mixed track can run two breeds)
  const byTrack = new Map();
  CAL.race_days.forEach(d => {
    if (d.race_date !== t || d.status === 'cancelled' || !active.has(d.track_code)) return;
    const cur = byTrack.get(d.track_code);
    if (!cur || (d.first_post_local && (!cur.first_post_local || d.first_post_local < cur.first_post_local))) byTrack.set(d.track_code, d);
  });
  const now = Date.now();
  const tz = TZ_CHOICES.some(([k]) => k === state.todayTz) ? state.todayTz : 'local';
  const races = [...byTrack.values()].map(d => {
    const post = d.first_post_local ? zonedTime(t, d.first_post_local, d.timezone) : null;
    return { ...d, post, live: post && now >= post && now < post.getTime() + CARD_HOURS * 3600000 };
  }).sort((a, b) => (b.live - a.live) || ((a.post || Infinity) - (b.post || Infinity)) || a.track_name.localeCompare(b.track_name));
  const anyTimes = races.some(r => r.post);

  const time = r => r.live ? '<span class="badge live">LIVE</span>'
    : r.post ? r.post.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', ...(tz === 'local' ? {} : { timeZone: tz }) })
    : '<span class="muted">Time TBA</span>';

  $('#todayCard').innerHTML = `
    <div class="card-head">
      <h3>Racing today <span class="muted small-text">${parseDate(t).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span></h3>
      ${anyTimes ? `<select id="todayTz" class="tz-select" aria-label="Time zone">${TZ_CHOICES.map(([k, label]) =>
        `<option value="${k}" ${k === tz ? 'selected' : ''}>${label}</option>`).join('')}</select>` : ''}
    </div>
    <div class="today-list">${races.map(r => `
      <button type="button" class="today-item" data-code="${esc(r.track_code)}" title="Open in Calendar">
        <span><span class="name">${esc(r.track_name)}</span><span class="muted tiny"> ${esc(r.state)} · ${esc(r.breed)}</span></span>
        <span class="time">${time(r)}</span>
      </button>`).join('') || '<p class="muted small-text">No racing at active tracks today.</p>'}</div>`;
}

$('#todayCard').addEventListener('change', e => {
  if (e.target.id !== 'todayTz') return;
  state.todayTz = e.target.value;
  save();
  renderToday();
});

$('#todayCard').addEventListener('click', e => {
  const item = e.target.closest('[data-code]');
  if (!item) return;
  state.calTrack = item.dataset.code;
  save();
  goTab('calendar');
  renderCalendarTab();
});

// Keep LIVE badges and the date current while the page stays open
setInterval(() => { if (state.user) renderToday(); }, 60000);

function renderTracker() {
  renderWinRate();
  renderToday();
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
   Calendar — one racetrack at a time, from calendar-data.js
   (generated by the calendar folder; run its Sync Calendar.bat to refresh)
   ========================================================= */

const CAL = window.MEJIRO_CALENDAR || { tracks: [], meets: [], race_days: [], events: [] };

const DAY_STATUS = {
  confirmed: 'Confirmed (seen on a race card)',
  scheduled: 'Scheduled (official date)',
  estimated: 'Estimated (from the meet’s weekly pattern)',
  cancelled: 'Cancelled',
};
const PRECISION = { exact: 'Exact dates', pattern: 'Weekly pattern', range_only: 'Season only' };

const calDaysByTrack = new Map();
CAL.race_days.forEach(d => {
  if (!calDaysByTrack.has(d.track_code)) calDaysByTrack.set(d.track_code, []);
  calDaysByTrack.get(d.track_code).push(d);
});

function parseDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function shortDate(iso) { return parseDate(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }

// "13:50" → "1:50 PM"
function fmtPost(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// When a day has several cards (e.g. Thoroughbred + Quarter Horse), show the surest status
function dayStatus(list) {
  return ['confirmed', 'scheduled', 'estimated', 'cancelled'].find(s => list.some(d => d.status === s));
}

const activeTracks = () => CAL.tracks.filter(t => t.status === 'active');

// "Hide tracks without race days" (a Calendar checkbox, on by default) also trims the Tracker's list.
// Tracks without race days are mostly harness tracks that only publish season dates.
const hideNoDays = () => state.calHideNoDays !== false;
const withRaceDays = tracks => hideNoDays() ? tracks.filter(t => calDaysByTrack.has(t.code)) : tracks;

// <option>s grouped by state; `notes` adds "(closed)" / "(no race days)" hints for the Calendar
function trackOptions(tracks, notes = false) {
  const byState = new Map();
  tracks.forEach(t => {
    if (!byState.has(t.state)) byState.set(t.state, []);
    byState.get(t.state).push(t);
  });
  const hint = t => !notes ? '' : t.status !== 'active' ? ` (${t.status})` : calDaysByTrack.has(t.code) ? '' : ' (no race days)';
  return [...byState.keys()].sort().map(st => `<optgroup label="${esc(st)}">${byState.get(st)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(t => `<option value="${esc(t.code)}">${esc(t.name)}${hint(t)}</option>`)
    .join('')}</optgroup>`).join('');
}

// Last pick, else the first home track in the list, else the first track
function calSelectedCode(tracks) {
  const known = code => tracks.some(t => t.code === code);
  if (known(state.calTrack)) return state.calTrack;
  return HOME_TRACKS.find(known) || tracks[0]?.code;
}

// The current month and the 11 after it
function calMonths() {
  const now = new Date();
  return Array.from({ length: 12 }, (_, i) => new Date(now.getFullYear(), now.getMonth() + i, 1));
}

let calView = { byDate: new Map(), ranges: [] };

function renderCalendarTab() {
  if (!CAL.tracks.length) {
    $('#calGrid').innerHTML = `<div class="card"><p class="empty">No calendar data found. Run <b>calendar\\Sync Calendar.bat</b> to create <code>calendar-data.js</code>, then reload.</p></div>`;
    return;
  }
  const hideInactive = state.calHideInactive !== false;
  $('#calHideInactive').checked = hideInactive;
  $('#calHideNoDays').checked = hideNoDays();
  const tracks = withRaceDays(hideInactive ? activeTracks() : CAL.tracks);
  const sel = $('#calTrack');
  sel.innerHTML = trackOptions(tracks, true);
  const code = calSelectedCode(tracks);
  sel.value = code;
  const track = CAL.tracks.find(t => t.code === code);

  const months = calMonths();
  const first = localISO(months[0]);
  const last = localISO(new Date(months[11].getFullYear(), months[11].getMonth() + 1, 0));
  const t = today();

  const days = (calDaysByTrack.get(code) || []).filter(d => d.race_date >= first && d.race_date <= last);
  const byDate = new Map();
  days.forEach(d => byDate.set(d.race_date, [...(byDate.get(d.race_date) || []), d]));
  const meets = CAL.meets.filter(m => m.track_code === code && m.end_date >= first && m.start_date <= last);
  const ranges = meets.filter(m => m.date_precision === 'range_only');
  calView = { byDate, ranges };
  // Past the end of the track's last known meet, an empty month means "not announced", not "no racing"
  const lastKnown = CAL.meets.filter(m => m.track_code === code).reduce((max, m) => m.end_date > max ? m.end_date : max, '');

  const statuses = [...new Set(days.map(d => d.status))];
  $('#calLegend').innerHTML = ['confirmed', 'scheduled', 'estimated', 'cancelled'].filter(s => statuses.includes(s))
    .map(s => `<span><i class="swatch s-${s}"></i>${DAY_STATUS[s].split(' (')[0]}</span>`).join('')
    + (days.some(d => d.featured_event) ? '<span><i class="swatch featured"></i>Featured race</span>' : '')
    + (ranges.length ? '<span><i class="swatch range"></i>Season (nights not published)</span>' : '');

  // Track summary
  const upcoming = days.filter(d => d.race_date >= t && d.status !== 'cancelled');
  const next = upcoming[0];
  const current = meets.find(m => m.start_date <= t && m.end_date >= t);
  const raceDayCount = new Set(days.filter(d => d.status !== 'cancelled').map(d => d.race_date)).size;
  let note = '';
  if (!days.length && ranges.length) note = 'This track publishes season dates but not individual race nights. The shaded days show the season.';
  else if (!days.length) note = 'No race dates on file for the next 12 months.';
  $('#calTrackInfo').innerHTML = `
    <div class="card track-card">
      <div>
        <h3>${esc(track.name)}</h3>
        <p class="muted small-text">${esc([track.city, track.state].filter(Boolean).join(', '))} · ${esc(track.track_type)} · ${esc(track.breeds.split(',').join(', '))}
          ${track.website ? ` · <a href="${esc(track.website)}" target="_blank" rel="noopener">Website ↗</a>` : ''}</p>
        ${note ? `<p class="small-text">${note}</p>` : ''}
      </div>
      <div class="track-facts">
        <div><span class="label">Next race day</span><b>${next ? shortDate(next.race_date) : '—'}</b>
          <small>${next ? [next.first_post_local && 'First post ' + fmtPost(next.first_post_local), next.featured_event].filter(Boolean).map(esc).join(' · ') : ''}</small></div>
        <div><span class="label">Current meet</span><b>${current ? esc(current.meet_name) : 'Off-season'}</b></div>
        <div><span class="label">Race days (12 mo)</span><b>${raceDayCount}</b></div>
      </div>
    </div>`;

  $('#calGrid').innerHTML = months.map(first => {
    const y = first.getFullYear(), m = first.getMonth();
    const total = new Date(y, m + 1, 0).getDate();
    let cells = ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(d => `<span class="dow">${d}</span>`).join('');
    cells += '<span></span>'.repeat(first.getDay());
    let count = 0;
    for (let d = 1; d <= total; d++) {
      const iso = localISO(new Date(y, m, d));
      const list = byDate.get(iso) || [];
      const cls = ['day'];
      if (list.length) {
        const s = dayStatus(list);
        cls.push('race', 's-' + s);
        if (s !== 'cancelled') count++;
        if (list.some(x => x.featured_event)) cls.push('featured');
      } else if (ranges.some(r => iso >= r.start_date && iso <= r.end_date)) cls.push('range');
      if (iso < t) cls.push('past');
      if (iso === t) cls.push('today');
      cells += `<span class="${cls.join(' ')}" data-date="${iso}">${d}</span>`;
    }
    const unknown = !count && localISO(first) > lastKnown;
    return `
      <div class="month ${count ? '' : 'off'}">
        <h4>${first.toLocaleDateString('en-US', { month: 'long' })} <span class="year">${y}</span>
          <span class="muted tiny">${count ? `${count} race day${count === 1 ? '' : 's'}` : unknown ? 'Dates TBA' : 'No racing'}</span></h4>
        <div class="month-grid">${cells}</div>
      </div>`;
  }).join('');

  $('#meetTable').innerHTML = `
    <thead><tr><th>Meet</th><th>Breed</th><th>Dates</th><th class="num">Race days</th><th>Dates are</th><th>Status</th><th></th></tr></thead>
    <tbody>${meets.map(mt => `
      <tr>
        <td>${esc(mt.meet_name)}</td>
        <td>${esc(mt.breed)}</td>
        <td>${shortDate(mt.start_date)} – ${shortDate(mt.end_date)}</td>
        <td class="num">${mt.date_precision === 'range_only' ? '—' : mt.calendar_days}${mt.planned_days && mt.planned_days !== mt.calendar_days ? ` <span class="muted tiny">of ${mt.planned_days}</span>` : ''}</td>
        <td>${PRECISION[mt.date_precision] || esc(mt.date_precision)}</td>
        <td><span class="badge ${mt.status === 'cancelled' || mt.status === 'ended_early' ? 'lost' : mt.status === 'tentative' ? 'demo' : 'clean'}">${esc(mt.status.replace('_', ' ').toUpperCase())}</span></td>
        <td>${mt.source_url ? `<a href="${esc(mt.source_url)}" target="_blank" rel="noopener">${esc(mt.source_name || 'Source')} ↗</a>` : ''}</td>
      </tr>`).join('') || '<tr><td colspan="7" class="empty">No meets in the next 12 months.</td></tr>'}</tbody>`;

  $('#calSource').textContent = CAL.generated_at
    ? `Calendar data generated ${new Date(CAL.generated_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}. Run Sync Calendar.bat to refresh it.`
    : '';
}

$('#calTrack').addEventListener('change', e => {
  state.calTrack = e.target.value;
  save();
  renderCalendarTab();
});

$('#calHideInactive').addEventListener('change', e => {
  state.calHideInactive = e.target.checked;
  save();
  renderCalendarTab();
});

$('#calHideNoDays').addEventListener('change', e => {
  state.calHideNoDays = e.target.checked;
  save();
  renderCalendarTab();
  renderTrackSelects();
});

$('#calGrid').addEventListener('mouseover', e => {
  const cell = e.target.closest('.day.race, .day.range');
  if (!cell) return hideTip();
  const iso = cell.dataset.date;
  const list = calView.byDate.get(iso) || [];
  const lines = list.length
    ? list.map(d => `<b>${esc(d.meet_name || d.breed)}</b>${esc(d.breed)} · ${DAY_STATUS[d.status] || esc(d.status)}`
        + (d.first_post_local ? ` · first post ${fmtPost(d.first_post_local)}` : '')
        + (d.featured_event ? `<br>★ ${esc(d.featured_event)}` : ''))
    : calView.ranges.filter(r => iso >= r.start_date && iso <= r.end_date)
        .map(r => `<b>${esc(r.meet_name)}</b>In season, but race nights aren't published`);
  const r = cell.getBoundingClientRect();
  showTip(`<span class="muted">${shortDate(iso)}</span><br>` + lines.join('<br>'), r.left + r.width / 2, r.top);
});
$('#calGrid').addEventListener('mouseleave', hideTip);

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
initFirebase();
