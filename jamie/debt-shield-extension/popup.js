// Debt Shield v2 — Popup Script

let appState = null;

// ── SCORE HELPERS ─────────────────────────────────────────────
function getScoreBand(score) {
  if (score >= 90) return { label: 'Excellent', color: '#00e5a0' };
  if (score >= 75) return { label: 'Good',      color: '#00e5a0' };
  if (score >= 60) return { label: 'Fair',       color: '#ffd166' };
  if (score >= 40) return { label: 'Caution',    color: '#ffd166' };
  return                   { label: 'At Risk',   color: '#ff4d6d' };
}

function formatSyncTime(ts) {
  if (!ts) return 'Never synced';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1)   return 'Just synced';
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)   return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ── INIT ──────────────────────────────────────────────────────
async function init() {
  const data = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  appState = data;

  // Pre-fill settings fields
  document.getElementById('setting-username').value = appState.settings.userName || '';
  document.getElementById('setting-apibase').value  = appState.settings.apiBase  || 'http://localhost:8000';

  renderAll();
  attachEvents();
}

// ── RENDER ────────────────────────────────────────────────────
function renderAll() {
  renderHeader();
  renderScore();
  renderOverview();
  renderSettings();
}

function renderHeader() {
  const { settings } = appState;
  const toggle = document.getElementById('header-toggle');
  const status = document.getElementById('brand-status');

  toggle.classList.toggle('on', settings.enabled);
  if (!settings.enabled) {
    status.textContent = '○ DISABLED';
    status.className = 'off';
  } else {
    status.textContent = '● PROTECTION ACTIVE';
    status.className = 'on';
  }
}

function renderScore() {
  const profile = appState.profile;
  const arcEl   = document.getElementById('score-arc-fill');
  const numEl   = document.getElementById('score-number');
  const bandEl  = document.getElementById('score-band-chip');
  const descEl  = document.getElementById('score-desc-text');
  const syncEl  = document.getElementById('score-last-sync');

  // Arc circumference for path M 8,50 A 37,37 0 0,1 82,50  → π*37 ≈ 116.2
  const ARC_LEN = 116;

  if (!profile || profile.score == null) {
    arcEl.setAttribute('stroke-dashoffset', ARC_LEN);
    arcEl.setAttribute('stroke', '#1e2d4a');
    numEl.textContent = '--';
    bandEl.textContent = '● --';
    bandEl.style.color = '#6b7a99';
    bandEl.style.background = 'transparent';
    bandEl.style.borderColor = '#1e2d4a';
    descEl.textContent = 'Set your name & API URL in Settings, then tap Sync.';
    syncEl.textContent = 'Never synced';
    return;
  }

  const score = profile.score;
  const band  = getScoreBand(score);
  const offset = ARC_LEN * (1 - score / 100);

  arcEl.setAttribute('stroke-dashoffset', offset.toFixed(1));
  arcEl.setAttribute('stroke', band.color);
  numEl.textContent     = score.toFixed(1);
  numEl.style.color     = band.color;
  bandEl.textContent    = `● ${band.label}`;
  bandEl.style.color    = band.color;
  bandEl.style.background = `${band.color}15`;
  bandEl.style.borderColor = `${band.color}50`;
  descEl.textContent    = getScoreDesc(score);
  syncEl.textContent    = formatSyncTime(profile.synced_at);
}

function getScoreDesc(score) {
  if (score >= 90) return 'Your finances are in great shape.';
  if (score >= 75) return 'You\'re managing your money well.';
  if (score >= 60) return 'Some risks present — worth monitoring.';
  if (score >= 40) return 'Financial pressure is building. Be cautious.';
  return 'High risk of a financial shortfall. Review your outgoings.';
}

function renderOverview() {
  const { settings, session, streak, profile } = appState;
  const c = settings.currency || '£';
  // Prefer the profile's actual monthly surplus (income - expenses) as the budget.
  // This replaces the hardcoded £500 with the user's real financial situation.
  const budget = profile?.monthly_net || settings.monthlyBudget || 500;
  const spent  = session.monthlySpend || 0;
  const pct    = budget > 0 ? Math.min(1, spent / budget) : 0;
  const left   = Math.max(0, budget - spent);

  const now = new Date();
  document.getElementById('budget-month').textContent =
    `${now.toLocaleString('default', { month: 'long' }).toUpperCase()} ${now.getFullYear()}`;

  document.getElementById('budget-spent-big').textContent = `${c}${spent.toFixed(0)}`;
  document.getElementById('budget-total-big').textContent = `${c}${budget.toFixed ? budget.toFixed(0) : budget}`;

  const fill = document.getElementById('budget-fill');
  fill.style.width = `${pct * 100}%`;
  fill.className = pct >= 1 ? 'critical' : pct >= 0.8 ? 'danger' : pct >= 0.6 ? 'warn' : '';

  document.getElementById('budget-pct-label').textContent  = `${Math.round(pct * 100)}% used`;
  document.getElementById('budget-left-label').textContent = `${c}${left.toFixed(0)} remaining`;

  document.getElementById('s-intercepted').textContent = session.interceptCount || 0;
  document.getElementById('s-proceeded').textContent   = session.proceededCount || 0;
  document.getElementById('s-session').textContent     = `${c}${(session.sessionSpend || 0).toFixed(0)}`;

  const cur  = streak?.current || 0;
  document.getElementById('streak-num').textContent   = cur;
  document.getElementById('streak-emoji').textContent =
    cur >= 7 ? '🏆' : cur >= 3 ? '🔥' : cur >= 1 ? '✨' : '🌱';

  const goal = settings.streakGoalDays || 7;
  const dots = document.getElementById('streak-dots');
  dots.innerHTML = Array.from({ length: Math.min(goal, 10) }, (_, i) =>
    `<div class="sdot${i < cur ? ' lit' : ''}"></div>`
  ).join('');
}

function renderSettings() {
  const { settings } = appState;
  const c = settings.currency || '£';

  document.getElementById('budget-val-display').textContent = `${c}${settings.monthlyBudget || 500}`;
  document.getElementById('budget-slider').value = settings.monthlyBudget || 500;

  const t = settings.warningThresholds || {};
  document.getElementById('tc-critical').textContent = `${c}${t.critical || 200}`;
  document.getElementById('tc-high').textContent     = `${c}${t.high    || 50}`;
  document.getElementById('tc-medium').textContent   = `${c}${t.medium  || 15}`;

  document.querySelectorAll('.currency-btn').forEach(btn => {
    const active = btn.dataset.c === (settings.currency || '£');
    btn.classList.toggle('active', active);
  });
}

// ── EVENTS ────────────────────────────────────────────────────
function attachEvents() {
  // Tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    });
  });

  // Master toggle
  document.getElementById('header-toggle').addEventListener('click', async () => {
    const enabled = !appState.settings.enabled;
    await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: { enabled } });
    appState.settings.enabled = enabled;
    renderAll();
    notifyTabs({ type: 'STATE_UPDATED' });
  });

  document.getElementById('q-dashboard').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
    window.close();
  });

  // Quick actions
  document.getElementById('q-scan').addEventListener('click', () => {
    notifyTabs({ type: 'MANUAL_SCAN' }); window.close();
  });
  document.getElementById('q-duck').addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    document.querySelector('[data-tab="duck"]').classList.add('active');
    document.getElementById('tab-duck').classList.add('active');
  });
  document.getElementById('q-hud').addEventListener('click', () => {
    notifyTabs({ type: 'TOGGLE_PANEL' }); window.close();
  });
  document.getElementById('q-reset').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'RESET_ALL' });
    const data = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    appState = data;
    renderAll();
    notifyTabs({ type: 'STATE_UPDATED' });
  });

  // Budget slider
  document.getElementById('budget-slider').addEventListener('input', async (e) => {
    const val = parseInt(e.target.value);
    const c   = appState.settings.currency || '£';
    document.getElementById('budget-val-display').textContent = `${c}${val}`;
    appState.settings.monthlyBudget = val;
    await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: { monthlyBudget: val } });
    renderOverview();
  });

  // Currency
  document.querySelectorAll('.currency-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const c = btn.dataset.c;
      appState.settings.currency = c;
      await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: { currency: c } });
      renderAll();
    });
  });

  // Profile fields — save on change, then auto-sync after a short debounce
  let autoSyncTimer = null;
  function scheduleAutoSync() {
    clearTimeout(autoSyncTimer);
    autoSyncTimer = setTimeout(() => {
      const nameVal = document.getElementById('setting-username').value.trim();
      if (nameVal) syncProfile('score-sync-mini-btn', 'sync-status');
    }, 1200);
  }

  document.getElementById('setting-username').addEventListener('change', async (e) => {
    const userName = e.target.value.trim();
    appState.settings.userName = userName;
    await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: { userName } });
    scheduleAutoSync();
  });
  document.getElementById('setting-apibase').addEventListener('change', async (e) => {
    const apiBase = e.target.value.trim() || 'http://localhost:8000';
    appState.settings.apiBase = apiBase;
    await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: { apiBase } });
    scheduleAutoSync();
  });

  // Sync button (settings)
  document.getElementById('sync-btn').addEventListener('click', () => syncProfile('sync-btn', 'sync-status'));

  // Sync button (overview card)
  document.getElementById('score-sync-mini-btn').addEventListener('click', () => syncProfile('score-sync-mini-btn', null));

  // Duck game
  initDuckGame();
}

async function syncProfile(btnId, statusId) {
  // Save current field values first
  const nameVal = document.getElementById('setting-username').value.trim();
  const apiVal  = document.getElementById('setting-apibase').value.trim() || 'http://localhost:8000';
  if (nameVal) {
    await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: { userName: nameVal, apiBase: apiVal } });
    appState.settings.userName = nameVal;
    appState.settings.apiBase  = apiVal;
  }

  const btn = document.getElementById(btnId);
  if (btn) { btn.disabled = true; btn.textContent = '⟳ Syncing...'; }
  if (statusId) {
    const s = document.getElementById(statusId);
    s.textContent = 'Syncing...'; s.className = '';
  }

  const result = await chrome.runtime.sendMessage({ type: 'SYNC_PROFILE' });

  if (btn) { btn.disabled = false; btn.textContent = btnId === 'sync-btn' ? '↻ Sync Score & Goals' : '↻ Sync'; }

  if (result.ok) {
    appState.profile = result.profile;
    renderScore();
    if (statusId) {
      const s = document.getElementById(statusId);
      s.textContent = '✓ Score updated'; s.className = 'ok';
      setTimeout(() => { s.textContent = ''; s.className = ''; }, 3000);
    }
  } else {
    const reason = result.reason === 'no_user' ? 'Enter your name above first.' : 'Could not reach API. Check URL.';
    if (statusId) {
      const s = document.getElementById(statusId);
      s.textContent = `✗ ${reason}`; s.className = 'err';
    }
  }
}

async function notifyTabs(msg) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, msg).catch(() => {});
}

// ── DUCK GAME ────────────────────────────────────────────────
function initDuckGame() {
  const WISDOMS = [
    "Quack. I hear you. The algorithm knew your weaknesses.",
    "That's a bold financial move. Or is it? Quack.",
    "Have you tried closing the tab? Works every time. Quack.",
    "The duck has seen things. Many shopping carts. Quack.",
    "Impulse buy? In THIS economy? Quack quack.",
    "Your future self is watching. They're disappointed. Quack.",
    "The duck does not judge. The duck simply quacks.",
    "Breathe. Close the tab. Drink water. Quack.",
    "That item will still be there tomorrow. Probably. Quack.",
    "The duck has absorbed your financial anxiety. You're welcome.",
    "Is it in your budget? Be honest with the duck. Quack.",
    "Squeeeeak. That's the sound of wisdom. Take it.",
    "The duck says: sleep on it. Quack.",
    "Every squeeze is a purchase not made. Quack. 💛",
    "You're doing great. Truly. Quack quack quack.",
    "The duck has heard worse. Much worse. Quack.",
    "Sir, this is a rubber duck. But also, same. Quack.",
    "Have you considered that you don't need it? Quack.",
    "That's the spirit. Squeeze it out. QUACK.",
    "Financial healing is a journey. The duck is with you. 🦆",
  ];
  const SQUEAK_WORDS = ['SQUEAK!', 'QUACK!', '🎵', '💛', '✨', 'eep!', '*honk*', 'SQUONK'];

  const startBtn        = document.getElementById('duck-start-btn');
  const intro           = document.getElementById('duck-intro');
  const active          = document.getElementById('duck-active');
  const duckBody        = document.getElementById('duck-body');
  const squeaksContainer = document.getElementById('duck-squeaks');
  const wisdomText      = document.getElementById('duck-wisdom-text');
  const squeakCountEl   = document.getElementById('duck-squeak-count');

  let squeaks = 0;
  let wisdomShuffled = [...WISDOMS].sort(() => Math.random() - 0.5);

  startBtn.addEventListener('click', () => { intro.style.display = 'none'; active.style.display = 'block'; });

  function getWisdom() {
    if (!wisdomShuffled.length) wisdomShuffled = [...WISDOMS].sort(() => Math.random() - 0.5);
    return wisdomShuffled.pop();
  }

  function spawnParticle() {
    const p = document.createElement('div');
    p.className = 'squeak-particle';
    p.textContent = SQUEAK_WORDS[Math.floor(Math.random() * SQUEAK_WORDS.length)];
    p.style.left = `${20 + Math.random() * 60}%`;
    p.style.top  = `${10 + Math.random() * 50}%`;
    squeaksContainer.appendChild(p);
    setTimeout(() => p.remove(), 900);
  }

  let squeezing = false;

  duckBody.addEventListener('mousedown', () => {
    if (squeezing) return;
    squeezing = true;
    duckBody.classList.add('squeezing'); duckBody.classList.remove('bounce');
  });

  function releaseDuck() {
    if (!squeezing) return;
    squeezing = false; squeaks++;
    squeakCountEl.textContent = squeaks;
    duckBody.classList.remove('squeezing');
    void duckBody.offsetWidth;
    duckBody.classList.add('bounce');
    spawnParticle(); spawnParticle();
    if (squeaks % 3 === 1 || squeaks === 1) {
      wisdomText.style.opacity = '0';
      setTimeout(() => { wisdomText.textContent = getWisdom(); wisdomText.style.opacity = '1'; }, 250);
    }
  }

  duckBody.addEventListener('mouseup', releaseDuck);
  duckBody.addEventListener('mouseleave', releaseDuck);
  duckBody.addEventListener('touchend', (e) => { e.preventDefault(); releaseDuck(); });
  duckBody.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (squeezing) return;
    squeezing = true;
    duckBody.classList.add('squeezing'); duckBody.classList.remove('bounce');
  });
}

init();
