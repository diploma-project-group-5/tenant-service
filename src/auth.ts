// Перевірка JWT Keycloak (розділ 07): підпис за JWKS, iss, exp, azp = web, роль.
// iss — публічна адреса Keycloak, а ключі беруться внутрішньою мережею: дві різні змінні.
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { problem, sendProblem } from './problem.js';

export type Role = 'sysadmin' | 'scheduler';

export interface AccessToken extends JWTPayload {
  azp?: string;
  preferred_username?: string;
  school_id?: string;
  realm_access?: { roles?: string[] };
}

export type TokenVerifier = (token: string) => Promise<AccessToken>;

export interface VerifierOptions {
  issuer: string;
  clientId: string;
  /** JWKS віддалено (прод) або локальний набір ключів (тести). */
  keys: JWTVerifyGetKey;
}

export function createTokenVerifier({ issuer, clientId, keys }: VerifierOptions): TokenVerifier {
  return async (token) => {
    const { payload } = await jwtVerify<AccessToken>(token, keys, { issuer, algorithms: ['RS256'] });
    if (payload.azp !== clientId) throw new Error(`azp ${payload.azp ?? '—'} замість ${clientId}`);
    return payload;
  };
}

export const remoteKeys = (jwksUrl: string): JWTVerifyGetKey => createRemoteJWKSet(new URL(jwksUrl));

declare module 'fastify' {
  interface FastifyRequest {
    user?: AccessToken;
  }
}

/** preHandler: лише токен web з потрібною роллю. Без токена або з поганим — 401, без ролі — 403. */
export function requireRole(verify: TokenVerifier, role: Role) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    if (!token) {
      return sendProblem(reply, problem(401, 'unauthorized', 'Потрібен вхід'));
    }
    let user: AccessToken;
    try {
      user = await verify(token);
    } catch (err) {
      request.log.info({ reason: (err as Error).message }, 'токен відхилено');
      return sendProblem(reply, problem(401, 'unauthorized', 'Токен недійсний або прострочений'));
    }
    if (!user.realm_access?.roles?.includes(role)) {
      return sendProblem(reply, problem(403, 'forbidden', 'Недостатньо прав', `Потрібна роль ${role}`));
    }
    request.user = user;
  };
}
