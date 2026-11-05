// Помічники тестів: ключі для підписаних токенів, підробний Keycloak, збір логів.
import { Writable } from 'node:stream';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { inject } from 'vitest';
import { buildApp } from '../src/app.js';
import { createTokenVerifier, type TokenVerifier } from '../src/auth.js';
import { createDb, type Db } from '../src/db/index.js';
import { LoginTakenError, type CreateSchedulerInput, type KeycloakAdmin } from '../src/keycloak.js';

export const ISSUER = 'http://localhost/idp/realms/lad';

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

/** Власна пара ключів: токени підписуємо самі, сервіс перевіряє їх як справжні. */
export async function createTestTokens() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256' };
  const verifyToken: TokenVerifier = createTokenVerifier({
    issuer: ISSUER,
    clientId: 'web',
    keys: createLocalJWKSet({ keys: [jwk] }),
  });

  async function sign(
    claims: Record<string, unknown>,
    { issuer = ISSUER, expiresIn = '15m', key = privateKey }: { issuer?: string; expiresIn?: string | number; key?: PrivateKey } = {},
  ) {
    return new SignJWT({ azp: 'web', ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer(issuer)
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime(expiresIn)
      .sign(key);
  }

  return {
    verifyToken,
    sign,
    sysadmin: () => sign({ preferred_username: 'sysadmin', realm_access: { roles: ['sysadmin'] } }),
    scheduler: () =>
      sign({
        preferred_username: 'demo',
        school_id: '5d0b6a1e-7c3f-4b2a-9e41-0a1d2c3b4e5f',
        realm_access: { roles: ['scheduler'] },
      }),
  };
}

/** Keycloak у пам'яті: пам'ятає створених і видалених користувачів. */
export class FakeKeycloak implements KeycloakAdmin {
  readonly users = new Map<string, CreateSchedulerInput & { userId: string }>();
  readonly deleted: string[] = [];
  failCreateWith: Error | null = null;

  async createScheduler(input: CreateSchedulerInput) {
    if (this.failCreateWith) throw this.failCreateWith;
    if ([...this.users.values()].some((u) => u.login === input.login)) throw new LoginTakenError(input.login);
    const userId = crypto.randomUUID();
    this.users.set(userId, { ...input, userId });
    return { userId };
  }

  async deleteUser(userId: string) {
    this.users.delete(userId);
    this.deleted.push(userId);
  }
}

/** Лог застосунку в пам'ять — щоб перевірити, що пароль у нього не потрапляє. */
export function captureLogs() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, logger: { level: 'debug', stream, redact: ['req.headers.authorization', 'temporary_password', '*.temporary_password'] } };
}

export const appDb = (): Db => createDb(inject('pg').app, 4);

export async function testApp(opts: { keycloak?: KeycloakAdmin; db?: Db } = {}) {
  const tokens = await createTestTokens();
  const keycloak = opts.keycloak ?? new FakeKeycloak();
  const db = opts.db ?? appDb();
  const logs = captureLogs();
  const app = buildApp({ db, keycloak, verifyToken: tokens.verifyToken, logger: logs.logger });
  await app.ready();
  return { app, db, keycloak, tokens, logs };
}

export const uniqueLogin = (prefix = 'school') => `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
