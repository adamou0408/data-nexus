import express from 'express';
import cors from 'cors';
import { pool } from './db';
import { resolveRouter } from './routes/resolve';
import { checkRouter } from './routes/check';
import { filterRouter } from './routes/filter';
import { matrixRouter } from './routes/matrix';
import { rlsRouter } from './routes/rls-simulate';
import { browseRouter } from './routes/browse';
import { poolRouter } from './routes/pool';

const app = express();
const PORT = parseInt(process.env.PORT || '3001');

app.use(cors());
app.use(express.json());

app.get('/healthz', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'error', message: String(err) });
  }
});

app.use('/api/resolve', resolveRouter);
app.use('/api/check', checkRouter);
app.use('/api/filter', filterRouter);
app.use('/api/matrix', matrixRouter);
app.use('/api/rls', rlsRouter);
app.use('/api/browse', browseRouter);
app.use('/api/pool', poolRouter);

app.listen(PORT, () => {
  console.log(`authz-api listening on http://localhost:${PORT}`);
});
