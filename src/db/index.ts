// Доступ до бази tenant через Kysely.
//
// ТИМЧАСОВО до появи пакета @lad/db: withSchool і запис в outbox живуть тут. Специфікація
// (рішення 54, 70) вимагає, щоб вони були лише в @lad/db; коли пакет з'явиться, цей модуль
// замінюється імпортом з нього, а схема таблиці outbox звіряється з його міграцією.
import { Kysely, PostgresDialect, sql, type ColumnType, type Generated, type Transaction } from 'kysely';
import pg from 'pg';

export interface SchoolsTable {
  school_id: string;
  name: string;
  scheduler_login: string;
  scheduler_user_id: string;
  created_at: ColumnType<Date, never, never>;
}

export interface OutboxTable {
  school_id: string;
  event_id: string;
  topic: string;
  payload: ColumnType<unknown, string, string>;
  created_at: Generated<Date>;
  published_at: Date | null;
}

export interface Database {
  schools: SchoolsTable;
  outbox: OutboxTable;
}

export type Db = Kysely<Database>;

export function createDb(connectionString: string, maxConnections = 10): Db {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: maxConnections }) }),
  });
}

/**
 * Транзакція в контексті одного закладу: політики RLS читають app.school_id.
 * set_config(..., true) діє лише до кінця транзакції, тож заклад не «протікає» в інші запити пулу.
 */
export async function withSchool<T>(db: Db, schoolId: string, fn: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.school_id', ${schoolId}, true)`.execute(trx);
    return fn(trx);
  });
}
