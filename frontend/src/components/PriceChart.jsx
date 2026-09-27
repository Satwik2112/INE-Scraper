import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

export default function PriceChart({ history }) {
  const points = history
    .filter((h) => h.outcome !== 'failed' && h.price != null)
    .map((h) => ({
      time: new Date(h.attempted_at).toLocaleString(),
      price: h.price,
    }));

  if (!points.length) return <p>No successful scrapes yet.</p>;

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={points}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="time" hide />
        <YAxis domain={['auto', 'auto']} />
        <Tooltip />
        <Line type="monotone" dataKey="price" dot={false} strokeWidth={2} />
      </LineChart>
    </ResponsiveContainer>
  );
}
