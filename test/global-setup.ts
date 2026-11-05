// Тестове оточення: PostgreSQL з ролями як у db-init і Keycloak з realm lad.
// За замовчуванням усе піднімається в контейнерах (Testcontainers, потрібен лише Docker).
// Якщо задано TEST_PG_ADMIN_URL / TEST_KEYCLOAK_URL, використовуються вже запущені сервери.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { GenericContainer, Wait } from 'testcontainers';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';
import { migrateToLatest } from '../src/db/migrations.js';

const ROLE_PASSWORD = 'test-role-pass-123';
const ROLES = ['tenant_owner', 'tenant_app', 'tenant_relay', 'tenant_maint'] as const;

const KC_ADMIN_PASSWORD = process.env.TEST_KEYCLOAK_ADMIN_PASSWORD ?? 'test-admin-pass-123';
const TENANT_SECRET = process.env.TEST_TENANT_CLIENT_SECRET ?? 'test-tenant-secret-123';

function withCredentials(baseUrl: string, user: string, password: string, database: string): string {
  const u = new URL(baseUrl);
  u.username = user;
  u.password = password;
  u.pathname = `/${database}`;
  return u.toString();
}

async function prepareDatabase(adminUrl: string, database: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    // Ролі — як у platform/db-init: без SUPERUSER і без BYPASSRLS.
    for (const role of ROLES) {
      await client.query(
        `DO $$ BEGIN
           IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
             CREATE ROLE ${role} LOGIN;
           END IF;
         END $$`,
      );
      await client.query(`ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${ROLE_PASSWORD}'`);
    }
    await client.query(`CREATE DATABASE ${database} OWNER tenant_owner`);
    await client.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
    await client.query(`GRANT CONNECT ON DATABASE ${database} TO tenant_app, tenant_relay, tenant_maint`);
  } finally {
    await client.end();
  }
}

async function dropDatabase(adminUrl: string, database: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await client.end();
}

// Прогрес у термінал: перший запуск качає образи, Keycloak стартує 30–60 с — без цього здається, що все зависло.
const step = (msg: string) => console.log(`▶ ${msg}`);

export default async function setup(project: TestProject) {
  const cleanups: Array<() => Promise<unknown>> = [];
  const started = Date.now();

  // --- PostgreSQL ---
  let adminUrl = process.env.TEST_PG_ADMIN_URL;
  if (!adminUrl) {
    step('PostgreSQL 16.15 у контейнері (перший раз — завантаження образу)…');
    const container = await new PostgreSqlContainer('postgres:16.15').start();
    cleanups.push(() => container.stop());
    adminUrl = container.getConnectionUri();
  }
  const database = `tenant_test_${randomBytes(4).toString('hex')}`;
  await prepareDatabase(adminUrl, database);
  cleanups.push(() => dropDatabase(adminUrl, database));

  const urls = {
    // Суперкористувач — лише для тесту міграцій на окремій тимчасовій базі.
    admin: adminUrl,
    owner: withCredentials(adminUrl, 'tenant_owner', ROLE_PASSWORD, database),
    app: withCredentials(adminUrl, 'tenant_app', ROLE_PASSWORD, database),
    relay: withCredentials(adminUrl, 'tenant_relay', ROLE_PASSWORD, database),
    maint: withCredentials(adminUrl, 'tenant_maint', ROLE_PASSWORD, database),
  };
  const owner = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: urls.owner, max: 1 }) }) });
  step('ролі й база tenant, міграції…');
  await migrateToLatest(owner);
  await owner.destroy();
  project.provide('pg', urls);

  // --- Keycloak ---
  let keycloakUrl = process.env.TEST_KEYCLOAK_URL;
  if (!keycloakUrl) {
    step('Keycloak 26.8.1 з realm lad (запуск 30–60 с)…');
    const realmFile = fileURLToPath(new URL('./fixtures/lad-realm.json', import.meta.url));
    // Вміст копіюється з явними правами 644: Keycloak у контейнері працює не від root і інакше
    // не прочитає файл з правами 600 (так файл може лежати на диску), імпорт впаде, Keycloak завершиться.
    const realm = readFileSync(realmFile, 'utf8');
    const logs: string[] = [];
    let container;
    try {
      container = await new GenericContainer('quay.io/keycloak/keycloak:26.8.1')
        .withCommand(['start-dev', '--import-realm'])
        .withEnvironment({
          KC_HTTP_RELATIVE_PATH: '/idp',
          KC_HEALTH_ENABLED: 'true',
          KC_BOOTSTRAP_ADMIN_USERNAME: 'admin',
          KC_BOOTSTRAP_ADMIN_PASSWORD: KC_ADMIN_PASSWORD,
          LAD_PUBLIC_URL: 'http://localhost',
          SYSADMIN_PASSWORD: 'test-sysadmin-pass',
          DEMO_SCHEDULER_PASSWORD: 'test-demo-pass-123',
          DEMO_SCHOOL_ID: '5d0b6a1e-7c3f-4b2a-9e41-0a1d2c3b4e5f',
          TENANT_CLIENT_SECRET: TENANT_SECRET,
        })
        .withCopyContentToContainer([{ content: realm, target: '/opt/keycloak/data/import/lad-realm.json', mode: 0o644 }])
        .withExposedPorts(8080, 9000)
        .withLogConsumer((stream) => stream.on('data', (line) => logs.push(String(line))))
        .withWaitStrategy(Wait.forHttp('/idp/health/ready', 9000).forStatusCode(200))
        .withStartupTimeout(120_000)
        .start();
    } catch (err) {
      // Без цього видно лише «URL not accessible», а справжня причина — у лозі Keycloak.
      console.error(`✖ Keycloak не стартував. Останні рядки його логу:\n${logs.slice(-40).join('')}`);
      throw err;
    }
    cleanups.push(() => container.stop());
    keycloakUrl = `http://${container.getHost()}:${container.getMappedPort(8080)}/idp`;
  }
  project.provide('keycloak', { url: keycloakUrl, adminPassword: KC_ADMIN_PASSWORD, tenantSecret: TENANT_SECRET });
  step(`оточення готове за ${Math.round((Date.now() - started) / 1000)} с, запускаю тести`);

  return async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    pg: { admin: string; owner: string; app: string; relay: string; maint: string };
    keycloak: { url: string; adminPassword: string; tenantSecret: string };
  }
}
