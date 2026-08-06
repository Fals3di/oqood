import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { errorHandler } from 'hono/error-handler';

import { authMiddleware } from './middleware/auth';
import { contractsRouter } from './routes/contracts';
import { assetsRouter } from './routes/assets';
import { usersRouter } from './routes/users';
import { approvalsRouter } from './routes/approvals';
import { webhooksRouter } from './routes/webhooks';
import { reportsRouter } from './routes/reports';

const app = new Hono();

// Global middleware
app.use('*', logger());
app.use('*', cors({
  origin: ['http://localhost:3000', 'http://localhost:3001'],
  credentials: true,
}));
app.use('*', secureHeaders());
app.use('*', errorHandler());

// Public routes
app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

// API v1
const apiV1 = new Hono();

// Authentication (public)
apiV1.use('/auth/*', async (c, next) => {
  // Auth routes don't need auth middleware
  await next();
});

// Protected routes
apiV1.use('/api/*', authMiddleware);

// Route mounting
apiV1.route('/contracts', contractsRouter);
apiV1.route('/assets', assetsRouter);
apiV1.route('/users', usersRouter);
apiV1.route('/approvals', approvalsRouter);
apiV1.route('/webhooks', webhooksRouter);
apiV1.route('/reports', reportsRouter);

app.route('/v1', apiV1);

export default app;
