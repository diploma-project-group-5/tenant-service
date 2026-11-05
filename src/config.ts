// Конфігурація з змінних середовища. Усі обов'язкові змінні перевіряються при старті:
// сервіс не запускається з неповним .env і називає, чого бракує.

export interface Config {
  host: string;
  port: number;
  logLevel: string;
  /** Підключення робочою роллю tenant_app (лише DML, без BYPASSRLS). */
  databaseUrl: string;
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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing: string[] = [];
  const required = (name: string): string => {
    const value = env[name];
    if (!value) missing.push(name);
    return value ?? '';
  };

  const config: Config = {
    host: env.HOST ?? '0.0.0.0',
    port: Number(env.PORT ?? 3001),
    logLevel: env.LOG_LEVEL ?? 'info',
    databaseUrl: required('DATABASE_URL'),
    oidcIssuer: required('OIDC_ISSUER'),
    oidcJwksUrl: required('OIDC_JWKS_URL'),
    oidcClientId: env.OIDC_CLIENT_ID ?? 'web',
    keycloakUrl: required('KEYCLOAK_URL'),
    keycloakRealm: env.KEYCLOAK_REALM ?? 'lad',
    tenantClientId: env.TENANT_CLIENT_ID ?? 'tenant-service',
    tenantClientSecret: required('TENANT_CLIENT_SECRET'),
  };

  if (missing.length > 0) {
    throw new Error(`Не задано змінні середовища: ${missing.join(', ')} (див. .env.example)`);
  }
  if (!Number.isInteger(config.port) || config.port <= 0) {
    throw new Error(`PORT має бути цілим числом, отримано: ${env.PORT}`);
  }
  return config;
}
