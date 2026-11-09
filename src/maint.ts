// Щоденна чистка під роллю tenant_maint (розділ 13, «Дані й міграції»): надіслані рядки outbox
// старші за 7 днів. Неотримані Kafka рядки (published_at is null) не видаляються ніколи.
import type { FastifyBaseLogger } from 'fastify';
import { sql } from 'kysely';
import type { Db } from './db/index.js';

export async function cleanup(maintDb: Db, now: Date = new Date()): Promise<{ outbox: number }> {
  const outbox = await maintDb
    .deleteFrom('outbox')
    .where('published_at', 'is not', null)
    .where('published_at', '<', sql<Date>`${now}::timestamptz - interval '7 days'`)
    .executeTakeFirst();
  return { outbox: Number(outbox.numDeletedRows) };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Перший прохід через хвилину після старту, далі раз на добу. */
export function scheduleCleanup(maintDb: Db, log: FastifyBaseLogger, firstDelayMs = 60_000): () => void {
  const run = () =>
    cleanup(maintDb)
      .then((r) => log.info(r, 'щоденна чистка'))
      .catch((err) => log.error({ err }, 'щоденна чистка не вдалася'));
  const first = setTimeout(run, firstDelayMs);
  const daily = setInterval(run, DAY_MS);
  first.unref();
  daily.unref();
  return () => {
    clearTimeout(first);
    clearInterval(daily);
  };
}
