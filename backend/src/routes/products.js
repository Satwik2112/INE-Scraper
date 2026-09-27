import express from 'express';
import { supabase } from '../db.js';
import { searchStore, scrapeProduct } from '../scraper/scraper.js';

const router = express.Router();

// GET /api/products/search?q=...
router.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'q is required' });
  try {
    const results = await searchStore(q);
    res.json(results);
  } catch (err) {
    res.status(502).json({ error: 'Search failed', detail: err.message });
  }
});

// POST /api/products/track  { storeProductId, productName, optionName, productUrl }
router.post('/track', async (req, res) => {
  const { storeProductId, productName, optionName, productUrl } = req.body;
  if (!storeProductId || !productName || !optionName || !productUrl) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const { data, error } = await supabase
    .from('tracked_products')
    .insert({
      store_product_id: storeProductId,
      product_name: productName,
      option_name: optionName,
      product_url: productUrl,
    })
    .select()
    .single();

  if (error) return res.status(409).json({ error: error.message });

  // Kick off an immediate scrape so the dashboard has data right away.
  const result = await scrapeProduct({ productUrl, optionName });
  await supabase.from('scrape_log').insert({
    tracked_product_id: data.id,
    outcome: result.outcome,
    attempt_count: result.attempts,
    price: result.price,
    stock: result.stock,
    error_message: result.error,
    duration_ms: result.durationMs,
  });

  res.status(201).json({ product: data, firstScrape: result });
});

// GET /api/products — all tracked products with latest known price/stock
router.get('/', async (_req, res) => {
  const { data: products, error } = await supabase.from('tracked_products').select('*');
  if (error) return res.status(500).json({ error: error.message });

  const { data: latest } = await supabase.from('latest_price').select('*');
  const latestMap = Object.fromEntries((latest || []).map((l) => [l.tracked_product_id, l]));

  res.json(products.map((p) => ({ ...p, latest: latestMap[p.id] || null })));
});

// GET /api/products/:id/history — price/stock history for chart/table
router.get('/:id/history', async (req, res) => {
  const { data, error } = await supabase
    .from('scrape_log')
    .select('*')
    .eq('tracked_product_id', req.params.id)
    .order('attempted_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

export default router;
