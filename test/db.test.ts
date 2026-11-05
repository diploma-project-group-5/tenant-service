// Ролі й ізоляція в базі tenant: RLS на outbox, права ролей, повторні міграції.
import { sql } from 'kysely';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, describe, expect, test } from 'vitest';
import { inject } from 'vitest';
import { createDb, withSchool } from '../src/db/index.js';
import { createMigrator, migrateToLatest } from '../src/db/migrations.js';

const urls = inject('pg');
const app = createDb(urls.app, 2);
const relay = createDb(urls.relay, 2);
const maint = createDb(urls.maint, 2);

afterAll(async () => {
  await Promise.all([app.destroy(), relay.destroy(), maint.destroy()]);
});

const schoolA = crypto.randomUUID();
const schoolB = crypto.randomUUID();
const outboxRow = (schoolId: string) => ({
  school_id: schoolId,
  event_id: crypto.randomUUID(),
  topic: 'school.registered',
  payload: JSON.stringify({ test: true }),
});

describe('RLS на outbox', () => {
  test('tenant_app пише подію свого закладу', async () => {
    await withSchool(app, schoolA, (trx) => trx.insertInto('outbox').values(outboxRow(schoolA)).execute());
    await withSchool(app, schoolB, (trx) => trx.insertInto('outbox').values(outboxRow(schoolB)).execute());
    const rows = await relay.selectFrom('outbox').select('school_id').where('school_id', 'in', [schoolA, schoolB]).execute();
    expect(rows).toHaveLength(2);
  });

  test('tenant_app не пише подію чужого закладу', async () => {
    await expect(
      withSchool(app, schoolA, (trx) => trx.insertInto('outbox').values(outboxRow(schoolB)).execute()),
    ).rejects.toThrow(/row-level security/);
  });

  test('tenant_app без заданого закладу не пише нічого', async () => {
    await expect(app.insertInto('outbox').values(outboxRow(schoolA)).execute()).rejects.toThrow(/row-level security/);
  });

  test('tenant_app не читає outbox (немає права SELECT)', async () => {
    await expect(withSchool(app, schoolA, (trx) => trx.selectFrom('outbox').selectAll().execute())).rejects.toThrow(
      /permission denied/,
    );
  });

  test('tenant_relay бачить події всіх закладів і позначає відправлені', async () => {
    const updated = await relay
      .updateTable('outbox')
      .set({ published_at: new Date() })
      .where('school_id', '=', schoolA)
      .executeTakeFirst();
    expect(Number(updated.numUpdatedRows)).toBeGreaterThan(0);
  });

  test('tenant_relay не має доступу до реєстру закладів', async () => {
    await expect(relay.selectFrom('schools').selectAll().execute()).rejects.toThrow(/permission denied/);
  });

  test('tenant_maint видаляє старі події, але не пише нові', async () => {
    const res = await maint.deleteFrom('outbox').where('school_id', '=', schoolA).executeTakeFirst();
    expect(Number(res.numDeletedRows)).toBeGreaterThan(0);
    await expect(maint.insertInto('outbox').values(outboxRow(schoolA)).execute()).rejects.toThrow(/permission denied/);
  });
});

describe('ролі', () => {
  test('у робочих ролях немає SUPERUSER і BYPASSRLS', async () => {
    const rows = await sql<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>`
      select rolname, rolsuper, rolbypassrls from pg_roles
      where rolname in ('tenant_app', 'tenant_relay', 'tenant_maint', 'tenant_owner')`.execute(app);
    expect(rows.rows).toHaveLength(4);
    for (const r of rows.rows) expect({ ...r, rolsuper: r.rolsuper, rolbypassrls: r.rolbypassrls }).toMatchObject({ rolsuper: false, rolbypassrls: false });
  });

  test('outbox під FORCE ROW LEVEL SECURITY, реєстр — без RLS (задокументований виняток)', async () => {
    const rows = await sql<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>`
      select relname, relrowsecurity, relforcerowsecurity from pg_class
      where relname in ('outbox', 'schools') order by relname`.execute(app);
    expect(rows.rows).toEqual([
      { relname: 'outbox', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'schools', relrowsecurity: false, relforcerowsecurity: false },
    ]);
  });

  test('tenant_app не може змінювати схему', async () => {
    await expect(sql`create table hack (id int)`.execute(app)).rejects.toThrow(/permission denied/);
  });
});

describe('міграції', () => {
  test('на чистій базі: up, down, знову up', async () => {
    const db = `tenant_mig_${Math.random().toString(16).slice(2, 10)}`;
    const admin = new pg.Client({ connectionString: urls.admin });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${db} OWNER tenant_owner`);
    const ownerUrl = new URL(urls.owner);
    ownerUrl.pathname = `/${db}`;
    const owner = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: ownerUrl.toString(), max: 1 }) }) });
    try {
      expect(await migrateToLatest(owner)).toEqual(['0001_schools_and_outbox']);
      const down = await createMigrator(owner).migrateDown();
      expect(down.error).toBeUndefined();
      const tables = await sql<{ n: number }>`select count(*)::int as n from pg_tables where tablename in ('schools', 'outbox')`.execute(owner);
      expect(tables.rows[0]?.n).toBe(0);
      expect(await migrateToLatest(owner)).toEqual(['0001_schools_and_outbox']);
    } finally {
      await owner.destroy();
      await admin.query(`DROP DATABASE ${db} WITH (FORCE)`);
      await admin.end();
    }
  });

  test('помилка міграції не ковтається', async () => {
    const appAsOwner = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: urls.app, max: 1 }) }) });
    const db = `tenant_mig_${Math.random().toString(16).slice(2, 10)}`;
    const admin = new pg.Client({ connectionString: urls.admin });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${db} OWNER tenant_owner`);
    await admin.query(`GRANT CONNECT ON DATABASE ${db} TO tenant_app`);
    const appUrl = new URL(urls.app);
    appUrl.pathname = `/${db}`;
    const asApp = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: appUrl.toString(), max: 1 }) }) });
    try {
      // tenant_app не має права створювати таблиці — міграція мусить упасти, а не тихо пройти.
      await expect(migrateToLatest(asApp)).rejects.toThrow();
    } finally {
      await asApp.destroy();
      await appAsOwner.destroy();
      await admin.query(`DROP DATABASE ${db} WITH (FORCE)`);
      await admin.end();
    }
  });

  test('повторний запуск нічого не робить', async () => {
    const owner = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: urls.owner, max: 1 }) }) });
    try {
      expect(await migrateToLatest(owner)).toEqual([]);
    } finally {
      await owner.destroy();
    }
  });
});
