import { chromium as baseChromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

// CONFIRMED live: without stealth, hover never even arms the feature (0
// handshake calls at all) — site checks navigator.webdriver and blocks
// outright without it. Stealth is required just to reach the handshake.
baseChromium.use(StealthPlugin());

// Usage:
//   node src/scraper/diagnose.js <item-url> [optionName] [attempts]
// Example:
//   node src/scraper/diagnose.js https://demo.inelabteamdev.com/item/2713 "Standard" 30
const [, , itemUrlArg, optionNameArg, attemptsArg] = process.argv;
const ITEM_URL = itemUrlArg || process.env.STORE_BASE_URL;
const OPTION_NAME = optionNameArg || null;
const ATTEMPTS = parseInt(attemptsArg || '30', 10);
const HEADLESS = process.env.HEADLESS === 'true'; // default headed for this script

if (!ITEM_URL) {
  console.error('Usage: node diagnose.js <item-url> [optionName] [attempts]');
  process.exit(1);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Same fix as scraper.js — a single-jump hover never triggers the load.
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
  await sleep(200 + Math.random() * 200);
  await page.mouse.move(targetX + 1, targetY + 1).catch(() => {});
  await sleep(200 + Math.random() * 300);
  return true;
}

async function main() {
  const browser = await baseChromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 850 },
    locale: 'en-US',
    timezoneId: 'Asia/Kolkata',
  });
  const page = await context.newPage();

  // CONFIRMED live: canvas jitter patch (tested) broke hover-trigger
  // entirely — 0 handshake calls fired on any attempt. Site's own script
  // likely reads canvas as part of its own trigger/fingerprint logic;
  // overriding toDataURL interferes with that. Reverted, theory dead.

  const networkLog = [];
  page.on('response', async (response) => {
    const req = response.request();
    const url = response.url();
    // Only log API calls, skip static assets.
    if (!url.includes('/api/')) return;
    let body = null;
    let requestBody = null;
    if (url.includes('handshake')) {
      // This is the thing we actually need — what's inside the successful
      // GET /api/v2/handshake response (and the failing POST, for contrast).
      body = await response.text().catch((e) => `<unreadable: ${e.message}>`);
      requestBody = req.postData();
      console.log(`\n>>> ${req.method()} ${url} -> ${response.status()}`);
      if (requestBody) console.log(`    request body: ${requestBody}`);
      console.log(`    response body: ${body}`);
    }
    networkLog.push({
      t: Date.now(),
      method: req.method(),
      url,
      status: response.status(),
      headers: response.headers(),
      requestBody,
      body,
    });
  });

  console.log(`Loading ${ITEM_URL} ...`);
  await page.goto(ITEM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(1000);

  // Dismiss consent modal if present.
  const consentBox = page.locator('.consent-box').first();
  if (await consentBox.count().catch(() => 0)) {
    await page.locator('.consent-btns button, .consent-btns .ctl').first().click().catch(() => {});
    await sleep(500);
  }

  // Select option if given.
  if (OPTION_NAME) {
    const chip = page.locator('.opt-chip').filter({ hasText: OPTION_NAME }).first();
    if (await chip.count().catch(() => 0)) {
      await chip.click().catch(() => {});
      await sleep(500);
    }
  }

  const panel = page.locator('.offer-panel').first();
  const attemptLog = [];

  for (let i = 1; i <= ATTEMPTS; i++) {
    const beforeCount = networkLog.length;
    const startedAt = Date.now();

    // CONFIRMED live: reloading between attempts locks the pricing feature
    // entirely (0 handshake calls fired at all, every attempt) — the site
    // detects reload-type navigation and refuses to arm hover-to-load after
    // one. Reverted. Staying on the same page/session for all retries.
    await page.mouse.move(20 + Math.random() * 40, 20 + Math.random() * 40).catch(() => {});
    await sleep(150 + Math.random() * 250);
    await realHover(page, panel);

    const btn = page.locator('.offer-panel .ctl-main').first();
    const disabled = await btn.isDisabled().catch(() => true);
    if (!disabled) {
      await sleep(400 + Math.random() * 400);
      await btn.click({ timeout: 5000 }).catch(() => {});
    }

    // Wait for panel to settle into a terminal state for this round.
    await page
      .waitForFunction(
        () => {
          const el = document.querySelector('.offer-panel');
          return el && ['offer-ready', 'offer-failed', 'offer-locked'].some((c) => el.classList.contains(c));
        },
        { timeout: 15000 }
      )
      .catch(() => {});
    await sleep(400);

    const panelClass = (await panel.getAttribute('class').catch(() => '')) || '';
    const submsg = (await page.locator('.offer-submsg').first().innerText().catch(() => '')) || '';
    const priceText = panelClass.includes('offer-ready')
      ? (await page.locator('.price-value').first().innerText().catch(() => '')) || ''
      : '';

    const roundEvents = networkLog.slice(beforeCount);
    const durationMs = Date.now() - startedAt;

    attemptLog.push({
      attempt: i,
      panelClass,
      submsg,
      priceText,
      durationMs,
      requests: roundEvents.map((e) => ({ status: e.status, url: e.url.replace(ITEM_URL.split('/item')[0], '') })),
    });

    console.log(
      `[${i}/${ATTEMPTS}] class="${panelClass}" submsg="${submsg}" price="${priceText}" ` +
        `(${durationMs}ms, ${roundEvents.map((e) => e.status).join(',')})`
    );

    if (panelClass.includes('offer-ready')) {
      console.log('  -> READY. Stopping early.');
      break;
    }

    // Small human-ish pause before next attempt.
    await sleep(800 + Math.random() * 800);
  }

  await browser.close();

  // Summarise per-endpoint status counts.
  const summary = {};
  for (const e of networkLog) {
    const endpoint = e.url.split('/api/')[1]?.split('?')[0] || e.url;
    summary[endpoint] = summary[endpoint] || {};
    summary[endpoint][e.status] = (summary[endpoint][e.status] || 0) + 1;
  }

  const outDir = path.resolve('diagnostics');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `run-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ itemUrl: ITEM_URL, optionName: OPTION_NAME, attemptLog, networkLog, summary }, null, 2));

  console.log('\n=== Status summary per endpoint ===');
  for (const [endpoint, statuses] of Object.entries(summary)) {
    console.log(`${endpoint}:`, statuses);
  }
  console.log(`\nFull log written to ${outFile}`);
  console.log('Send me that JSON file.');
}

main().catch((err) => {
  console.error('Diagnose script crashed:', err);
  process.exit(1);
});