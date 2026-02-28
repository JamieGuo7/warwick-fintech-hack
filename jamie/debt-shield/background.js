// ============================================================
// DEBT SHIELD v2 — Background Service Worker
// ============================================================

const DEFAULTS = {
  enabled: true,
  monthlyBudget: 500,
  warningThresholds: { critical: 200, high: 50, medium: 15 },
  currency: '£',
  streakGoalDays: 7,
  userName: '',
  apiBase: 'http://localhost:8000',
};

const STORAGE = {
  SETTINGS: 'ds_settings',
  HISTORY:  'ds_history',
  STATS:    'ds_stats',
  SESSION:  'ds_session',
  PROFILE:  'ds_profile',
};

function todayKey() { return new Date().toDateString(); }
function monthKey() { return new Date().toISOString().slice(0, 7); }

// ── INSTALL ──────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(STORAGE.SETTINGS);
  if (!existing[STORAGE.SETTINGS]) {
    await chrome.storage.local.set({
      [STORAGE.SETTINGS]: DEFAULTS,
      [STORAGE.HISTORY]:  [],
      [STORAGE.STATS]: {
        totalSaved: 0, totalWarnings: 0, totalBlocked: 0,
        totalProceeded: 0, monthlySpend: {}, streakDays: 0,
        bestStreak: 0, lastProtectedDay: null,
      },
      [STORAGE.SESSION]: {
        date: todayKey(), interceptCount: 0,
        proceededCount: 0, sessionSpend: 0, monthlySpend: 0,
      },
    });
  }
  updateBadge();
});

// ── SESSION RESET (daily) ────────────────────────────────────
async function ensureSessionFresh() {
  const data = await chrome.storage.local.get(STORAGE.SESSION);
  const session = data[STORAGE.SESSION] || {};
  if (session.date !== todayKey()) {
    const statsData = await chrome.storage.local.get(STORAGE.STATS);
    const stats = statsData[STORAGE.STATS] || {};
    const mk = monthKey();
    const freshSession = {
      date: todayKey(), interceptCount: 0,
      proceededCount: 0, sessionSpend: 0,
      monthlySpend: stats.monthlySpend?.[mk] || 0,
    };
    await chrome.storage.local.set({ [STORAGE.SESSION]: freshSession });
    return freshSession;
  }
  return session;
}

// ── BADGE ────────────────────────────────────────────────────
async function updateBadge() {
  const data = await chrome.storage.local.get(STORAGE.SETTINGS);
  const settings = data[STORAGE.SETTINGS] || DEFAULTS;
  if (!settings.enabled) {
    chrome.action.setBadgeText({ text: 'OFF' });
    chrome.action.setBadgeBackgroundColor({ color: '#444' });
  } else {
    chrome.action.setBadgeText({ text: 'ON' });
    chrome.action.setBadgeBackgroundColor({ color: '#00c47a' });
  }
}

// ── BUILD FULL STATE ─────────────────────────────────────────
async function buildFullState() {
  const session = await ensureSessionFresh();
  const raw = await chrome.storage.local.get([
    STORAGE.SETTINGS, STORAGE.HISTORY, STORAGE.STATS, STORAGE.PROFILE,
  ]);
  const settings = raw[STORAGE.SETTINGS] || DEFAULTS;
  const stats    = raw[STORAGE.STATS]    || {};
  const history  = raw[STORAGE.HISTORY]  || [];
  const profile  = raw[STORAGE.PROFILE]  || null;
  const cur      = stats.streakDays  || 0;
  const best     = Math.max(cur, stats.bestStreak || 0);
  return { settings, session, history, streak: { current: cur, best }, profile };
}

// ── MESSAGE HANDLER ──────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {

      case 'GET_STATE': {
        sendResponse(await buildFullState());
        break;
      }

      case 'GET_PROFILE': {
        const raw = await chrome.storage.local.get(STORAGE.PROFILE);
        sendResponse({ profile: raw[STORAGE.PROFILE] || null });
        break;
      }

      case 'STORE_PROFILE': {
        await chrome.storage.local.set({ [STORAGE.PROFILE]: msg.profile });
        sendResponse({ ok: true });
        break;
      }

      case 'SYNC_PROFILE': {
        const settingsData = await chrome.storage.local.get(STORAGE.SETTINGS);
        const settings = settingsData[STORAGE.SETTINGS] || DEFAULTS;
        const userName = settings.userName || '';
        const apiBase  = (settings.apiBase || 'http://localhost:8000').replace(/\/$/, '');

        if (!userName) {
          sendResponse({ ok: false, reason: 'no_user' });
          break;
        }

        try {
          const [userRes, scoreRes] = await Promise.all([
            fetch(`${apiBase}/user/${encodeURIComponent(userName)}`),
            fetch(`${apiBase}/score/${encodeURIComponent(userName)}`),
          ]);

          if (!userRes.ok || !scoreRes.ok) {
            sendResponse({ ok: false, reason: 'api_error' });
            break;
          }

          const userData  = await userRes.json();
          const scoreData = await scoreRes.json();

          const totalDebtPayments = (userData.debts || []).reduce((s, d) => s + (d.monthly_payment || 0), 0);
          const monthly_net = Math.max(0, (userData.average_income || 0) - (userData.average_expenses || 0));

          const profile = {
            score:       scoreData.shield_score,
            income:      userData.average_income   || 0,
            expenses:    userData.average_expenses || 0,
            monthly_net,
            savings:     userData.current_savings  || 0,
            goals:       (userData.savings_goals || []).map((g, i) => ({
              name:     g.name,
              target:   g.target_amount,
              priority: g.priority ?? (i + 1),
            })),
            synced_at: Date.now(),
          };

          await chrome.storage.local.set({ [STORAGE.PROFILE]: profile });
          sendResponse({ ok: true, profile });
        } catch (e) {
          sendResponse({ ok: false, reason: 'fetch_error', error: e.message });
        }
        break;
      }

      case 'UPDATE_SETTINGS': {
        const current = (await chrome.storage.local.get(STORAGE.SETTINGS))[STORAGE.SETTINGS] || DEFAULTS;
        await chrome.storage.local.set({ [STORAGE.SETTINGS]: { ...current, ...msg.settings } });
        updateBadge();
        sendResponse({ ok: true });
        break;
      }

      case 'SAVE_SETTINGS': {
        await chrome.storage.local.set({ [STORAGE.SETTINGS]: msg.settings });
        updateBadge();
        sendResponse({ ok: true });
        break;
      }

      case 'LOG_INTERCEPT': {
        const { amount, riskLevel, domain, pageTitle } = msg.data || {};
        const histData = await chrome.storage.local.get(STORAGE.HISTORY);
        const history = histData[STORAGE.HISTORY] || [];
        history.unshift({ id: Date.now(), timestamp: Date.now(), amount, riskLevel,
          domain: domain || 'unknown', pageTitle: pageTitle || '', action: 'intercepted' });
        if (history.length > 200) history.splice(200);

        const session = await ensureSessionFresh();
        session.interceptCount = (session.interceptCount || 0) + 1;

        const statsData = await chrome.storage.local.get(STORAGE.STATS);
        const stats = statsData[STORAGE.STATS] || {};
        stats.totalWarnings = (stats.totalWarnings || 0) + 1;
        const today = todayKey();
        if (stats.lastProtectedDay !== today) {
          const yesterday = new Date(Date.now() - 86400000).toDateString();
          stats.streakDays = stats.lastProtectedDay === yesterday ? (stats.streakDays || 0) + 1 : 1;
          stats.bestStreak = Math.max(stats.streakDays, stats.bestStreak || 0);
          stats.lastProtectedDay = today;
        }
        await chrome.storage.local.set({
          [STORAGE.HISTORY]: history, [STORAGE.SESSION]: session, [STORAGE.STATS]: stats,
        });
        sendResponse({ ok: true });
        break;
      }

      case 'LOG_PURCHASE': {
        const { amount, domain, riskLevel } = msg.data || {};
        const histData = await chrome.storage.local.get(STORAGE.HISTORY);
        const history = histData[STORAGE.HISTORY] || [];
        history.unshift({ id: Date.now(), timestamp: Date.now(), amount, riskLevel,
          domain: domain || 'unknown', action: 'purchased' });
        if (history.length > 200) history.splice(200);

        const session = await ensureSessionFresh();
        session.proceededCount = (session.proceededCount || 0) + 1;
        if (amount) session.sessionSpend = (session.sessionSpend || 0) + amount;

        const statsData = await chrome.storage.local.get(STORAGE.STATS);
        const stats = statsData[STORAGE.STATS] || {};
        stats.totalProceeded = (stats.totalProceeded || 0) + 1;
        if (amount) {
          const mk = monthKey();
          if (!stats.monthlySpend) stats.monthlySpend = {};
          stats.monthlySpend[mk] = (stats.monthlySpend[mk] || 0) + amount;
          session.monthlySpend = stats.monthlySpend[mk];
        }
        await chrome.storage.local.set({
          [STORAGE.HISTORY]: history, [STORAGE.SESSION]: session, [STORAGE.STATS]: stats,
        });
        sendResponse({ ok: true });
        break;
      }

      case 'RESET_ALL': {
        const statsData = await chrome.storage.local.get(STORAGE.STATS);
        const stats = { ...(statsData[STORAGE.STATS] || {}), streakDays: 0, lastProtectedDay: null };
        await chrome.storage.local.set({
          [STORAGE.SESSION]: { date: todayKey(), interceptCount: 0, proceededCount: 0, sessionSpend: 0, monthlySpend: 0 },
          [STORAGE.STATS]: stats,
        });
        sendResponse({ ok: true });
        break;
      }

      case 'CLEAR_HISTORY': {
        await chrome.storage.local.set({ [STORAGE.HISTORY]: [] });
        sendResponse({ ok: true });
        break;
      }

      case 'RESET_STATS': {
        await chrome.storage.local.set({
          [STORAGE.STATS]: { totalSaved: 0, totalWarnings: 0, totalBlocked: 0,
            totalProceeded: 0, monthlySpend: {}, streakDays: 0, bestStreak: 0, lastProtectedDay: null },
        });
        sendResponse({ ok: true });
        break;
      }

      case 'BADGE_UPDATE': {
        updateBadge();
        sendResponse({ ok: true });
        break;
      }

      case 'GET_ALL_DATA': {
        sendResponse(await chrome.storage.local.get(null));
        break;
      }
    }
  })();
  return true;
});

// ── ALARM: refresh badge every minute ───────────────────────
chrome.alarms.create('badgeRefresh', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'badgeRefresh') updateBadge();
});
