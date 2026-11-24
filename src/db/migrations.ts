// Міграції бази tenant. Виконуються роллю tenant_owner окремою командою (npm run migrate),
// а не при старті сервісу: робоча роль tenant_app не володіє таблицями (рішення 55).
// Ролі tenant_app, tenant_relay, tenant_maint створює db-init у репозиторії platform.
import { sql, type Kysely } from 'kysely';
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';

const migrations: Record<string, Migration> = {
  '0001_schools_and_outbox': {
    async up(db: Kysely<unknown>) {
      // Реєстр закладів — задокументований виняток без RLS (розділ 03): лише назва й логін укладача,
      // маршрути закриває guard sysadmin.
      await sql`
        create table schools (
          school_id         uuid primary key,
          name              text not null check (length(name) between 1 and 200),
          scheduler_login   text not null unique,
          scheduler_user_id uuid not null,
          created_at        timestamptz not null default now()
        )`.execute(db);

      // Outbox: подія пишеться в одній транзакції з даними; school_id першим у ключі.
      await sql`
        create table outbox (
          school_id    uuid not null,
          event_id     uuid not null,
          topic        text not null,
          payload      jsonb not null,
          created_at   timestamptz not null default now(),
          published_at timestamptz,
          primary key (school_id, event_id)
        )`.execute(db);
      await sql`create index outbox_unpublished on outbox (created_at) where published_at is null`.execute(db);

      await sql`alter table outbox enable row level security`.execute(db);
      await sql`alter table outbox force row level security`.execute(db);
      await sql`
        create policy outbox_app on outbox to tenant_app
          using (school_id = nullif(current_setting('app.school_id', true), '')::uuid)
          with check (school_id = nullif(current_setting('app.school_id', true), '')::uuid)`.execute(db);
      // relay і maint працюють поза одним закладом: окремі політики, без BYPASSRLS (рішення 56).
      await sql`create policy outbox_relay on outbox to tenant_relay using (true) with check (true)`.execute(db);
      await sql`create policy outbox_maint on outbox to tenant_maint using (true)`.execute(db);

      await sql`grant select, insert on schools to tenant_app`.execute(db);
      await sql`grant insert on outbox to tenant_app`.execute(db);
      await sql`grant select, update on outbox to tenant_relay`.execute(db);
      await sql`grant select, delete on outbox to tenant_maint`.execute(db);
    },
    async down(db: Kysely<unknown>) {
      await sql`drop table outbox`.execute(db);
      await sql`drop table schools`.execute(db);
    },
  },
};

const provider: MigrationProvider = { getMigrations: async () => migrations };

export function createMigrator(db: Kysely<unknown>): Migrator {
  return new Migrator({ db, provider });
}

export async function migrateToLatest(db: Kysely<unknown>): Promise<string[]> {
  const { error, results } = await createMigrator(db).migrateToLatest();
  if (error) throw error;
  return (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
}
