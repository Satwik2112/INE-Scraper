import { chromium as baseChromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import dotenv from 'dotenv';
dotenv.config();

baseChromium.use(StealthPlugin());

const MAX_RETRIES = parseInt(process.env.SCRAPE_MAX_RETRIES || '5', 10);
const NAV_TIMEOUT = parseInt(process.env.SCRAPE_NAV_TIMEOUT_MS || '25000', 10);
const HEADLESS = process.env.HEADLESS !== 'false';

// Confirmed from the site's shipped CSS (index-a0Mp7OCs.css) — this is a
// client-rendered React app, so a saved/view-source HTML always shows only
// the empty <div id="root">; nothing here can be read without executing JS.
const SELECTORS = {
  offerPanel: '.offer-panel',
  // CONFIRMED live (2026-09-26): .price-value and .amount are both hidden
  // honeypots holding fake numbers (aria-hidden/display:none). The real,
  // visible price sits in a <data> tag inside .offer-row, carrying a
  // randomized first class (changes every page load) plus a stable second
  // class "fgy-x1" (confirmed unchanged across loads/items). Target by
  // tag + stable class, never by the randomized token or by .price-value.
  price: '.offer-row data.fgy-x1',
  stockPill: '.avail-pill',
  stockYesClass: 'avail-yes',
  stockNoClass: 'avail-no',
  // Confirmed live in two separate DOM captures: the struck-through
  // "original" price carries this same stable class both times — used as
  // a fallback when the live-price handshake gate can't be passed.
  originalPrice: '.rwq-x1',
  optionAxis: '.opt-picker',
  optionChip: '.opt-chip',
  optionChipOnClass: 'opt-chip-on',
  consentScrim: '.consent-scrim',
  consentBox: '.consent-box',
  consentButtons: '.consent-btns button, .consent-btns .ctl',
  // .offer-panel ships 3 state classes: offer-ready, offer-failed, offer-locked.
  // Don't trust .price-value until the panel is in offer-ready.
  offerReadyClass: 'offer-ready',
  offerFailedClass: 'offer-failed',
  offerLockedClass: 'offer-locked',
  // Confirmed live: offer-locked renders <p class="offer-msg">Price locked</p>
  // <p class="offer-submsg">Hover over the price area to load the current
  // price.</p> plus a *disabled* <button class="ctl ctl-main">Check today's
  // price</button>. The load is triggered by a mouse hover over the panel,
  // not a click — the button only becomes usable afterward.
  retryButton: '.offer-panel .ctl-main',
  productCard: '.card',
  cardTitle: '.card-title',
  cardOpenButton: '.card-open',
  blockedMarkers: [
    'access denied',
    'are you human',
    'just a moment',
    'checking your browser',
    'unusual traffic',
    'captcha',
  ],
};

const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Confirmed live via diagnostics: locator.hover() (a single-jump mouse
// teleport) never triggers the site's load — 30 attempts, 0 requests fired.
// The "hover over the price area" gate needs a real path of mousemove
// events, not just a final position. Walk there in small steps instead.
async function realHover(page, targetLocator) {
  const box = await targetLocator.boundingBox().catch(() => null);
  if (!box) return false;
  const targetX = box.x + box.width / 2;
  const targetY = box.y + box.height / 2;
  const startX = Math.max(0, targetX - 250 - Math.random() * 150);
  const startY = Math.max(0, targetY - 150 - Math.random() * 100);

  await page.mouse.move(startX, startY).catch(() => {});
  const steps = 15 + Math.floor(Math.random() * 10);
  for (let i = 1; i <= steps; i++) {
    const x = startX + (targetX - startX) * (i / steps) + (Math.random() * 4 - 2);
    const y = startY + (targetY - startY) * (i / steps) + (Math.random() * 4 - 2);
    await page.mouse.move(x, y).catch(() => {});
    await sleep(15 + Math.random() * 20);
  }
  // Dwell on target with tiny jitter, in case it also wants sustained hover.
  await sleep(200 + Math.random() * 200);
  await page.mouse.move(targetX + 1, targetY + 1).catch(() => {});
  await sleep(200 + Math.random() * 300);
  return true;
}

// Confirmed live from diagnose.js payload capture: the site fingerprints
// the hover interaction (att.ix: hoverAt, dwellMs, moves[], clickAt,
// trusted) and sends it with every attempt. Retrying without a fresh
// mouse-away-then-back cycle reuses the SAME stale moves[]/hoverAt across
// every retry (confirmed: identical across 5 straight attempts) with only
// clickAt advancing — dwellMs ballooning to 40+ seconds of "hovering" with
// zero movement. That is a textbook automation signature. Move away between
// attempts so each one gets its own honest, short interaction record.
async function moveMouseAway(page) {
  const x = 20 + Math.random() * 40;
  const y = 20 + Math.random() * 40;
  await page.mouse.move(x, y).catch(() => {});
}

// Random human-like pause so timing doesn't look scripted.
async function humanDelay(min = 300, max = 1200) {
  await sleep(min + Math.random() * (max - min));
}

// Real content sits in the live DOM as laid out; decoys are typically
// hidden via CSS rather than removed. Filter those out before reading text.
async function isGenuinelyVisible(locator) {
  return locator.evaluate((el) => {
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity) === 0) return false;
    if (rect.width === 0 || rect.height === 0) return false;
    // off-screen decoys (common trap: position them far outside viewport)
    if (rect.top > 20000 || rect.left > 20000 || rect.top < -20000) return false;
    return true;
  }).catch(() => false);
}

async function firstVisibleText(page, selector) {
  const locator = page.locator(selector);
  const count = await locator.count();
  for (let i = 0; i < count; i++) {
    const el = locator.nth(i);
    if (await isGenuinelyVisible(el)) {
      const text = (await el.innerText().catch(() => null))?.trim();
      if (text) return text;
    }
  }
  return null;
}

function parsePrice(raw) {
  if (!raw) return null;
  const match = raw.replace(/,/g, '').match(/[\d]+(\.\d+)?/);
  return match ? parseFloat(match[0]) : null;
}

function looksBlocked(title, bodyText) {
  const haystack = `${title} ${bodyText}`.toLowerCase();
  return SELECTORS.blockedMarkers.some((m) => haystack.includes(m));
}

async function newStealthContext(browser) {
  return browser.newContext({
    userAgent: pick(UA_POOL),
    viewport: { width: 1280 + Math.floor(Math.random() * 200), height: 800 },
    locale: 'en-US',
    timezoneId: 'Asia/Kolkata',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });
}

/**
 * Scrapes one tracked product/option once, with internal retries.
 * Returns { outcome: 'success'|'retried'|'failed', attempts, price, stock, error }
 * Never throws — failures are captured and reported honestly.
 */
export async function scrapeProduct({ productUrl, optionName }) {
  const start = Date.now();
  let lastError = null;
  let browser;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let context;
    try {
      if (!browser) {
        browser = await baseChromium.launch({
          headless: HEADLESS,
          args: [
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage',
          ],
        });
      }
      context = await newStealthContext(browser);
      const page = await context.newPage();
      page.setDefaultTimeout(NAV_TIMEOUT);

      // The panel's own "Retrying (attempt N/6)... Store responded with
      // 'upstream 429'" behaviour is the SPA's *internal* retry loop hitting
      // a real rate limit — confirmed live. Hammering it with more hovers/
      // clicks right after just re-triggers the same 429. Listen at the
      // network level so we can back off by the real Retry-After instead.
      // Also confirmed live: /api/v2/handshake returns 200 twice then 401
      // ("Unauthorized") — the session token expires/invalidates mid-page,
      // and no amount of in-page retry fixes that; only a fresh browser
      // context (new cookies/session) gets a clean handshake again.
      let retryAfterMs = 0;
      let consecutive429s = 0;
      let handshakeInvalid = false;
      page.on('response', (response) => {
        const status = response.status();
        const url = response.url();
        if (status === 429) {
          consecutive429s++;
          const header = response.headers()['retry-after'];
          const parsed = header ? parseInt(header, 10) * 1000 : NaN;
          retryAfterMs = Number.isFinite(parsed)
            ? parsed
            : Math.min(15000 * consecutive429s, 120000); // 15s, 30s, 45s... capped at 2min
        }
        if (status === 401 && url.includes('handshake')) {
          handshakeInvalid = true;
        }
      });

      await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      await humanDelay();

      const title = await page.title().catch(() => '');
      const bodyText = await page.locator('body').innerText().catch(() => '');
      if (looksBlocked(title, bodyText)) {
        throw new Error(`Blocked page detected (attempt ${attempt}): "${title}"`);
      }

      // Dismiss the consent/gate modal if it renders — its scrim sits over
      // the page and the offer panel won't settle while it's up.
      const consentBox = page.locator(SELECTORS.consentBox).first();
      if (await consentBox.count().catch(() => 0)) {
        const btn = page.locator(SELECTORS.consentButtons).first();
        if (await btn.count().catch(() => 0)) {
          await btn.click({ timeout: 5000 }).catch(() => {});
          await humanDelay(300, 700);
        }
      }

      // Select the requested option chip by its visible text if present.
      if (optionName) {
        const optionLocator = page
          .locator(SELECTORS.optionChip)
          .filter({ hasText: optionName })
          .first();
        if (await optionLocator.count().catch(() => 0)) {
          await optionLocator.click({ timeout: 5000 }).catch(() => {});
          await humanDelay(400, 900);
        }
      }

      // The offer panel carries its own state class — don't trust the price
      // until it's out of "locked"/loading and into offer-ready or offer-failed.
      // offer-failed has an in-page Retry button (simulated flaky response,
      // not a bot wall) — click it up to INNER_RETRIES times before giving
      // up and falling through to a full outer retry (new context).
      const panel = page.locator(SELECTORS.offerPanel).first();
      const INNER_RETRIES = 6;
      let panelClass = '';
      let innerUsed = 1;
      for (let inner = 1; inner <= INNER_RETRIES; inner++) {
        innerUsed = inner;

        // BUG FIX (2026-09-26): the old condition here was satisfied by
        // 'offer-locked' itself — the state already present BEFORE any
        // hover — so it never actually waited for a real transition. It
        // returned almost instantly every time, we read the class before
        // the hover's network round-trip (confirmed 2-9s+ in diagnose.js)
        // had any chance to finish, saw unchanged offer-locked, and looped
        // again without ever giving one attempt time to resolve. This was
        // very likely the real cause of most of the flakiness/failures
        // seen across every theory tested so far, independent of them.
        // Fix: wait specifically for a transition AWAY from offer-locked
        // (into ready or failed), with a real timeout for that round-trip.
        await page.waitForFunction(
          (sel) => {
            const el = document.querySelector(sel);
            return el && (el.classList.contains('offer-ready') || el.classList.contains('offer-failed'));
          },
          SELECTORS.offerPanel,
          { timeout: 12000 }
        ).catch(() => {});
        await humanDelay(300, 600);

        panelClass = (await panel.getAttribute('class').catch(() => '')) || '';
        console.log(`  [outer ${attempt}/${MAX_RETRIES}] [inner ${inner}/${INNER_RETRIES}] panel="${panelClass}"`);
        if (panelClass.includes(SELECTORS.offerReadyClass)) break;
        if (inner === INNER_RETRIES) break;

        // CONFIRMED live (diagnose.js, 2026-09-26): reloading between
        // retries LOCKS the pricing feature entirely (0 handshake calls
        // fired at all afterward) — site detects reload-type navigation
        // and refuses to re-arm hover-to-load. Reverted; staying on the
        // same page for all inner retries, same as before.
        let waitMs = 0;
        if (retryAfterMs > 0) {
          waitMs = retryAfterMs;
          retryAfterMs = 0;
        }
        if (handshakeInvalid) {
          handshakeInvalid = false;
          waitMs = Math.max(waitMs, 2000 + Math.random() * 2000);
        }
        await moveMouseAway(page);
        if (waitMs > 0) await sleep(waitMs);
        await sleep(150 + Math.random() * 250);

        // Fresh hover path every single retry — never reuse a prior one.
        await realHover(page, panel);
        const btn = page.locator(SELECTORS.retryButton).first();
        const isDisabled = await btn.isDisabled().catch(() => true);
        if (!isDisabled) {
          await sleep(150 + Math.random() * 300);
          await btn.click({ timeout: 5000 }).catch(() => {});
        }
      }

      const liveGateFailed =
        panelClass.includes(SELECTORS.offerFailedClass) || panelClass.includes(SELECTORS.offerLockedClass);

      if (liveGateFailed) {
        // CONFIRMED live (2026-09-26): live handshake gate fails 100% of
        // the time on this store (deterministic challenge_failed — not the
        // site's advertised occasional flakiness): a canvas/GL fingerprint
        // + WASM proof-of-work + mouse-interaction attestation check that
        // isn't defeatable in the time available.
        //
        // This is logged honestly as a real failure — price/stock stay
        // null, outcome 'failed' — per the assignment's own spec ("Failed
        // attempts must be included, with price and stock left empty").
        // Labeling a stale/non-live price as 'success' or 'retried' would
        // silently freeze the price-history chart on one number forever,
        // which is the misleading-signal problem the brief explicitly
        // warns against. The page's own struck-through "listed" price is
        // still surfaced separately as `listedPriceHint` — NOT written to
        // scrape_log/CSV — so the dashboard can show it labeled "not live"
        // without corrupting the honest scrape history.
        const staleText = await firstVisibleText(page, SELECTORS.originalPrice);
        const listedPriceHint = parsePrice(staleText);
        await context.close();
        await browser.close();
        return {
          outcome: 'failed',
          attempts: attempt + innerUsed - 1,
          price: null,
          stock: null,
          listedPriceHint,
          error: `Live price gate failed (${panelClass.includes('offer-failed') ? 'offer-failed' : 'offer-locked'}) after ${INNER_RETRIES} in-page retries — canvas/GL fingerprint + WASM proof-of-work + mouse-attestation challenge, confirmed deterministic. Page's listed (non-live) price: ${listedPriceHint ?? 'not found'}.`,
          durationMs: Date.now() - start,
        };
      }
      if (!panelClass.includes(SELECTORS.offerReadyClass)) {
        throw new Error(`Offer panel never reached ready state (attempt ${attempt}): class="${panelClass}"`);
      }

      const priceText = await firstVisibleText(page, SELECTORS.price);
      const price = parsePrice(priceText);

      const stockPill = page.locator(SELECTORS.stockPill).first();
      const stockClass = (await stockPill.getAttribute('class').catch(() => '')) || '';
      const stockText = stockClass.includes(SELECTORS.stockYesClass)
        ? 'in_stock'
        : stockClass.includes(SELECTORS.stockNoClass)
        ? 'out_of_stock'
        : await firstVisibleText(page, SELECTORS.stockPill);

      await context.close();

      if (price == null) {
        throw new Error(`Price element found but unparsable/absent (attempt ${attempt})`);
      }

      await browser.close();
      return {
        outcome: attempt === 1 && innerUsed === 1 ? 'success' : 'retried',
        attempts: attempt + innerUsed - 1,
        price,
        stock: stockText || null,
        error: null,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      lastError = err.message || String(err);
      if (context) await context.close().catch(() => {});
      // Backoff before retrying — longer each time, small jitter to avoid
      // synchronised retry patterns that are themselves a bot signal.
      const backoff = 1500 * attempt + Math.random() * 700;
      await sleep(backoff);
    }
  }

  if (browser) await browser.close().catch(() => {});
  return {
    outcome: 'failed',
    attempts: MAX_RETRIES,
    price: null,
    stock: null,
    error: lastError,
    durationMs: Date.now() - start,
  };
}

/**
 * Searches the store for products matching a query. Used by the
 * product-selection endpoint. Returns [{ storeProductId, name, url }].
 *
 * CONFIRMED live (2026-09-26, DevTools capture): the store has no real
 * search endpoint — the old approach opened every card one at a time via
 * a headless browser (click -> read URL -> go back), which is why it was
 * so slow. The home page's own product grid is fed by a plain JSON API,
 * GET /api/v2/listings?page=N&limit=20, returning id/slug/name/brand/
 * category/sku directly — no browser, no clicking, no bot gate (it's the
 * same data the homepage grid renders from). Fetching all pages (48 pages
 * x 20 = 960 products) with plain HTTP and filtering client-side is far
 * faster than the old per-card click approach.
 */
export async function searchStore(query) {
  const base = process.env.STORE_BASE_URL;
  const q = (query || '').trim().toLowerCase();
  if (!q) return [];

  async function fetchPage(p) {
    try {
      const res = await fetch(`${base}/api/v2/listings?page=${p}&limit=20`);
      if (!res.ok) return null;
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) return null; // error page, not JSON
      return await res.json();
    } catch {
      return null;
    }
  }

  const first = await fetchPage(1);
  if (!first) throw new Error('Could not reach listings API (page 1 failed)');
  const totalPages = first.totalPages || 1;

  // Firing all pages at once overwhelms the demo server (confirmed: one
  // request in a 48-way burst came back as an HTML error page instead of
  // JSON). Batch them instead — a handful at a time, small gap between
  // batches.
  const BATCH_SIZE = 6;
  const pages = [first];
  for (let start = 2; start <= totalPages; start += BATCH_SIZE) {
    const batchNums = [];
    for (let p = start; p < Math.min(start + BATCH_SIZE, totalPages + 1); p++) batchNums.push(p);
    const batchResults = await Promise.all(batchNums.map(fetchPage));
    pages.push(...batchResults.filter(Boolean));
    if (start + BATCH_SIZE <= totalPages) await sleep(150);
  }

  const all = pages.flatMap((p) => p.results || []);
  const matches = all.filter((item) => {
    const haystack = `${item.name} ${item.brand} ${item.category} ${item.sku}`.toLowerCase();
    return haystack.includes(q);
  });

  return matches.map((item) => ({
    storeProductId: String(item.id),
    name: item.name,
    brand: item.brand,
    category: item.category,
    sku: item.sku,
    url: `${base}/item/${item.id}`,
  }));
}