import { useState } from 'react';
import { api } from '../api.js';

// Generic placeholder icon — search results don't carry a category, so
// this stands in for the category icons shown on the real INE store grid.
function PlaceholderIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2">
      <rect x="6" y="3" width="12" height="18" rx="1.5" />
      <line x1="10" y1="19" x2="14" y2="19" />
    </svg>
  );
}

export default function ProductSearch({ onTracked }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const [trackingId, setTrackingId] = useState(null);
  const [searched, setSearched] = useState(false);

  async function handleSearch(e) {
    e.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    try {
      setResults(await api.search(query));
      setSearched(true);
    } catch (err) {
      alert(`Search failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleTrack(product) {
    const optionName = prompt(`Option to track for "${product.name}"?`, 'default');
    if (!optionName) return;
    setTrackingId(product.storeProductId);
    try {
      await api.track({
        storeProductId: product.storeProductId,
        productName: product.name,
        optionName,
        productUrl: product.url,
      });
      onTracked?.();
    } catch (err) {
      alert(`Tracking failed: ${err.message}`);
    } finally {
      setTrackingId(null);
    }
  }

  return (
    <div>
      <form className="ine-search-bar" onSubmit={handleSearch}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search product name…"
        />
        <button type="submit" disabled={busy}>{busy ? 'Searching…' : 'Search'}</button>
      </form>

      {searched && results.length === 0 && !busy && (
        <div className="ine-empty">No products found for "{query}".</div>
      )}

      {results.length > 0 && (
        <div className="ine-grid">
          {results.map((p) => (
            <div className="ine-card" key={p.storeProductId}>
              <div className="ine-card-icon"><PlaceholderIcon /></div>
              <div className="ine-card-body">
                <div className="ine-card-sku">{p.category || 'PRODUCT'}</div>
                <div className="ine-card-name">{p.name}</div>
                <div className="ine-card-meta">{p.brand} · SKU {p.sku || p.storeProductId}</div>
              </div>
              <button
                className="ine-card-track"
                onClick={() => handleTrack(p)}
                disabled={trackingId === p.storeProductId}
              >
                {trackingId === p.storeProductId ? 'Tracking…' : 'Track →'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}