import { buildApp } from './app.js';
import { config } from './config.js';

const app = await buildApp();
await app.listen({ port: config.PORT, host: config.HOST });
