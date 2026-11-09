// Дрібні модулі: тимчасовий пароль і конфігурація.
import { describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config.js';
import { generateTemporaryPassword, TEMPORARY_PASSWORD_LENGTH } from '../src/password.js';

describe('тимчасовий пароль', () => {
  test('16 символів, без схожих на вигляд 0 O 1 l I, проходить політику realm (≥ 10)', () => {
    for (let i = 0; i < 200; i++) {
      const p = generateTemporaryPassword();
      expect(p).toHaveLength(TEMPORARY_PASSWORD_LENGTH);
      expect(p).toMatch(/^[A-HJ-NP-Za-km-z2-9]+$/);
    }
  });

  test('кожен раз різний', () => {
    const set = new Set(Array.from({ length: 1000 }, () => generateTemporaryPassword()));
    expect(set.size).toBe(1000);
  });
});

describe('конфігурація', () => {
  const full = {
    DATABASE_URL: 'postgres://x',
    RELAY_DATABASE_URL: 'postgres://r',
    MAINT_DATABASE_URL: 'postgres://m',
    OIDC_ISSUER: 'http://localhost/idp/realms/lad',
    OIDC_JWKS_URL: 'http://keycloak:8080/idp/realms/lad/protocol/openid-connect/certs',
    KEYCLOAK_URL: 'http://keycloak:8080/idp',
    TENANT_CLIENT_SECRET: 's',
  };

  test('значення за замовчуванням', () => {
    expect(loadConfig(full)).toMatchObject({
      port: 3001,
      host: '0.0.0.0',
      oidcClientId: 'web',
      keycloakRealm: 'lad',
      tenantClientId: 'tenant-service',
      kafkaBrokers: [],
      kafkaClientId: 'tenant-service',
      relayIntervalMs: 500,
    });
  });

  test('KAFKA_BROKERS: список через кому, пробіли й порожні елементи відкидаються', () => {
    expect(loadConfig({ ...full, KAFKA_BROKERS: ' kafka:9092, ,localhost:29092 ' }).kafkaBrokers).toEqual(['kafka:9092', 'localhost:29092']);
  });

  test('RELAY_INTERVAL_MS: ціле додатне число', () => {
    expect(loadConfig({ ...full, RELAY_INTERVAL_MS: '250' }).relayIntervalMs).toBe(250);
    expect(() => loadConfig({ ...full, RELAY_INTERVAL_MS: '0' })).toThrow(/RELAY_INTERVAL_MS/);
    expect(() => loadConfig({ ...full, RELAY_INTERVAL_MS: '1.5' })).toThrow(/RELAY_INTERVAL_MS/);
  });

  test('бракує змінних — помилка називає всі', () => {
    expect(() => loadConfig({ DATABASE_URL: 'x' })).toThrow(/RELAY_DATABASE_URL, MAINT_DATABASE_URL, OIDC_ISSUER, OIDC_JWKS_URL, KEYCLOAK_URL, TENANT_CLIENT_SECRET/);
  });

  test('некоректний PORT — помилка', () => {
    expect(() => loadConfig({ ...full, PORT: 'abc' })).toThrow(/PORT/);
  });
});
