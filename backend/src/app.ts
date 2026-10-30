import Fastify from 'fastify';
import { config } from './config.js';
import { pool } from './db.js';
import { makeOtpProvider, type OtpProvider } from './modules/auth/otp-provider.js';
import { authRoutes } from './modules/auth/routes.js';
import { internalRoutes } from './modules/internal-routes.js';
import { userRoutes } from './modules/routes.js';
import { webhookRoutes } from './modules/webhook-routes.js';

export async function buildApp(opts: { otp?: OtpProvider; logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? true, trustProxy: false, bodyLimit: 1_000_000 });
  const otp = opts.otp ?? makeOtpProvider(config.OTP_PROVIDER);

  app.addHook('onRequest', async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', config.WEB_ORIGIN);
    reply.header('Access-Control-Allow-Headers', 'authorization, content-type');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return reply.code(204).send();
  });

  app.get('/healthz', async () => {
    await pool.query('SELECT 1');
    return { ok: true };
  });

  await app.register(async (scope) => {
    await scope.register(userRoutes);
    await scope.register(authRoutes, { otp });
  });
  await app.register(internalRoutes);
  await app.register(webhookRoutes);
  return app;
}
