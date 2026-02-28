// Debt Shield v2 — Popup Script

let appState = null;

// ── INIT ──────────────────────────────────────────────────────
async function init() {
  const data = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  appState = data;
  renderAll();
  attachEvents();
}

// ── RENDER ────────────────────────────────────────────────────
function renderAll() {
  renderHeader();
  renderOverview();
  renderSettings();
  renderHistory();
}

function renderHeader() {
  const { settings } = appState;
  const toggle = document.getElementById('header-toggle');
  const status = document.getElementById('brand-status');
  const glow = document.getElementById('shield-glow');

  toggle.classList.toggle('on', settings.enabled);

  if (!settings.enabled) {
    status.textContent = '○ DISABLED';
    status.className = 'off';
    glow.className = 'off';
  } else {
    status.textContent = '● PROTECTION ACTIVE';
    status.className = 'on';
    glow.className = '';
  }
}

function renderOverview() {
  const { settings, session, streak } = appState;
  const c = settings.currency || '£';
  const budget = settings.monthlyBudget || 500;
  const spent = session.monthlySpend || 0;
  const pct = budget > 0 ? Math.min(1, spent / budget) : 0;
  const left = Math.max(0, budget - spent);

  // Month label
  const now = new Date();
  document.getElementById('budget-month').textContent =
    `${now.toLocaleString('default', { month: 'long' }).toUpperCase()} ${now.getFullYear()}`;

  document.getElementById('budget-spent-big').textContent = `${c}${spent.toFixed(0)}`;
  document.getElementById('budget-total-big').textContent = `${c}${budget}`;

  const fill = document.getElementById('budget-fill');
  fill.style.width = `${pct * 100}%`;
  fill.className = pct >= 1 ? 'critical' : pct >= 0.8 ? 'danger' : pct >= 0.6 ? 'warn' : '';

  document.getElementById('budget-pct-label').textContent = `${Math.round(pct * 100)}% used`;
  document.getElementById('budget-left-label').textContent = `${c}${left.toFixed(0)} remaining`;

  document.getElementById('s-intercepted').textContent = session.interceptCount || 0;
  document.getElementById('s-proceeded').textContent = session.proceededCount || 0;
  document.getElementById('s-session').textContent = `${c}${(session.sessionSpend || 0).toFixed(0)}`;

  // Streak
  const cur = streak?.current || 0;
  const best = streak?.best || 0;
  document.getElementById('streak-num').textContent = cur;
  document.getElementById('streak-emoji').textContent = cur >= 7 ? '🏆' : cur >= 3 ? '🔥' : cur >= 1 ? '✨' : '🌱';

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
  document.getElementById('tc-high').textContent = `${c}${t.high || 50}`;
  document.getElementById('tc-medium').textContent = `${c}${t.medium || 15}`;

  // Active currency button
  document.querySelectorAll('.currency-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.c === (settings.currency || '£'));
    btn.style.borderColor = btn.dataset.c === (settings.currency || '£') ? 'rgba(255,255,255,0.3)' : '';
    btn.style.color = btn.dataset.c === (settings.currency || '£') ? 'rgba(255,255,255,0.8)' : '';
  });
}

function renderHistory() {
  const { history, settings } = appState;
  const c = settings.currency || '£';
  const list = document.getElementById('history-list');

  if (!history || history.length === 0) {
    list.innerHTML = '<div class="h-empty">No transactions logged yet</div>';
    return;
  }

  list.innerHTML = history.slice(0, 40).map(h => {
    const d = new Date(h.timestamp);
    const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) +
      ' · ' + d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    return `
      <div class="h-item">
        <div class="h-dot ${h.riskLevel || 'low'}"></div>
        <div class="h-info">
          <div class="h-domain">${h.domain || 'unknown'}</div>
          <div class="h-time">${timeStr}</div>
        </div>
        <div class="h-amount">${h.amount ? `${c}${h.amount.toFixed(0)}` : '?'}</div>
        <div class="h-action ${h.action}">${h.action === 'intercepted' ? 'caught' : 'bought'}</div>
        <!-- action classes: 'intercepted' → yellow, 'purchased' → red -->
      </div>
    `;
  }).join('');
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

  // Quick actions
  document.getElementById('q-scan').addEventListener('click', () => {
    notifyTabs({ type: 'MANUAL_SCAN' });
    window.close();
  });

  document.getElementById('q-duck').addEventListener('click', () => {
    // Switch to duck tab
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    document.querySelector('[data-tab="duck"]').classList.add('active');
    document.getElementById('tab-duck').classList.add('active');
  });

  document.getElementById('q-hud').addEventListener('click', () => {
    notifyTabs({ type: 'TOGGLE_PANEL' });
    window.close();
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
    const c = appState.settings.currency || '£';
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

  // Clear history
  document.getElementById('clear-history-btn').addEventListener('click', async () => {
    appState.history = [];
    await chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' });
    renderHistory();
  });

  // ── DUCK GAME ──────────────────────────────────────────────
  initDuckGame();
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

  const startBtn = document.getElementById('duck-start-btn');
  const intro = document.getElementById('duck-intro');
  const active = document.getElementById('duck-active');
  const duckBody = document.getElementById('duck-body');
  const squeaksContainer = document.getElementById('duck-squeaks');
  const wisdomText = document.getElementById('duck-wisdom-text');
  const squeakCountEl = document.getElementById('duck-squeak-count');

  let squeaks = 0;
  let lastWisdomIdx = -1;
  let wisdomShuffled = [...WISDOMS].sort(() => Math.random() - 0.5);

  startBtn.addEventListener('click', () => {
    intro.style.display = 'none';
    active.style.display = 'block';
  });

  function getWisdom() {
    if (wisdomShuffled.length === 0) wisdomShuffled = [...WISDOMS].sort(() => Math.random() - 0.5);
    return wisdomShuffled.pop();
  }

  function spawnParticle() {
    const p = document.createElement('div');
    p.className = 'squeak-particle';
    p.textContent = SQUEAK_WORDS[Math.floor(Math.random() * SQUEAK_WORDS.length)];
    p.style.left = `${20 + Math.random() * 60}%`;
    p.style.top = `${10 + Math.random() * 50}%`;
    p.style.animationDelay = `${Math.random() * 0.1}s`;
    squeaksContainer.appendChild(p);
    setTimeout(() => p.remove(), 900);
  }

  let squeezing = false;

  duckBody.addEventListener('mousedown', () => {
    if (squeezing) return;
    squeezing = true;
    duckBody.classList.add('squeezing');
    duckBody.classList.remove('bounce');
  });

  function releaseDuck() {
    if (!squeezing) return;
    squeezing = false;
    squeaks++;
    squeakCountEl.textContent = squeaks;

    duckBody.classList.remove('squeezing');
    void duckBody.offsetWidth;
    duckBody.classList.add('bounce');

    spawnParticle();
    spawnParticle();

    // Update wisdom every 3 squeaks
    if (squeaks % 3 === 1 || squeaks === 1) {
      wisdomText.style.opacity = '0';
      setTimeout(() => {
        wisdomText.textContent = getWisdom();
        wisdomText.style.opacity = '1';
      }, 250);
    }
  }

  duckBody.addEventListener('mouseup', releaseDuck);
  duckBody.addEventListener('mouseleave', releaseDuck);
  duckBody.addEventListener('touchend', (e) => { e.preventDefault(); releaseDuck(); });
  duckBody.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (squeezing) return;
    squeezing = true;
    duckBody.classList.add('squeezing');
    duckBody.classList.remove('bounce');
  });
}

init();
