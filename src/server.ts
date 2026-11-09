// Точка входу: npm run dev (локально) або node dist/server.js (контейнер).
// Один процес: HTTP, relay outbox → Kafka і щоденна чистка outbox.
import { buildApp } from './app.js';
import { createTokenVerifier, remoteKeys } from './auth.js';
import { loadConfig } from './config.js';
import { createDb } from './db/index.js';
import { createProducer } from './kafka/platformatic.js';
import { startRelay, type RelayHandle } from './kafka/relay.js';
import type { Producer } from './kafka/bus.js';
import { createKeycloakAdmin } from './keycloak.js';
import { scheduleCleanup } from './maint.js';

const config = loadConfig();
// Три пули з різними ролями (розділ 03): app — запити, relay — outbox, maint — чистка.
const db = createDb(config.databaseUrl);
const relayDb = createDb(config.relayDatabaseUrl, 2);
const maintDb = createDb(config.maintDatabaseUrl, 1);

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

let producer: Producer | undefined;
let relay: RelayHandle | undefined;
if (config.kafkaBrokers.length > 0) {
  producer = createProducer({ brokers: config.kafkaBrokers, clientId: config.kafkaClientId });
  relay = startRelay(relayDb, producer, app.log.child({ component: 'relay' }), config.relayIntervalMs);
} else {
  app.log.warn('KAFKA_BROKERS не задано: school.registered лишаються в outbox до запуску relay');
}
const stopCleanup = scheduleCleanup(maintDb, app.log.child({ component: 'maint' }));

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'зупинка');
  stopCleanup();
  await app.close();
  await relay?.stop();
  await producer?.close().catch(() => undefined);
  await Promise.allSettled([db.destroy(), relayDb.destroy(), maintDb.destroy()]);
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.host, port: config.port });
