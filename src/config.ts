// Конфігурація з змінних середовища. Усі обов'язкові змінні перевіряються при старті:
// сервіс не запускається з неповним .env і називає, чого бракує.

export interface Config {
  host: string;
  port: number;
  logLevel: string;
  /** Підключення робочою роллю tenant_app (лише DML, без BYPASSRLS). */
  databaseUrl: string;
  /** Роль tenant_relay: лише outbox (другий пул у процесі сервісу). */
  relayDatabaseUrl: string;
  /** Роль tenant_maint: щоденна чистка outbox (третій пул). */
  maintDatabaseUrl: string;
  /** iss у токенах: публічна адреса Keycloak, як її бачить браузер. */
  oidcIssuer: string;
  /** Ключі Keycloak внутрішньою мережею (у compose — http://keycloak:8080/...). */
  oidcJwksUrl: string;
  /** Клієнт, для якого видано токен (azp). */
  oidcClientId: string;
  /** Keycloak внутрішньою мережею для admin API, з /idp. */
  keycloakUrl: string;
  keycloakRealm: string;
  tenantClientId: string;
  tenantClientSecret: string;
  /** Порожньо — Kafka вимкнено: події лишаються в outbox і підуть, щойно relay запуститься. */
  kafkaBrokers: string[];
  kafkaClientId: string;
  /** Пауза між проходами relay, мс. */
  relayIntervalMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing: string[] = [];
  const required = (name: string): string => {
    const value = env[name];
    if (!value) missing.push(name);
    return value ?? '';
  };
  const int = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} має бути додатним цілим числом, отримано: ${raw}`);
    return n;
  };

  const config: Config = {
    host: env.HOST ?? '0.0.0.0',
    port: Number(env.PORT ?? 3001),
    logLevel: env.LOG_LEVEL ?? 'info',
    databaseUrl: required('DATABASE_URL'),
    relayDatabaseUrl: required('RELAY_DATABASE_URL'),
    maintDatabaseUrl: required('MAINT_DATABASE_URL'),
    oidcIssuer: required('OIDC_ISSUER'),
    oidcJwksUrl: required('OIDC_JWKS_URL'),
    oidcClientId: env.OIDC_CLIENT_ID ?? 'web',
    keycloakUrl: required('KEYCLOAK_URL'),
    keycloakRealm: env.KEYCLOAK_REALM ?? 'lad',
    tenantClientId: env.TENANT_CLIENT_ID ?? 'tenant-service',
    tenantClientSecret: required('TENANT_CLIENT_SECRET'),
    kafkaBrokers: (env.KAFKA_BROKERS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    kafkaClientId: env.KAFKA_CLIENT_ID ?? 'tenant-service',
    relayIntervalMs: int('RELAY_INTERVAL_MS', 500),
  };

  if (missing.length > 0) {
    throw new Error(`Не задано змінні середовища: ${missing.join(', ')} (див. .env.example)`);
  }
  if (!Number.isInteger(config.port) || config.port <= 0) {
    throw new Error(`PORT має бути цілим числом, отримано: ${env.PORT}`);
  }
  return config;
}
