import express from 'express';
import { supabase } from '../db.js';

const router = express.Router();

function csvEscape(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// GET /api/export/csv — full scrape history across all tracked products
router.get('/csv', async (_req, res) => {
  const { data: products, error: pErr } = await supabase.from('tracked_products').select('*');
  if (pErr) return res.status(500).json({ error: pErr.message });

  const { data: logs, error: lErr } = await supabase
    .from('scrape_log')
    .select('*')
    .order('attempted_at', { ascending: true });
  if (lErr) return res.status(500).json({ error: lErr.message });

  const productMap = Object.fromEntries(products.map((p) => [p.id, p]));

  const header = [
    'store_product_id',
    'product_name',
    'option',
    'timestamp_utc',
    'price',
    'stock',
    'outcome',
  ];
  const rows = logs.map((log) => {
    const p = productMap[log.tracked_product_id] || {};
    return [
      p.store_product_id || '',
      p.product_name || '',
      p.option_name || '',
      new Date(log.attempted_at).toISOString(),
      log.outcome === 'failed' ? '' : log.price,
      log.outcome === 'failed' ? '' : log.stock,
      log.outcome,
    ];
  });

  const csv = [header, ...rows].map((r) => r.map(csvEscape).join(',')).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="scrape_history.csv"');
  res.send(csv);
});

export default router;
