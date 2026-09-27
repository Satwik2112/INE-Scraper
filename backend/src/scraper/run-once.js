import { supabase } from '../db.js';
import { scrapeProduct } from './scraper.js';

async function runAllDueScrapes() {
  const { data: products, error } = await supabase
    .from('tracked_products')
    .select('*')
    .eq('is_active', true);

  if (error) {
    console.error('Failed to load tracked products:', error.message);
    process.exit(1);
  }

  console.log(`Scraping ${products.length} tracked product(s)...`);

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
      console.error(`Log insert failed for ${product.product_name}:`, insertErr.message);
    }

    console.log(
      `[${product.product_name} / ${product.option_name}] ${result.outcome} ` +
        `(attempts=${result.attempts}, price=${result.price}, stock=${result.stock}, err=${result.error || 'none'})`
    );
  }
}

runAllDueScrapes()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Unhandled scrape run failure:', err);
    process.exit(1);
  });
