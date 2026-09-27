import { useEffect, useState } from 'react';
import { api } from '../api.js';
import PriceChart from './PriceChart.jsx';
import ScrapeLog from './ScrapeLog.jsx';

export default function TrackedProducts({ refreshKey }) {
  const [products, setProducts] = useState([]);
  const [histories, setHistories] = useState({});
  const [expanded, setExpanded] = useState(null);

  useEffect(() => {
    api.list().then(setProducts).catch(console.error);
  }, [refreshKey]);

  async function toggle(id) {
    if (expanded === id) return setExpanded(null);
    setExpanded(id);
    if (!histories[id]) {
      const h = await api.history(id);
      setHistories((prev) => ({ ...prev, [id]: h }));
    }
  }

  return (
    <div className="tracked-products">
      <h2 className="ine-page-title" style={{ fontSize: '1.2rem', marginTop: 8 }}>Tracked products</h2>
      <div className="toolbar">
        <a href={api.exportCsvUrl()}>
          <button>Export CSV</button>
        </a>
      </div>
      {products.map((p) => (
        <div key={p.id} className="product-card">
          <div className="product-header" onClick={() => toggle(p.id)}>
            <strong>{p.product_name}</strong> ({p.option_name}) —{' '}
            {p.latest ? `₹${p.latest.price} · ${p.latest.stock}` : 'no data yet'}
          </div>
          {expanded === p.id && histories[p.id] && (
            <div className="product-detail">
              <PriceChart history={histories[p.id]} />
              <ScrapeLog history={histories[p.id]} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}