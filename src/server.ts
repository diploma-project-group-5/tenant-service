// Точка входу: npm run dev (локально) або node dist/server.js (контейнер).
import { buildApp } from './app.js';
import { createTokenVerifier, remoteKeys } from './auth.js';
import { loadConfig } from './config.js';
import { createDb } from './db/index.js';
import { createKeycloakAdmin } from './keycloak.js';

const config = loadConfig();
const db = createDb(config.databaseUrl);

const app = buildApp({
  db,
  keycloak: createKeycloakAdmin({
    baseUrl: config.keycloakUrl,
    realm: config.keycloakRealm,
    clientId: config.tenantClientId,
    clientSecret: config.tenantClientSecret,
  }),
  verifyToken: createTokenVerifier({
    issuer: config.oidcIssuer,
    clientId: config.oidcClientId,
    keys: remoteKeys(config.oidcJwksUrl),
  }),
  logger: { level: config.logLevel, redact: ['req.headers.authorization', 'temporary_password', '*.temporary_password'] },
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'зупинка');
  await app.close();
  await db.destroy();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.host, port: config.port });
