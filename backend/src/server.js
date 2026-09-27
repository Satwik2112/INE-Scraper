import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import productsRouter from './routes/products.js';
import scrapeRouter from './routes/scrape.js';
import exportRouter from './routes/export.js';
import { startScheduler } from './scheduler.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/api/products', productsRouter);
app.use('/api/scrape', scrapeRouter);
app.use('/api/export', exportRouter);

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`API listening on :${port}`);
  startScheduler();
});
