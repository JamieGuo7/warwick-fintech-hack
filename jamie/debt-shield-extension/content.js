// ================================================================
// DEBT SHIELD v2 — Content Script
// ================================================================

(function () {
  if (window.__dsV2Active) return;
  window.__dsV2Active = true;

  // ── SAFE MESSAGING ───────────────────────────────────────────
  function safeSend(msg) {
    return new Promise((resolve) => {
      try {
        if (!chrome?.runtime?.id) { resolve(null); return; }
        chrome.runtime.sendMessage(msg, (response) => {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(response || null);
        });
      } catch (e) { resolve(null); }
    });
  }

  // ── STATE ────────────────────────────────────────────────────
  let state = {
    settings: null, session: null, history: [],
    streak: { current: 0, best: 0 }, profile: null,
    panelOpen: false, modalVisible: false,
    currentAmount: null, currentRisk: null, scanInProgress: false,
    _modalAllowed: undefined, _interceptedBtn: null, _proceeding: false,
    _shownForUrl: null, // only intercept once per page state
  };

  // ── DETECTION PATTERNS ───────────────────────────────────────
  const CHECKOUT_BTNS = [
    /place\s*order/i, /complete\s*purchase/i, /pay\s*(now|today|£|\$|€)/i,
    /confirm\s*(and\s*)?(pay|order|purchase)/i, /buy\s*(now|it\s*now)/i,
    /^buy\s*it\s*now$/i, /^purchase$/i, /checkout/i, /check\s*out/i,
    /submit\s*order/i, /finish\s*purchase/i,
    /proceed\s*to\s*(pay|checkout)/i, /make\s*payment/i, /confirm\s*payment/i,
    /add\s*to\s*bag/i, /order\s*now/i, /purchase\s*now/i,
    /continue\s*to\s*(pay|checkout|payment)/i, /complete\s*order/i,
    /review\s*(and\s*)?pay/i, /subscribe\s*(and\s*pay)?/i,
    /^add\s*to\s*cart$/i, /reserve\s*now/i,
    /book\s*(now|and\s*pay)/i, /confirm\s*(booking|reservation)/i,
  ];

  const PRICE_REGEX = /(?:£|\$|€|USD|GBP|EUR)\s?(\d{1,6}(?:[,\s]\d{3})*(?:[.,]\d{1,2})?)|(\d{1,6}(?:[,\s]\d{3})*(?:[.,]\d{2}))\s?(?:£|\$|€|USD|GBP|EUR)/g;

  const CARD_INPUTS = [
    /card.*(number|num|no)/i, /credit.*card/i, /debit.*card/i,
    /ccnumber/i, /cc-number/i, /cardnumber/i, /card-number/i, /pan\b/i
  ];

  // ── RISK LOGIC ───────────────────────────────────────────────
  function getRisk(amount, settings, profile) {
    if (!amount || !settings) return 'low';
    // Use profile monthly_net as the budget for dynamic threshold scaling
    const surplus = profile?.monthly_net || null;
    const t = settings.warningThresholds;
    if (surplus) {
      // Scale risk thresholds proportionally to the user's actual surplus
      if (amount >= surplus * 0.4) return 'critical';
      if (amount >= surplus * 0.1) return 'high';
      if (amount >= surplus * 0.03) return 'medium';
      return 'low';
    }
    if (amount >= t.critical) return 'critical';
    if (amount >= t.high) return 'high';
    if (amount >= t.medium) return 'medium';
    return 'low';
  }

  function getRiskLabel(r) {
    return { critical: '🚨 DANGER', high: '⚠️ WARNING', medium: '🔶 CAUTION', low: '✅ SAFE' }[r];
  }

  function getRiskMsg(amount, risk) {
    const c = state.settings?.currency || '£';
    const f = amount ? `${c}${amount.toFixed(2)}` : 'This purchase';
    const pool = {
      critical: [`Just a heads up — ${f} is a big one.`, `Worth a quick pause before committing ${f}.`, `${f} detected. No pressure, just checking in.`],
      high: [`${f} on the way — was this on your radar?`, `Quick check: is ${f} in the plan today?`, `Noticed ${f} here. Planned or spontaneous?`],
      medium: [`${f} — just making sure you saw that.`, `Small one, but worth a glance: ${f}.`, `${f} spotted. All good if it's intentional!`],
      low: [`Tiny purchase, no worries — just staying aware.`, `All looks fine here. Carry on!`]
    };
    const msgs = pool[risk] || pool.low;
    return msgs[Math.floor(Math.random() * msgs.length)];
  }

  // ── PRICE ENGINE ─────────────────────────────────────────────
  const DS_IDS = new Set(['ds-badge','ds-panel','ds-modal-overlay','ds-toast-container','ds-scan-pulse']);

  function isInsideDS(el) {
    let cur = el;
    while (cur) { if (cur.id && DS_IDS.has(cur.id)) return true; cur = cur.parentElement; }
    return false;
  }

  function parsePrice(raw) {
    if (raw == null) return null;
    const s = String(raw).replace(/[£$€]|USD|GBP|EUR/g, '').trim();
    const normalised = s.replace(/,(\d{3})/g, '$1').replace(/[^0-9.]/g, '');
    const v = parseFloat(normalised);
    return (!isNaN(v) && v >= 0.5 && v < 50000) ? v : null;
  }

  // ── SITE SELECTORS ───────────────────────────────────────────
  const SITE_SELECTORS = {
    'ebay.co.uk':          '.x-price-primary [class*="textspans"]:first-child, .x-price-approx__price',
    'ebay.com':            '.x-price-primary [class*="textspans"]:first-child',
    'amazon.co.uk':        '.a-price .a-offscreen, #corePriceDisplay_desktop_feature_div .a-price-whole, #priceblock_ourprice',
    'amazon.com':          '.a-price .a-offscreen, #corePriceDisplay_desktop_feature_div .a-price-whole',
    'asos.com':            '[data-testid="current-price"], [class*="current-price"]',
    'argos.co.uk':         '[data-test="product-price"] strong, [class*="ProductPrice"]',
    'next.co.uk':          '[class*="Price-module__price"], [class*="styled__Price"]',
    'johnlewis.com':       '[data-testid="product-price"], [class*="price-module_price"]',
    'currys.co.uk':        '[class*="price__main"], [data-component="price"]',
    'very.co.uk':          '[class*="product-price__current"], .productPrice',
    'boots.com':           '[class*="product-price"], [data-testid="price"]',
    'marksandspencer.com': '[data-testid="price"], [class*="price-value"]',
    'hm.com':              '[class*="price-value"], [class*="ProductPrice"]',
    'zara.com':            '[class*="price-current"], [class*="money-amount__main"]',
    'ikea.com':            '[class*="pip-price__integer"], .pip-price',
    'etsy.com':            '[data-testid="price-only"] .currency-value, [class*="currency-value"]',
    'wayfair.co.uk':       '[class*="SFPrice"], [data-enzyme-id="PriceBlock"] [class*="price"]',
    'screwfix.com':        '[class*="price"], [data-testid="product-price"]',
    'diy.com':             '[data-testid="product-price"], [class*="productPrice"]',
    'booking.com':         '[data-testid="price-and-discounted-price"]',
    'sportsdirect.com':    '#dnn_ctr1524_View_lblSellingPrice, [class*="productPrice"]',
    'halfords.com':        '[class*="price__value"], [data-testid="product-price"]',
    'dunelm.com':          '[class*="Price__"], [data-testid="product-price"]',
    'gymshark.com':        '[data-testid="product-price"], [class*="ProductPrice"]',
    'nike.com':            '[data-testid="product-price"]',
    'adidas.co.uk':        '[class*="gl-price__value--sale"], [class*="gl-price__value"]',
    'apple.com':           '[data-autom="product-price"], [class*="current_price"]',
    'game.co.uk':          '[class*="product-price__value"]',
    'sainsburys.co.uk':    '[data-testid="product-price-value"], [class*="pd__cost"]',
    'tesco.com':           '[data-auto="price-value"]',
    'ao.com':              '[class*="c-product-price__value"]',
    'toolstation.com':     '[class*="price-inc-vat"]',
    'wickes.co.uk':        '[class*="price__"]',
  };

  // ── GATHER ALL CANDIDATES WITH CONFIDENCE ────────────────────
  // Returns array of { value, source, confidence: 1-3 }
  function getAllPriceCandidates() {
    const candidates = [];

    function add(value, source, confidence) {
      const v = parsePrice(value);
      if (v) candidates.push({ value: v, source, confidence });
    }

    // Confidence 3: known site CSS — most reliable
    const domain = window.location.hostname.replace(/^www\./, '');
    const siteKey = Object.keys(SITE_SELECTORS).find(k => domain === k || domain.endsWith('.' + k));
    if (siteKey) {
      for (const sel of SITE_SELECTORS[siteKey].split(',').map(s => s.trim())) {
        try {
          const el = document.querySelector(sel);
          if (el && !isInsideDS(el)) add(el.getAttribute('content') || el.textContent, `site CSS (${siteKey})`, 3);
        } catch (_) {}
      }
    }

    // Confidence 3: JSON-LD structured data
    document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
      try {
        const dig = (obj) => {
          if (!obj || typeof obj !== 'object') return;
          const p = obj.lowPrice ?? obj.price ?? obj.offers?.lowPrice ?? obj.offers?.price;
          if (p != null) add(p, 'structured data (JSON-LD)', 3);
          Object.values(obj).forEach(v => {
            if (Array.isArray(v)) v.forEach(dig);
            else if (v && typeof v === 'object') dig(v);
          });
        };
        dig(JSON.parse(script.textContent));
      } catch (_) {}
    });

    // Confidence 3: meta price tags
    document.querySelectorAll('meta[property*="price"], meta[name*="price"]').forEach(m => {
      add(m.getAttribute('content'), 'meta tag', 3);
    });

    // Confidence 3: data-price attributes
    document.querySelectorAll('[data-price],[data-buy-price],[data-final-price],[data-product-price],[data-sale-price],[itemprop="price"]').forEach(el => {
      if (isInsideDS(el)) return;
      const raw = el.getAttribute('data-price') || el.getAttribute('data-buy-price') ||
                  el.getAttribute('data-final-price') || el.getAttribute('data-product-price') ||
                  el.getAttribute('data-sale-price') || el.getAttribute('content') || el.textContent;
      add(raw, 'data attribute', 3);
    });

    // Confidence 2: generic CSS price selectors
    const genericSels = [
      '[class*="sale-price"]:not([class*="was"])', '[class*="offer-price"]', '[class*="final-price"]',
      '[class*="current-price"]', '[class*="selling-price"]',
      '[class*="product-price"]:not([class*="was"]):not([class*="old"])', '[id*="product-price"]',
      '.price ins .woocommerce-Price-amount', '.woocommerce-Price-amount',
      '[data-price-type="finalPrice"] .price', '.price-wrapper .price',
      '[class*="price__current"]', '.product__price',
      '.current-price-value', '#our_price_display',
    ];
    for (const sel of genericSels) {
      try {
        const el = document.querySelector(sel);
        if (el && !isInsideDS(el)) add(el.getAttribute('content') || el.textContent, `CSS selector`, 2);
      } catch (_) {}
    }

    // Confidence 2: proximity to checkout button
    document.querySelectorAll('button, input[type="submit"], [role="button"]').forEach(btn => {
      if (isInsideDS(btn)) return;
      const text = (btn.innerText || btn.textContent || btn.value || '').toLowerCase();
      if (!CHECKOUT_BTNS.some(p => p.test(text))) return;
      let el = btn;
      for (let i = 0; i < 4; i++) {
        el = el.parentElement;
        if (!el) break;
        PRICE_REGEX.lastIndex = 0;
        let m;
        while ((m = PRICE_REGEX.exec(el.textContent)) !== null) {
          const v = parsePrice((m[1] || m[2] || '').replace(/[,\s]/g, ''));
          if (v) candidates.push({ value: v, source: 'near checkout button', confidence: 2 });
        }
      }
    });

    // Confidence 1: window data blobs
    const PRICE_KEYS = /^(price|sale_?price|current_?price|selling_?price|offer_?price|unit_?price|final_?price|buy_?price|amount)$/i;
    const seen = new WeakSet();
    function digBlob(obj, depth) {
      if (!obj || typeof obj !== 'object' || depth > 8) return;
      if (obj.nodeType || typeof obj === 'function') return;
      if (seen.has(obj)) return;
      seen.add(obj);
      try {
        if (Array.isArray(obj)) { obj.slice(0, 20).forEach(v => digBlob(v, depth + 1)); return; }
        for (const [k, v] of Object.entries(obj)) {
          if (PRICE_KEYS.test(k) && (typeof v === 'number' || typeof v === 'string')) add(v, 'window data blob', 1);
          if (v && typeof v === 'object') digBlob(v, depth + 1);
        }
      } catch (_) {}
    }
    [window.__NEXT_DATA__, window.__INITIAL_STATE__, window.__PRELOADED_STATE__,
     window.__APP_STATE__, window.__NUXT__, window.pageData, window.utag_data
    ].forEach(b => { try { digBlob(b, 0); } catch (_) {} });

    return candidates;
  }

  // ── PICK BEST CANDIDATES FOR DISPLAY ────────────────────────
  // Returns top 3 deduplicated candidates, sorted by confidence then frequency
  function getTopCandidates() {
    const all = getAllPriceCandidates();
    if (!all.length) return [];

    // Score: confidence * 10 + frequency
    const freq = {};
    const bestConf = {};
    const bestSource = {};
    all.forEach(({ value, source, confidence }) => {
      const k = value.toFixed(2);
      freq[k] = (freq[k] || 0) + 1;
      if (!bestConf[k] || confidence > bestConf[k]) { bestConf[k] = confidence; bestSource[k] = source; }
    });

    return Object.entries(freq)
      .map(([k, f]) => ({ value: parseFloat(k), source: bestSource[k], confidence: bestConf[k], score: bestConf[k] * 10 + f }))
      .filter(c => {
        // Filter out clearly wrong values: shipping costs (under £2), suspiciously round non-product numbers
        if (c.value < 1) return false;
        return true;
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 4); // top 4 options to show user
  }

  function getBestPrice() {
    const top = getTopCandidates();
    return top.length ? top[0].value : null;
  }

  function getDomain() { return window.location.hostname.replace(/^www\./, ''); }

  // ── PATCH fetch + XHR TO HOLD REQUESTS WHILE MODAL IS OPEN ──
  // This is the only reliable way to stop SPA checkout calls
  (function patchNetwork() {
    const win = window;

    // Patch fetch
    const origFetch = win.fetch;
    win.fetch = function(...args) {
      if (state.modalVisible && !state._proceeding) {
        // Queue this request — resolve it when modal closes
        return new Promise((resolve, reject) => {
          const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
          if (isCheckoutUrl(url)) {
            // Block checkout URLs entirely until user decides
            waitForModalClose().then(allowed => {
              if (allowed) resolve(origFetch.apply(this, args));
              else reject(new Error('DebtShield: purchase blocked'));
            });
          } else {
            // Non-checkout fetches pass through normally
            resolve(origFetch.apply(this, args));
          }
        });
      }
      return origFetch.apply(this, args);
    };

    // Patch XHR
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this.__dsUrl = url;
      return origOpen.call(this, method, url, ...rest);
    };

    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function(...args) {
      if (state.modalVisible && !state._proceeding && isCheckoutUrl(this.__dsUrl || '')) {
        const xhr = this;
        waitForModalClose().then(allowed => {
          if (allowed) origSend.apply(xhr, args);
          // if not allowed, just silently drop it
        });
        return;
      }
      return origSend.apply(this, args);
    };

    function isCheckoutUrl(url) {
      return /checkout|payment|order|purchase|cart\/submit|place[-_]?order|pay\b/i.test(url);
    }

    function waitForModalClose() {
      return new Promise(resolve => {
        const check = setInterval(() => {
          if (!state.modalVisible) {
            clearInterval(check);
            resolve(state._modalAllowed !== false);
            state._modalAllowed = undefined;
          }
        }, 100);
        // Safety timeout — don't hold forever
        setTimeout(() => { clearInterval(check); resolve(true); }, 60000);
      });
    }
  })();

  // ── INTERCEPT CHECKOUT BUTTONS ───────────────────────────────
  function interceptBtn(btn) {
    if (btn.__dsIntercepted) return;
    btn.__dsIntercepted = true;

    // Capture phase fires before ANY site handler
    btn.addEventListener('click', (e) => {
      if (!state.settings?.enabled) return;
      if (state.modalVisible) return;
      if (state._proceeding) return;
      if (state._shownForUrl === location.href) return; // already shown once for this page state
      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();

      state._interceptedBtn = btn;

      // Block parent form submit too
      const form = btn.closest('form');
      if (form && !form.__dsFormBlocked) {
        form.__dsFormBlocked = true;
        const blockSubmit = (fe) => { fe.preventDefault(); fe.stopImmediatePropagation(); };
        form.addEventListener('submit', blockSubmit, true);
        btn.__dsFormCleanup = () => {
          form.removeEventListener('submit', blockSubmit, true);
          form.__dsFormBlocked = false;
        };
      }

      safeSend({ type: 'LOG_INTERCEPT', data: { amount: null, riskLevel: 'unknown', domain: getDomain(), pageTitle: document.title } });
      showModal();
    }, true);
  }

  function getButtonText(btn) {
    const sources = [
      btn.getAttribute('aria-label'), btn.getAttribute('data-label'),
      btn.getAttribute('title'), btn.getAttribute('name'),
      btn.getAttribute('data-testid'), btn.getAttribute('data-track-summary'), btn.value,
      (btn.innerText || btn.textContent || '').replace(/\s+/g, ' ').trim()
    ];
    return sources.filter(Boolean).join(' ');
  }

  function scanButtons() {
    try {
      const selector = [
        'button', 'input[type="submit"]', 'input[type="button"]',
        'a[role="button"]', 'div[role="button"]', 'span[role="button"]', '[role="button"]',
        'a.btn', '.checkout-btn',
        '[data-testid*="buy"]', '[data-testid*="checkout"]', '[data-testid*="purchase"]',
        '[class*="checkout"]', '[class*="buy-now"]', '[class*="buynow"]',
        '[class*="place-order"]', '[id*="buy-now"]', '[id*="checkout"]', '[id*="place-order"]',
      ].join(', ');
      document.querySelectorAll(selector).forEach(btn => {
        try {
          if (CHECKOUT_BTNS.some(p => p.test(getButtonText(btn)))) interceptBtn(btn);
        } catch (_) {}
      });
    } catch (_) {}
  }

  function scanCardInputs() {
    try {
      document.querySelectorAll('input').forEach(input => {
        try {
          const id = [input.id, input.name, input.placeholder, input.getAttribute('autocomplete'), input.getAttribute('data-field')].join(' ').toLowerCase();
          if (!input.__dsCardWatched && CARD_INPUTS.some(p => p.test(id))) {
            input.__dsCardWatched = true;
            input.addEventListener('focus', () => {
              if (state.modalVisible || !state.settings?.enabled) return;
              safeSend({ type: 'LOG_INTERCEPT', data: { amount: null, riskLevel: 'unknown', domain: getDomain(), pageTitle: document.title } });
              showModal();
            }, { once: true });
          }
        } catch (_) {}
      });
    } catch (_) {}
  }

  // ── BUILD MODAL OVERLAY (no persistent HUD) ──────────────────
  function buildHUD() {
    if (document.getElementById('ds-modal-overlay')) return;

    const toasts = document.createElement('div');
    toasts.id = 'ds-toast-container';
    document.body.appendChild(toasts);

    const modalOverlay = document.createElement('div');
    modalOverlay.id = 'ds-modal-overlay';
    modalOverlay.innerHTML = `
      <div id="ds-backdrop"></div>
      <div id="ds-price-picker" style="display:none">
        <div id="ds-price-picker-top">
          <div id="ds-price-picker-icon">🛡️</div>
          <div id="ds-price-picker-title">Hold on — what's the price?</div>
          <div id="ds-price-picker-sub">We detected some prices on this page. Tap the right one, or enter it manually.</div>
        </div>
        <div id="ds-price-candidates"></div>
        <div id="ds-price-manual">
          <div id="ds-price-manual-label">Or type it in</div>
          <div id="ds-price-manual-row">
            <input id="ds-price-manual-input" type="number" min="0" step="0.01" placeholder="0.00" />
            <button id="ds-price-manual-confirm">Confirm →</button>
          </div>
        </div>
        <button id="ds-price-skip">Skip — no price to track</button>
      </div>
      <div id="ds-modal">
        <div id="ds-modal-topbar">
          <div id="ds-modal-brand">
            <div id="ds-modal-icon">🛡️</div>
            <div id="ds-modal-brand-text">Debt Shield</div>
          </div>
          <div id="ds-modal-risk-badge"></div>
        </div>
        <div id="ds-modal-body">
          <div id="ds-modal-amount">£0.00</div>
          <div id="ds-modal-site"></div>
          <div id="ds-modal-message"></div>
          <div id="ds-modal-budget-ctx">
            <div class="ds-ctx-item">
              <div class="ds-ctx-label">Monthly Spent</div>
              <div class="ds-ctx-val" id="ds-ctx-spent">£0</div>
            </div>
            <div class="ds-ctx-item">
              <div class="ds-ctx-label">Surplus Left</div>
              <div class="ds-ctx-val" id="ds-ctx-left">—</div>
            </div>
            <div class="ds-ctx-item">
              <div class="ds-ctx-label">After This</div>
              <div class="ds-ctx-val" id="ds-ctx-after">—</div>
            </div>
          </div>
          <div id="ds-impact-section" style="display:none">
            <div class="ds-impact-header"><span class="ds-impact-icon">🛡️</span> Shield Impact</div>
            <div class="ds-impact-score-row">
              <div class="ds-iss-item"><div class="ds-iss-label">Current Score</div><div class="ds-iss-val" id="ds-si-current">--</div></div>
              <div class="ds-iss-arrow">→</div>
              <div class="ds-iss-item"><div class="ds-iss-label">If Purchased</div><div class="ds-iss-val ds-iss-proj" id="ds-si-projected">--</div></div>
              <div class="ds-iss-delta" id="ds-si-delta"></div>
            </div>
            <div id="ds-goals-section">
              <div class="ds-goals-header">Goals Timeline</div>
              <div id="ds-goals-list"></div>
            </div>
          </div>
          <div id="ds-tabs">
            <button class="ds-tab active" data-tab="reflect">🤔 Reflect</button>
            <button class="ds-tab" data-tab="game">🎮 Destress</button>
          </div>
          <div id="ds-tab-reflect" class="ds-tab-pane active">
            <div id="ds-reflect-steps">
              <div class="ds-step-dot active" data-step="0"></div>
              <div class="ds-step-dot" data-step="1"></div>
              <div class="ds-step-dot" data-step="2"></div>
            </div>
            <div class="ds-reflect-card active" data-card="0">
              <span class="ds-reflect-emoji">🤔</span>
              <div class="ds-reflect-q">Do you actually need this, or does it just feel good right now?</div>
              <div class="ds-reflect-answers">
                <button class="ds-answer-btn" data-card="0" data-val="need"><span class="ds-ans-emoji">✅</span> I genuinely need it</button>
                <button class="ds-answer-btn" data-card="0" data-val="want"><span class="ds-ans-emoji">💭</span> Honestly, it's more of a want</button>
                <button class="ds-answer-btn" data-card="0" data-val="unsure"><span class="ds-ans-emoji">🤷</span> Not totally sure</button>
              </div>
            </div>
            <div class="ds-reflect-card" data-card="1">
              <span class="ds-reflect-emoji">📅</span>
              <div class="ds-reflect-q">Have you planned for this, or is it spontaneous?</div>
              <div class="ds-reflect-answers">
                <button class="ds-answer-btn" data-card="1" data-val="planned"><span class="ds-ans-emoji">📋</span> It's been on my list</button>
                <button class="ds-answer-btn" data-card="1" data-val="spontaneous"><span class="ds-ans-emoji">⚡</span> Spontaneous — saw it and wanted it</button>
                <button class="ds-answer-btn" data-card="1" data-val="influenced"><span class="ds-ans-emoji">📱</span> Triggered by an ad or recommendation</button>
              </div>
            </div>
            <div class="ds-reflect-card" data-card="2">
              <span class="ds-reflect-emoji">💸</span>
              <div class="ds-reflect-q">How will you feel about this tomorrow morning?</div>
              <div class="ds-reflect-answers">
                <button class="ds-answer-btn" data-card="2" data-val="great"><span class="ds-ans-emoji">😊</span> Great — I'll be glad I bought it</button>
                <button class="ds-answer-btn" data-card="2" data-val="regret"><span class="ds-ans-emoji">😬</span> Probably a bit guilty</button>
                <button class="ds-answer-btn" data-card="2" data-val="neutral"><span class="ds-ans-emoji">😐</span> Neutral — won't think about it</button>
              </div>
            </div>
            <div id="ds-reflect-done">
              <div id="ds-reflect-done-emoji">✨</div>
              <div id="ds-reflect-done-text">You paused and reflected — that's the hardest part. Whatever you decide, you're doing it consciously.</div>
            </div>
          </div>
          <div id="ds-tab-game" class="ds-tab-pane">
            <div id="ds-game-area">
              <div id="ds-game-intro">
                <div id="ds-game-intro-emoji">🎮</div>
                <div id="ds-game-intro-title">Take a moment</div>
                <div id="ds-game-intro-sub">Pick a game. Chill out. Then decide.</div>
                <div id="ds-game-choice">
                  <button class="ds-game-pick" data-game="balloon">🎈 Balloon</button>
                  <button class="ds-game-pick" data-game="fish">🐠 Catch Fish</button>
                  <button class="ds-game-pick" data-game="mole">🔨 Whack!</button>
                  <button class="ds-game-pick" data-game="paint">🎨 Paint</button>
                </div>
              </div>
              <div id="ds-game-balloon" class="ds-game-screen">
                <div id="ds-balloon-instruction">Hold the button to inflate!</div>
                <div id="ds-balloon-scene"><div id="ds-balloon-body">🎈</div><div id="ds-balloon-string"></div></div>
                <div id="ds-balloon-zone"><div id="ds-balloon-zone-fill"></div><div id="ds-balloon-zone-target"></div><div id="ds-balloon-zone-label">Perfect zone</div></div>
                <button id="ds-balloon-btn">Hold to inflate</button>
                <div id="ds-balloon-score">Score: 0</div>
              </div>
              <div id="ds-game-fish" class="ds-game-screen">
                <div id="ds-fish-header"><span id="ds-fish-score">🐠 0</span><span id="ds-fish-timer">⏱ 20s</span><span id="ds-fish-missed">💨 0 escaped</span></div>
                <div id="ds-fish-tank"></div><div id="ds-fish-msg"></div>
              </div>
              <div id="ds-game-mole" class="ds-game-screen">
                <div id="ds-mole-header"><span id="ds-mole-score">💥 0</span><span id="ds-mole-timer">⏱ 20s</span><span id="ds-mole-combo"></span></div>
                <div id="ds-mole-grid"></div><div id="ds-mole-msg"></div>
              </div>
              <div id="ds-game-paint" class="ds-game-screen">
                <div id="ds-paint-header"><span id="ds-paint-label">🎨 Your masterpiece</span><button id="ds-paint-clear">🗑 clear</button></div>
                <canvas id="ds-paint-canvas" width="420" height="180"></canvas>
                <div id="ds-paint-colours"></div><div id="ds-paint-msg">Click or drag to paint!</div>
              </div>
              <div id="ds-game-done" class="ds-game-screen">
                <div id="ds-game-done-emoji">🌿</div>
                <div id="ds-game-done-title">Nice one!</div>
                <div id="ds-game-done-sub">You've had a moment to reset. How are you feeling about this purchase now?</div>
              </div>
            </div>
          </div>
        </div>
        <div id="ds-modal-actions">
          <button class="ds-modal-btn" id="ds-btn-dont-buy">← Keep my money</button>
          <button class="ds-modal-btn" id="ds-btn-proceed" disabled>Go ahead</button>
        </div>
      </div>`;
    document.body.appendChild(modalOverlay);
    attachModalEvents();
  }

  // ── GAME LOGIC ────────────────────────────────────────────────
  let gameTimer = null;

  function stopGame() {
    if (gameTimer) {
      if (typeof gameTimer.clear === 'function') gameTimer.clear();
      else clearInterval(gameTimer);
      gameTimer = null;
    }
  }

  function showGameDone() {
    stopGame();
    document.querySelectorAll('.ds-game-screen').forEach(s => s.classList.remove('active'));
    document.getElementById('ds-game-done').classList.add('active');
    // Unlock proceed from game tab too
    const proceed = document.getElementById('ds-btn-proceed');
    if (proceed) { proceed.disabled = false; proceed.textContent = 'Go ahead anyway'; }
  }

  // ── BALLOON GAME ──────────────────────────────────────────────
  // Hold button to inflate balloon. Release in the green zone = point. Pop = reset round.
  function startBalloon() {
    document.querySelectorAll('.ds-game-screen').forEach(s => s.classList.remove('active'));
    document.getElementById('ds-game-balloon').classList.add('active');

    const balloon = document.getElementById('ds-balloon-body');
    const fill = document.getElementById('ds-balloon-zone-fill');
    const btn = document.getElementById('ds-balloon-btn');
    const scoreEl = document.getElementById('ds-balloon-score');
    const instruction = document.getElementById('ds-balloon-instruction');

    let size = 1, inflating = false, score = 0, totalRounds = 0;
    const TARGET_MIN = 0.55, TARGET_MAX = 0.80, POP_THRESHOLD = 0.97;
    const INFLATE_SPEED = 0.008, DEFLATE_SPEED = 0.012;
    let animFrame;

    function updateVisuals() {
      const scale = 0.6 + size * 2.4;
      balloon.style.transform = `scale(${scale})`;
      balloon.style.fontSize = `${30 + size * 40}px`;
      fill.style.height = `${size * 100}%`;
      const inZone = size >= TARGET_MIN && size <= TARGET_MAX;
      fill.style.background = size > TARGET_MAX ? (size > 0.9 ? '#ff6b6b' : '#ffa94d') : inZone ? '#69db7c' : '#74c0fc';
    }

    function loop() {
      if (inflating) {
        size = Math.min(1, size + INFLATE_SPEED);
        if (size >= POP_THRESHOLD) {
          // POP!
          balloon.textContent = '💥';
          balloon.style.transform = 'scale(2)';
          instruction.textContent = 'Too much! Try again 😅';
          btn.disabled = true;
          setTimeout(() => {
            balloon.textContent = '🎈';
            size = 0.05;
            updateVisuals();
            instruction.textContent = 'Hold to inflate — release in the green zone!';
            btn.disabled = false;
          }, 800);
          inflating = false;
          animFrame = null;
          return;
        }
      } else {
        size = Math.max(0.05, size - DEFLATE_SPEED);
      }
      updateVisuals();
      animFrame = requestAnimationFrame(loop);
    }

    function startInflate() {
      if (size >= POP_THRESHOLD) return;
      inflating = true;
      btn.textContent = '🫁 Inflating...';
      btn.classList.add('ds-balloon-active');
      if (!animFrame) animFrame = requestAnimationFrame(loop);
    }

    function stopInflate() {
      inflating = false;
      btn.textContent = 'Hold to inflate';
      btn.classList.remove('ds-balloon-active');
      if (size >= TARGET_MIN && size <= TARGET_MAX) {
        score++;
        totalRounds++;
        scoreEl.textContent = `Score: ${score} 🎉`;
        instruction.textContent = `Perfect! 🎯 +1 point`;
        balloon.style.filter = 'drop-shadow(0 0 12px #69db7c)';
        setTimeout(() => {
          balloon.style.filter = '';
          instruction.textContent = 'Hold to inflate — release in the green zone!';
          size = 0.05;
          updateVisuals();
          if (totalRounds >= 5) { cancelAnimationFrame(animFrame); animFrame = null; showGameDone(); }
        }, 600);
      } else if (size > TARGET_MAX) {
        instruction.textContent = 'Too big! Try releasing sooner 📏';
        totalRounds++;
        if (totalRounds >= 5) { cancelAnimationFrame(animFrame); animFrame = null; showGameDone(); }
      }
    }

    btn.addEventListener('mousedown', startInflate);
    btn.addEventListener('touchstart', (e) => { e.preventDefault(); startInflate(); });
    btn.addEventListener('mouseup', stopInflate);
    btn.addEventListener('mouseleave', stopInflate);
    btn.addEventListener('touchend', (e) => { e.preventDefault(); stopInflate(); });

    size = 0.05;
    updateVisuals();
    animFrame = requestAnimationFrame(loop);

    gameTimer = { _raf: animFrame, clear: () => { if (animFrame) cancelAnimationFrame(animFrame); animFrame = null; } };
  }

  // ── FISH GAME ─────────────────────────────────────────────────
  // Catch fish by clicking them before they swim off screen. 20 seconds.
  function startFish() {
    document.querySelectorAll('.ds-game-screen').forEach(s => s.classList.remove('active'));
    document.getElementById('ds-game-fish').classList.add('active');

    const tank = document.getElementById('ds-fish-tank');
    const scoreEl = document.getElementById('ds-fish-score');
    const timerEl = document.getElementById('ds-fish-timer');
    const missedEl = document.getElementById('ds-fish-missed');
    const msgEl = document.getElementById('ds-fish-msg');
    tank.innerHTML = '';

    const FISH_EMOJIS = ['🐠','🐟','🐡','🦈','🐙','🦑','🦀','🦞','🦐','🐚'];
    const MSGS = ['Got it! 🎣','Splendid! 🌊','Noice! 🐟','Caught! ✨','Gotcha! 🎯'];
    let score = 0, missed = 0, timeLeft = 20, fishId = 0;
    const fishTimers = {};

    timerEl.textContent = `⏱ ${timeLeft}s`;

    function spawnFish() {
      if (!document.getElementById('ds-game-fish').classList.contains('active')) return;
      const f = document.createElement('div');
      f.className = 'ds-fish';
      const id = ++fishId;
      f.dataset.id = id;
      const emoji = FISH_EMOJIS[Math.floor(Math.random() * FISH_EMOJIS.length)];
      f.textContent = emoji;
      const top = 5 + Math.random() * 75;
      const speed = 4 + Math.random() * 5;
      const goLeft = Math.random() > 0.5;
      f.style.cssText = `top:${top}%;${goLeft ? 'right:-10%' : 'left:-10%'};transform:scaleX(${goLeft ? -1 : 1});animation:ds-fish-swim ${speed}s linear forwards;`;
      if (goLeft) f.style.animationName = 'ds-fish-swim-left';

      f.addEventListener('click', () => {
        if (f.__caught) return;
        f.__caught = true;
        clearTimeout(fishTimers[id]);
        score++;
        scoreEl.textContent = `🐠 ${score}`;
        msgEl.textContent = MSGS[Math.floor(Math.random() * MSGS.length)];
        f.textContent = '✨';
        f.style.animation = 'ds-fish-catch 0.4s ease forwards';
        setTimeout(() => { f.remove(); msgEl.textContent = ''; }, 400);
      });

      tank.appendChild(f);
      fishTimers[id] = setTimeout(() => {
        if (!f.__caught) { missed++; missedEl.textContent = `💨 ${missed} escaped`; f.remove(); }
      }, speed * 1000 + 200);
    }

    // Spawn fish every 1.2s
    gameTimer = setInterval(() => {
      const fishCount = tank.querySelectorAll('.ds-fish').length;
      if (fishCount < 5) spawnFish();
      if (Math.random() > 0.6) spawnFish(); // occasional burst
    }, 1200);

    // Countdown
    const countdown = setInterval(() => {
      timeLeft--;
      timerEl.textContent = `⏱ ${timeLeft}s`;
      if (timeLeft <= 0) {
        clearInterval(countdown);
        clearInterval(gameTimer);
        gameTimer = null;
        Object.values(fishTimers).forEach(clearTimeout);
        tank.innerHTML = '';
        setTimeout(showGameDone, 400);
      }
    }, 1000);

    spawnFish(); spawnFish(); // immediate fish

    // Store both timers so stopGame can clear them
    const origTimer = gameTimer;
    gameTimer = { clear: () => { clearInterval(origTimer); clearInterval(countdown); } };
  }

  // ── WHACK-A-MOLE GAME ─────────────────────────────────────────
  // Emojis pop up in a grid — click them before they vanish. Combo multiplier!
  function startMole() {
    document.querySelectorAll('.ds-game-screen').forEach(s => s.classList.remove('active'));
    document.getElementById('ds-game-mole').classList.add('active');

    const grid = document.getElementById('ds-mole-grid');
    const scoreEl = document.getElementById('ds-mole-score');
    const timerEl = document.getElementById('ds-mole-timer');
    const comboEl = document.getElementById('ds-mole-combo');
    const msgEl = document.getElementById('ds-mole-msg');

    const EMOJIS = ['💰','💳','🛍️','🏷️','🤑','💸','🛒','💎','🎁','🪙'];
    const GOOD = ['💥','✨','🎯','🔥','⚡'];
    const COLS = 4, ROWS = 3, CELLS = COLS * ROWS;
    let score = 0, combo = 0, timeLeft = 25;
    const cells = [];

    grid.innerHTML = '';
    for (let i = 0; i < CELLS; i++) {
      const cell = document.createElement('div');
      cell.className = 'ds-mole-cell';
      const mole = document.createElement('div');
      mole.className = 'ds-mole';
      cell.appendChild(mole);
      grid.appendChild(cell);
      cells.push({ cell, mole, active: false, timer: null });
    }

    function showMole(idx) {
      const c = cells[idx];
      if (c.active) return;
      c.active = true;
      const emoji = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
      c.mole.textContent = emoji;
      c.mole.classList.add('ds-mole-up');

      c.mole.onclick = () => {
        if (!c.active) return;
        c.active = false;
        clearTimeout(c.timer);
        combo++;
        const multiplier = combo >= 5 ? 3 : combo >= 3 ? 2 : 1;
        score += multiplier;
        scoreEl.textContent = `💥 ${score}`;
        comboEl.textContent = combo >= 3 ? `x${multiplier} COMBO! 🔥` : '';
        msgEl.textContent = GOOD[Math.floor(Math.random() * GOOD.length)];
        c.mole.textContent = '💥';
        c.mole.classList.remove('ds-mole-up');
        c.mole.classList.add('ds-mole-hit');
        setTimeout(() => { c.mole.textContent = ''; c.mole.classList.remove('ds-mole-hit'); msgEl.textContent = ''; }, 300);
      };

      const stayTime = Math.max(600, 1400 - timeLeft * 20);
      c.timer = setTimeout(() => {
        if (!c.active) return;
        c.active = false;
        combo = 0;
        comboEl.textContent = '';
        c.mole.classList.remove('ds-mole-up');
        c.mole.classList.add('ds-mole-miss');
        setTimeout(() => { c.mole.textContent = ''; c.mole.classList.remove('ds-mole-miss'); }, 200);
      }, stayTime);
    }

    function spawnRandom() {
      const idle = cells.map((c,i) => !c.active ? i : -1).filter(i => i >= 0);
      if (!idle.length) return;
      const idx = idle[Math.floor(Math.random() * idle.length)];
      showMole(idx);
      // Sometimes spawn 2 at once
      if (idle.length > 4 && Math.random() > 0.6) {
        const idx2 = idle.filter(i => i !== idx)[Math.floor(Math.random() * (idle.length - 1))];
        if (idx2 !== undefined) setTimeout(() => showMole(idx2), 150);
      }
    }

    gameTimer = setInterval(spawnRandom, 700);
    spawnRandom();

    const countdown = setInterval(() => {
      timeLeft--;
      timerEl.textContent = `⏱ ${timeLeft}s`;
      if (timeLeft <= 0) {
        clearInterval(countdown);
        clearInterval(gameTimer);
        gameTimer = null;
        cells.forEach(c => { clearTimeout(c.timer); c.mole.classList.remove('ds-mole-up'); });
        setTimeout(showGameDone, 300);
      }
    }, 1000);

    const origTimer = gameTimer;
    gameTimer = { clear: () => { clearInterval(origTimer); clearInterval(countdown); } };
  }

  // ── PAINT GAME ────────────────────────────────────────────────
  // Click and drag on canvas to splat paint in satisfying splotches.
  function startPaint() {
    document.querySelectorAll('.ds-game-screen').forEach(s => s.classList.remove('active'));
    document.getElementById('ds-game-paint').classList.add('active');

    const canvas = document.getElementById('ds-paint-canvas');
    const ctx = canvas.getContext('2d');
    const coloursEl = document.getElementById('ds-paint-colours');
    const clearBtn = document.getElementById('ds-paint-clear');
    const msgEl = document.getElementById('ds-paint-msg');

    const PALETTES = [
      ['#ff6b6b','#ff8e53','#ffd43b','#69db7c','#4dabf7','#cc5de8'],
      ['#f06595','#ffa94d','#ffe066','#74c0fc','#a9e34b','#da77f2'],
      ['#ff4444','#ff9933','#ffdd00','#44cc44','#3399ff','#aa44ff'],
    ];
    const palette = PALETTES[Math.floor(Math.random() * PALETTES.length)];
    let currentColour = palette[0];
    let painting = false;
    let splatCount = 0;

    // Render colour buttons
    coloursEl.innerHTML = palette.map(c =>
      `<div class="ds-paint-swatch" data-c="${c}" style="background:${c};${c === currentColour ? 'transform:scale(1.3);box-shadow:0 0 0 2px white,0 0 0 4px '+c+';' : ''}"></div>`
    ).join('');

    coloursEl.querySelectorAll('.ds-paint-swatch').forEach(sw => {
      sw.addEventListener('click', () => {
        currentColour = sw.dataset.c;
        coloursEl.querySelectorAll('.ds-paint-swatch').forEach(s => s.style.cssText = `background:${s.dataset.c};transform:${s.dataset.c === currentColour ? 'scale(1.3);box-shadow:0 0 0 2px white,0 0 0 4px '+currentColour : 'scale(1)'};`);
      });
    });

    clearBtn.addEventListener('click', () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      splatCount = 0;
      msgEl.textContent = 'Fresh canvas! Go wild 🎨';
      setTimeout(() => msgEl.textContent = '', 1000);
    });

    function splat(x, y) {
      splatCount++;
      const r = 12 + Math.random() * 22;

      // Main blob
      ctx.save();
      ctx.globalAlpha = 0.75 + Math.random() * 0.2;
      ctx.fillStyle = currentColour;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();

      // Drips
      for (let d = 0; d < 5; d++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = r * (0.6 + Math.random() * 1.2);
        const dr = 4 + Math.random() * 10;
        ctx.globalAlpha = 0.5 + Math.random() * 0.3;
        ctx.beginPath();
        ctx.arc(x + Math.cos(angle) * dist, y + Math.sin(angle) * dist, dr, 0, Math.PI * 2);
        ctx.fill();
      }

      // Splatter specks
      for (let s = 0; s < 8; s++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = r * (1.2 + Math.random() * 2);
        ctx.globalAlpha = 0.3 + Math.random() * 0.4;
        ctx.beginPath();
        ctx.arc(x + Math.cos(angle) * dist, y + Math.sin(angle) * dist, 1.5 + Math.random() * 3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      if (splatCount === 3) msgEl.textContent = 'Looking good! 🎨';
      if (splatCount === 10) msgEl.textContent = 'You\'re an artist! ✨';
      if (splatCount === 20) { msgEl.textContent = 'Absolute masterpiece 🏆'; showGameDone(); }
    }

    function getPos(e) {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const src = e.touches ? e.touches[0] : e;
      return [(src.clientX - rect.left) * scaleX, (src.clientY - rect.top) * scaleY];
    }

    canvas.addEventListener('mousedown', (e) => { painting = true; splat(...getPos(e)); });
    canvas.addEventListener('mousemove', (e) => { if (painting) splat(...getPos(e)); });
    canvas.addEventListener('mouseup', () => { painting = false; });
    canvas.addEventListener('mouseleave', () => { painting = false; });
    canvas.addEventListener('touchstart', (e) => { e.preventDefault(); painting = true; splat(...getPos(e)); });
    canvas.addEventListener('touchmove', (e) => { e.preventDefault(); if (painting) splat(...getPos(e)); });
    canvas.addEventListener('touchend', () => { painting = false; });

    gameTimer = null; // no interval needed
  }

  // ── ATTACH MODAL EVENTS ──────────────────────────────────
  function attachModalEvents() {
    document.getElementById('ds-backdrop').addEventListener('click', () => {
      if (state.currentRisk === 'low') hideModal();
    });

    document.getElementById('ds-btn-dont-buy').addEventListener('click', () => {
      state._modalAllowed = false;
      hideModal(); showToast('Money saved 👍');
    });

    document.getElementById('ds-btn-proceed').addEventListener('click', async () => {
      if (document.getElementById('ds-btn-proceed').disabled) return;
      await safeSend({ type: 'LOG_PURCHASE', data: { amount: state.currentAmount, domain: getDomain(), riskLevel: state.currentRisk } });
      state._modalAllowed = true;
      state._proceeding = true;
      const btn = state._interceptedBtn;
      const form = btn?.closest('form');
      state._interceptedBtn = null;
      hideModal();
      showToast(`💸 ${state.settings?.currency || '£'}${(state.currentAmount || 0).toFixed(2)} logged`);
      setTimeout(() => {
        if (form) { form.__dsFormBlocked = false; form.submit(); }
        else if (btn) { btn.click(); }
        setTimeout(() => { state._proceeding = false; }, 500);
      }, 100);
    });

    // Tab switching
    document.querySelectorAll('.ds-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.ds-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.ds-tab-pane').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(`ds-tab-${tab.dataset.tab}`).classList.add('active');
      });
    });

    // Game picker
    document.querySelectorAll('.ds-game-pick').forEach(btn => {
      btn.addEventListener('click', () => {
        stopGame();
        document.getElementById('ds-game-intro').style.display = 'none';
        const g = btn.dataset.game;
        if (g === 'balloon') startBalloon();
        else if (g === 'fish') startFish();
        else if (g === 'mole') startMole();
        else if (g === 'paint') startPaint();
      });
    });
  }

  // ── MODAL ─────────────────────────────────────────────────────
  function resetReflect() {
    document.querySelectorAll('.ds-reflect-card').forEach((c, i) => c.classList.toggle('active', i === 0));
    document.querySelectorAll('.ds-step-dot').forEach((d, i) => { d.classList.toggle('active', i === 0); d.classList.remove('done'); });
    document.querySelectorAll('.ds-answer-btn').forEach(b => b.classList.remove('selected'));
    const done = document.getElementById('ds-reflect-done');
    if (done) done.classList.remove('active');
    const proceed = document.getElementById('ds-btn-proceed');
    if (proceed) { proceed.disabled = true; proceed.textContent = 'Go ahead'; }
  }

  function advanceReflect(currentCard) {
    const next = currentCard + 1;
    const cards = document.querySelectorAll('.ds-reflect-card');
    const dots = document.querySelectorAll('.ds-step-dot');
    dots[currentCard]?.classList.remove('active');
    dots[currentCard]?.classList.add('done');
    if (next < cards.length) {
      cards[currentCard].classList.remove('active');
      cards[next].classList.add('active');
      dots[next]?.classList.add('active');
    } else {
      cards[currentCard].classList.remove('active');
      document.getElementById('ds-reflect-done')?.classList.add('active');
      const proceed = document.getElementById('ds-btn-proceed');
      if (proceed) { proceed.disabled = false; proceed.textContent = 'Go ahead anyway'; }
    }
  }

  function showModal() {
    if (state.modalVisible) return;
    state.modalVisible = true;
    state._shownForUrl = location.href;

    const candidates = getTopCandidates();
    const topCandidate = candidates[0];
    const highConfidence = topCandidate && topCandidate.confidence >= 3 && candidates.filter(c => c.confidence >= 3).length === 1;

    // If we have a single high-confidence price, skip straight to main modal
    if (highConfidence) {
      _showMainModal(topCandidate.value, getRisk(topCandidate.value, state.settings, state.profile));
    } else {
      // Show price picker first
      _showPricePicker(candidates);
    }
  }

  function _showPricePicker(candidates) {
    const overlay = document.getElementById('ds-modal-overlay');
    const picker = document.getElementById('ds-price-picker');
    const mainModal = document.getElementById('ds-modal');
    picker.style.display = 'block';
    mainModal.style.display = 'none';
    overlay.setAttribute('data-risk', 'medium');

    const c = state.settings?.currency || '£';
    const list = document.getElementById('ds-price-candidates');
    list.innerHTML = '';

    if (candidates.length) {
      candidates.forEach(({ value, source, confidence }) => {
        const btn = document.createElement('button');
        btn.className = 'ds-price-candidate-btn';
        const stars = confidence >= 3 ? '●●●' : confidence === 2 ? '●●○' : '●○○';
        const starClass = confidence >= 3 ? 'high' : confidence === 2 ? 'med' : 'low';
        btn.innerHTML = `
          <span class="ds-candidate-value">${c}${value.toFixed(2)}</span>
          <span class="ds-candidate-source">${source}</span>
          <span class="ds-candidate-conf ds-conf-${starClass}">${stars}</span>`;
        btn.addEventListener('click', () => {
          _showMainModal(value, getRisk(value, state.settings, state.profile));
        });
        list.appendChild(btn);
      });
    } else {
      list.innerHTML = '<div class="ds-no-candidates">No prices detected on this page</div>';
    }

    // Manual entry
    const input = document.getElementById('ds-price-manual-input');
    const confirmBtn = document.getElementById('ds-price-manual-confirm');
    input.value = '';
    input.placeholder = `Enter price (e.g. 49.99)`;

    confirmBtn.onclick = () => {
      const raw = input.value.replace(/[£$€,]/g, '').trim();
      const val = parseFloat(raw);
      if (isNaN(val) || val <= 0) { input.classList.add('ds-input-error'); setTimeout(() => input.classList.remove('ds-input-error'), 600); return; }
      _showMainModal(val, getRisk(val, state.settings, state.profile));
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmBtn.click(); });

    document.getElementById('ds-price-skip').addEventListener('click', () => {
      // No price — just show modal with null
      _showMainModal(null, 'low');
    }, { once: true });

    overlay.classList.add('ds-visible');
  }

  // ── IMPACT ANALYSIS ──────────────────────────────────────────
  function computeImpact(amount, profile) {
    if (!profile || !amount) return null;
    const mn = Math.max(profile.monthly_net || 0, 50);
    const score = profile.score || 0;

    // Approximate score delta: proportional to purchase vs monthly net
    const risk_ratio = amount / mn;
    const raw_delta  = -(risk_ratio * 4); // 1 month's surplus ≈ −4 pts
    const score_delta = Math.max(-30, Math.min(-0.1, raw_delta));
    const projected   = Math.max(0, Math.min(100, score + score_delta));

    // Goals timeline impact
    const goals_impact = (profile.goals || [])
      .sort((a, b) => (a.priority || 99) - (b.priority || 99))
      .slice(0, 3)
      .map(g => {
        const remaining     = Math.max(0, (g.target || 0) - (profile.savings || 0));
        const base_months   = mn > 0 ? Math.max(1, Math.ceil(remaining / mn)) : null;
        const delay_months  = mn > 0 ? Math.max(0, Math.ceil(amount / mn))    : null;
        return { name: g.name, base_months, delay_months };
      });

    return { score, score_delta, projected_score: projected, goals_impact };
  }

  function renderImpactSection(amount, profile) {
    const section = document.getElementById('ds-impact-section');
    if (!section) return;

    const impact = computeImpact(amount, profile);
    if (!impact) { section.style.display = 'none'; return; }

    section.style.display = 'block';

    const cur  = document.getElementById('ds-si-current');
    const proj = document.getElementById('ds-si-projected');
    const delt = document.getElementById('ds-si-delta');

    if (cur)  cur.textContent = impact.score.toFixed(1);
    if (proj) {
      proj.textContent = impact.projected_score.toFixed(1);
      // Color the projected score based on severity
      const drop = Math.abs(impact.score_delta);
      proj.style.color = drop >= 10 ? '#e03131' : drop >= 5 ? '#e67700' : '#495057';
    }
    if (delt) {
      const sign = impact.score_delta > 0 ? '+' : '';
      delt.textContent = `${sign}${impact.score_delta.toFixed(1)} pts`;
      delt.style.color = impact.score_delta < -8 ? '#e03131' : impact.score_delta < -3 ? '#e67700' : '#adb5bd';
    }

    const goalsList = document.getElementById('ds-goals-list');
    if (goalsList) {
      if (!impact.goals_impact.length) {
        goalsList.innerHTML = '<div class="ds-goal-row ds-goal-empty">No goals set — add them in the dashboard.</div>';
      } else {
        goalsList.innerHTML = impact.goals_impact.map(g => {
          if (g.base_months === null) {
            return `<div class="ds-goal-row">
              <span class="ds-goal-name">${g.name}</span>
              <span class="ds-goal-time ds-goal-warn">No surplus to save</span>
            </div>`;
          }
          const after = g.base_months + g.delay_months;
          const sign  = g.delay_months > 0 ? `+${g.delay_months} mo` : '—';
          const cls   = g.delay_months >= 3 ? 'ds-goal-bad' : g.delay_months >= 1 ? 'ds-goal-warn' : '';
          return `<div class="ds-goal-row">
            <span class="ds-goal-name">${g.name}</span>
            <span class="ds-goal-time">${g.base_months} mo <span class="ds-goal-arrow">→</span> ${after} mo</span>
            <span class="ds-goal-delay ${cls}">${sign}</span>
          </div>`;
        }).join('');
      }
    }
  }

  function _showMainModal(amount, risk) {
    const overlay = document.getElementById('ds-modal-overlay');
    const picker = document.getElementById('ds-price-picker');
    const mainModal = document.getElementById('ds-modal');
    picker.style.display = 'none';
    mainModal.style.display = 'block';

    state.currentAmount = amount;
    state.currentRisk = risk;
    overlay.setAttribute('data-risk', risk);

    const c = state.settings?.currency || '£';
    // Use the user's actual monthly_net (income - expenses) from their profile
    // as the "budget" — falls back to settings.monthlyBudget if not yet synced
    const budget = state.profile?.monthly_net || state.settings?.monthlyBudget || 500;
    const spent = state.session?.monthlySpend || 0;
    const left = Math.max(0, budget - spent);
    const afterThis = Math.max(0, left - (amount || 0));

    overlay.querySelector('#ds-modal-risk-badge').textContent = getRiskLabel(risk);
    overlay.querySelector('#ds-modal-risk-badge').className = `ds-risk-${risk}`;
    overlay.querySelector('#ds-modal-amount').textContent = amount ? `${c}${amount.toFixed(2)}` : 'Unknown amount';
    overlay.querySelector('#ds-modal-site').textContent = getDomain();
    overlay.querySelector('#ds-modal-message').textContent = getRiskMsg(amount, risk);

    overlay.querySelector('#ds-ctx-spent').textContent = `${c}${spent.toFixed(0)}`;
    const leftEl = overlay.querySelector('#ds-ctx-left');
    const afterEl = overlay.querySelector('#ds-ctx-after');
    leftEl.textContent = `${c}${left.toFixed(0)}`;
    afterEl.textContent = `${c}${afterThis.toFixed(0)}`;
    leftEl.className  = 'ds-ctx-val' + (left / budget < 0.2 ? ' ds-danger' : left / budget < 0.4 ? ' ds-warn' : '');
    afterEl.className = 'ds-ctx-val' + (afterThis <= 0 ? ' ds-danger' : afterThis < budget * 0.1 ? ' ds-warn' : '');

    // Render shield impact section
    renderImpactSection(amount, state.profile);

    document.querySelectorAll('.ds-tab').forEach((t,i) => t.classList.toggle('active', i===0));
    document.querySelectorAll('.ds-tab-pane').forEach((p,i) => p.classList.toggle('active', i===0));
    stopGame();
    document.getElementById('ds-game-intro').style.display = '';
    document.querySelectorAll('.ds-game-screen').forEach(s => s.classList.remove('active'));
    resetReflect();
    overlay.querySelectorAll('.ds-answer-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const card = parseInt(btn.getAttribute('data-card'));
        overlay.querySelectorAll(`[data-card="${card}"].ds-answer-btn`).forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        setTimeout(() => advanceReflect(card), 350);
      }, { once: true });
    });

    overlay.classList.add('ds-visible');
  }

  function hideModal() {
    stopGame();
    // Clean up any form submit blocks
    document.querySelectorAll('button[__dsIntercepted]').forEach(btn => {
      if (btn.__dsFormCleanup) { btn.__dsFormCleanup(); btn.__dsFormCleanup = null; }
    });
    // Also sweep all intercepted buttons for cleanup
    document.body.querySelectorAll('*').forEach(el => {
      if (el.__dsFormCleanup) { el.__dsFormCleanup(); el.__dsFormCleanup = null; }
    });
    document.getElementById('ds-modal-overlay')?.classList.remove('ds-visible');
    state.modalVisible = false;
    loadState();
  }

  // ── PANEL ─────────────────────────────────────────────────────
  function togglePanel() {}
  function openPanel() {}
  function closePanel() {}

  function refreshHUD() { /* HUD removed */ }

  // ── STATE ─────────────────────────────────────────────────────
  async function loadState() {
    try {
      const data = await safeSend({ type: 'GET_STATE' });
      if (!data) return;
      state.settings = data.settings;
      state.session  = data.session;
      state.history  = data.history;
      state.streak   = data.streak;
      state.profile  = data.profile || null;
      refreshHUD();
    } catch (_) {}
  }

  function manualScan() {
    if (state.scanInProgress) return;
    state.scanInProgress = true;
    state._shownForUrl = null;
    setTimeout(() => { state.scanInProgress = false; }, 900);
    safeSend({ type: 'LOG_INTERCEPT', data: { amount: null, riskLevel: 'unknown', domain: getDomain(), pageTitle: document.title } });
    showModal();
  }

  function showToast(msg, duration = 4000) {
    const container = document.getElementById('ds-toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'ds-toast';
    toast.style.setProperty('--ds-toast-duration', `${(duration / 1000) - 0.3}s`);
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), duration);
  }

  // ── OBSERVERS ─────────────────────────────────────────────────
  let scanDebounce = null;
  const observer = new MutationObserver((mutations) => {
    if (!state.settings?.enabled) return;
    clearTimeout(scanDebounce);

    // Fast path: immediately intercept any new buttons added to the DOM
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        try {
          // Check the node itself and all descendants
          const candidates = node.matches?.('button, input[type="submit"], [role="button"]')
            ? [node] : [];
          node.querySelectorAll?.('button, input[type="submit"], [role="button"]').forEach(b => candidates.push(b));
          candidates.forEach(btn => {
            try {
              if (!isInsideDS(btn) && CHECKOUT_BTNS.some(p => p.test(getButtonText(btn)))) {
                interceptBtn(btn);
              }
            } catch (_) {}
          });
        } catch (_) {}
      }
    }

    // Debounced full scan for anything missed
    scanDebounce = setTimeout(() => { scanButtons(); scanCardInputs(); }, 300);
  });

  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      state._shownForUrl = null; // new page state — allow interception again
      setTimeout(() => { scanButtons(); scanCardInputs(); loadState(); }, 500);
    }
  }).observe(document.documentElement, { subtree: true, childList: true });

  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'MANUAL_SCAN') manualScan();
      if (msg.type === 'STATE_UPDATED') loadState();
      if (msg.type === 'TOGGLE_PANEL') togglePanel();
    });
  } catch (_) {}

  // ── GLOBAL FORM SUBMIT SAFETY NET ─────────────────────────────
  // Catches form submissions that slip past button-level interception
  document.addEventListener('submit', (e) => {
    if (!state.settings?.enabled || state.modalVisible || state._proceeding) return;
    if (state._shownForUrl === location.href) return;
    const form = e.target;
    if (isInsideDS(form)) return;
    // Check if form has a checkout-like submit button
    const submitBtn = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
    if (!submitBtn) return;
    if (CHECKOUT_BTNS.some(p => p.test(getButtonText(submitBtn)))) {
      e.preventDefault();
      e.stopImmediatePropagation();
      safeSend({ type: 'LOG_INTERCEPT', data: { amount: null, riskLevel: 'unknown', domain: getDomain(), pageTitle: document.title } });
      showModal();
    }
  }, true);

  async function init() {
    await loadState();
    buildHUD();
    scanButtons();
    scanCardInputs();
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();
