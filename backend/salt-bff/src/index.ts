import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import { db } from './db/pool.js';
import { authMiddleware } from './middleware/auth.js';
import { apiRouter } from './routes/api.js';
import { shutdownRunManager } from './services/runManager.js';

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/api', authMiddleware, apiRouter);

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : 'Unexpected server error';
  const status = /forbidden/i.test(message) ? 403 : /not found/i.test(message) ? 404 : 400;
  res.status(status).json({ error: message });
});

const server = app.listen(env.PORT, () => {
  console.log(`Salt Console BFF listening on :${env.PORT}`);
});

async function shutdown() {
  await shutdownRunManager();
  await db.end();
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
