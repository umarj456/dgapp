import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../../db.js';
import { userFromToken, type AuthUser } from './service.js';

declare module 'fastify' {
  interface FastifyRequest { user?: AuthUser }
}

export function authenticate(db: Db) {
  return async function auth(req: FastifyRequest, reply: FastifyReply) {
    const h = req.headers.authorization;
    const token = h?.startsWith('Bearer ') ? h.slice(7) : undefined;
    const user = token ? await userFromToken(db, token) : null;
    if (!user) return reply.code(401).send({ error: 'unauthenticated' });
    if (user.status !== 'active') return reply.code(403).send({ error: 'account_suspended' });
    req.user = user;
  };
}
