import express from 'express';
import { supabase } from '../db.js';
import { scrapeProduct } from '../scraper/scraper.js';

const router = express.Router();

// POST /api/scrape/run  header: x-cron-secret
// Called by the external cron service (e.g. cron-job.org) every 2 hours.
router.post('/run', async (req, res) => {
  if (req.header('x-cron-secret') !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { data: products, error } = await supabase
    .from('tracked_products')
    .select('*')
    .eq('is_active', true);
  if (error) return res.status(500).json({ error: error.message });

  const results = [];
  for (const product of products) {
    const result = await scrapeProduct({
      productUrl: product.product_url,
      optionName: product.option_name,
    });
    await supabase.from('scrape_log').insert({
      tracked_product_id: product.id,
      outcome: result.outcome,
      attempt_count: result.attempts,
      price: result.price,
      stock: result.stock,
      error_message: result.error,
      duration_ms: result.durationMs,
    });
    results.push({ productId: product.id, ...result });
  }

  res.json({ scraped: results.length, results });
});

export default router;
