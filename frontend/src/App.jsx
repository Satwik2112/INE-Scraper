import { useState } from 'react';
import ProductSearch from './components/ProductSearch.jsx';
import TrackedProducts from './components/TrackedProducts.jsx';

export default function App() {
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <div className="app">
      <header className="ine-header">
        <span className="ine-brand">
          <span className="ine-brand-mark">◼</span> INE Price Tracker
        </span>
        <span className="ine-tagline">Watching prices, honestly.</span>
      </header>
      <main className="ine-main">
        <h1 className="ine-page-title">Browse products</h1>
        <p className="ine-page-sub">Search the store and start tracking a product's price.</p>
        <ProductSearch onTracked={() => setRefreshKey((k) => k + 1)} />
        <TrackedProducts refreshKey={refreshKey} />
      </main>
    </div>
  );
}