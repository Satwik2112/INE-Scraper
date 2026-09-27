export default function ScrapeLog({ history }) {
  return (
    <table className="scrape-log">
      <thead>
        <tr>
          <th>Time</th>
          <th>Outcome</th>
          <th>Attempts</th>
          <th>Price</th>
          <th>Stock</th>
          <th>Error</th>
        </tr>
      </thead>
      <tbody>
        {[...history].reverse().map((h) => (
          <tr key={h.id} className={`row-${h.outcome}`}>
            <td>{new Date(h.attempted_at).toLocaleString()}</td>
            <td>{h.outcome}</td>
            <td>{h.attempt_count}</td>
            <td>{h.price ?? '—'}</td>
            <td>{h.stock ?? '—'}</td>
            <td>{h.error_message ?? ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
