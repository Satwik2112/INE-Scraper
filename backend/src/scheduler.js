/**
 * In-process scheduler — keeps a free-tier backend alive and runs
 * scrapes on a configurable interval without needing an external cron
 * service.
 *
 * Env vars (all optional — scheduler is disabled if SCRAPE_INTERVAL_MS
 * is absent or 0):
 *
 *   SCRAPE_INTERVAL_MS   – milliseconds between scrape runs
 *                           e.g. 7200000 = 2 hours  (default: off)
 *   KEEPALIVE_INTERVAL_MS – milliseconds between self-pings to /health
 *                           to prevent free-tier sleep  (default: 600000 = 10 min)
 *   SELF_BASE_URL         – the URL this backend is reachable at
 *                           (default: http://localhost:<PORT>)
 */
import { supabase } from './db.js';
import { scrapeProduct } from './scraper/scraper.js';

let scrapeTimer = null;
let keepaliveTimer = null;

async function runScheduledScrape() {
  const tag = new Date().toISOString();
  console.log(`[scheduler] ${tag} — starting scheduled scrape run`);

  try {
    const { data: products, error } = await supabase
      .from('tracked_products')
      .select('*')
      .eq('is_active', true);

    if (error) {
      console.error(`[scheduler] failed to load tracked products:`, error.message);
      return;
    }
    if (!products.length) {
      console.log(`[scheduler] no active tracked products — skipping`);
      return;
    }

    console.log(`[scheduler] scraping ${products.length} product(s)...`);

    for (const product of products) {
      const result = await scrapeProduct({
        productUrl: product.product_url,
        optionName: product.option_name,
      });

      const { error: insertErr } = await supabase.from('scrape_log').insert({
        tracked_product_id: product.id,
        outcome: result.outcome,
        attempt_count: result.attempts,
        price: result.price,
        stock: result.stock,
        error_message: result.error,
        duration_ms: result.durationMs,
      });

      if (insertErr) {
        console.error(`[scheduler] log insert failed for ${product.product_name}:`, insertErr.message);
      }

      console.log(
        `[scheduler] [${product.product_name} / ${product.option_name}] ` +
          `${result.outcome} (price=${result.price}, stock=${result.stock})`
      );
    }

    console.log(`[scheduler] scrape run complete — ${products.length} product(s) processed`);
  } catch (err) {
    console.error(`[scheduler] unhandled error during scrape run:`, err);
  }
}

function startKeepAlive() {
  const intervalMs = parseInt(process.env.KEEPALIVE_INTERVAL_MS || '600000', 10); // 10 min
  const port = process.env.PORT || 4000;
  const selfUrl = process.env.SELF_BASE_URL || `http://localhost:${port}`;

  console.log(`[keepalive] pinging ${selfUrl}/health every ${(intervalMs / 1000).toFixed(0)}s`);

  keepaliveTimer = setInterval(async () => {
    try {
      const res = await fetch(`${selfUrl}/health`);
      console.log(`[keepalive] pinged /health — ${res.status}`);
    } catch (err) {
      console.warn(`[keepalive] ping failed:`, err.message);
    }
  }, intervalMs);

  // Don't let the keepalive timer prevent graceful shutdown
  if (keepaliveTimer.unref) keepaliveTimer.unref();
}

/**
 * Call once from server.js after app.listen().
 * Does nothing if SCRAPE_INTERVAL_MS is not set.
 */
export function startScheduler() {
  const intervalMs = parseInt(process.env.SCRAPE_INTERVAL_MS || '0', 10);

  if (!intervalMs || intervalMs <= 0) {
    console.log('[scheduler] SCRAPE_INTERVAL_MS not set — scheduler disabled');
    return;
  }

  console.log(
    `[scheduler] will scrape every ${(intervalMs / 1000 / 60).toFixed(1)} minutes ` +
      `(${intervalMs}ms). First run in 5s.`
  );

  // Run immediately on startup (5s grace for server to fully boot), then at each interval
  setTimeout(() => runScheduledScrape(), 5000);

  scrapeTimer = setInterval(runScheduledScrape, intervalMs);

  // Don't let the scrape timer prevent graceful shutdown
  if (scrapeTimer.unref) scrapeTimer.unref();

  // Also start keep-alive self-ping so free tier doesn't sleep
  startKeepAlive();
}

export function stopScheduler() {
  if (scrapeTimer) clearInterval(scrapeTimer);
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  scrapeTimer = null;
  keepaliveTimer = null;
  console.log('[scheduler] stopped');
}
