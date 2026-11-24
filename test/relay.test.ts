// Relay outbox → Kafka і щоденна чистка outbox: справжній PostgreSQL з ролями tenant_relay і
// tenant_maint; Kafka — підробна шина в пам'яті, а в останньому блоці справжня Kafka 4.3.2
// (той самий образ, що в platform). Без Docker блок зі справжньою Kafka: TEST_KAFKA=off.
import { createServer } from 'node:net';
import { Admin, Consumer, stringDeserializers } from '@platformatic/kafka';
import Fastify from 'fastify';
import { sql } from 'kysely';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, inject, test, vi } from 'vitest';
import { createDb, withSchool } from '../src/db/index.js';
import type { OutgoingMessage, Producer } from '../src/kafka/bus.js';
import { createProducer } from '../src/kafka/platformatic.js';
import { chunkBySize, MAX_SEND_BYTES, messageBytes, relayOnce, startRelay } from '../src/kafka/relay.js';
import { cleanup, scheduleCleanup } from '../src/maint.js';
import { KAFKA_IMAGE } from './global-setup.js';
import { testApp, uniqueLogin } from './helpers.js';

const urls = inject('pg');
const relayDb = createDb(urls.relay, 2);
const maintDb = createDb(urls.maint, 1);
const silent = Fastify({ logger: { level: 'silent' } }).log;
let ctx: Awaited<ReturnType<typeof testApp>>;

/** Kafka в пам'яті: запам'ятовує надіслане; failNext — наступна відправка падає; failOn — падає n-та відправка. */
class MemoryProducer implements Producer {
  readonly sent: OutgoingMessage[] = [];
  readonly calls: OutgoingMessage[][] = [];
  failNext = 0;
  failOn = 0;
  async send(messages: OutgoingMessage[]) {
    this.calls.push(messages);
    if (this.failNext > 0 || this.calls.length === this.failOn) {
      if (this.failNext > 0) this.failNext -= 1;
      throw new Error('kafka недоступна');
    }
    // Як брокер з message.max.bytes ≈ 1 МБ: завеликий запит не приймається (MESSAGE_TOO_LARGE).
    if (messages.reduce((n, m) => n + messageBytes(m), 0) > 1_048_576) throw new Error('MESSAGE_TOO_LARGE');
    this.sent.push(...messages);
  }
  async close() {}
}

beforeAll(async () => {
  ctx = await testApp();
  // Рядки, які лишили інші файли тестів, тут не потрібні: relay забирає всі ненадіслані.
  await relayOnce(relayDb, new MemoryProducer(), 10_000);
});
afterAll(async () => {
  await ctx.app.close();
  await Promise.all([ctx.db.destroy(), relayDb.destroy(), maintDb.destroy()]);
});

async function registerSchool(name = 'Ліцей № 17') {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/tenant/schools',
    headers: { authorization: `Bearer ${await ctx.tokens.sysadmin()}`, 'x-request-id': 'req-relay-1' },
    payload: { name, login: uniqueLogin() },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { school_id: string };
}

const publishedAt = async (schoolId: string) =>
  (await relayDb.selectFrom('outbox').select('published_at').where('school_id', '=', schoolId).executeTakeFirstOrThrow()).published_at;

describe('relayOnce', () => {
  test('school.registered іде в Kafka: топік, ключ school_id, конверт; рядок позначено надісланим', async () => {
    const { school_id } = await registerSchool('Гімназія № 3');
    const producer = new MemoryProducer();
    expect(await relayOnce(relayDb, producer)).toBe(1);

    const [msg] = producer.sent;
    expect(msg).toMatchObject({ topic: 'school.registered', key: school_id });
    const envelope = JSON.parse(msg!.value);
    // Саме цю форму читає school-service: data.name і data.registered_at.
    expect(envelope).toMatchObject({
      type: 'school.registered',
      schema_version: '1.0',
      source: 'tenant-service',
      correlation_id: 'req-relay-1',
      school_id,
      data: { school_id, name: 'Гімназія № 3' },
    });
    expect(envelope.event_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(envelope.data.registered_at)).not.toBeNaN();
    expect(await publishedAt(school_id)).toBeInstanceOf(Date);
  });

  test('надіслане вдруге не йде', async () => {
    await registerSchool();
    const producer = new MemoryProducer();
    expect(await relayOnce(relayDb, producer)).toBe(1);
    expect(await relayOnce(relayDb, producer)).toBe(0);
    expect(producer.sent).toHaveLength(1);
  });

  test('Kafka не прийняла — рядок лишається ненадісланим і йде наступним проходом', async () => {
    const { school_id } = await registerSchool();
    const producer = new MemoryProducer();
    producer.failNext = 1;
    await expect(relayOnce(relayDb, producer)).rejects.toThrow(/kafka недоступна/);
    expect(await publishedAt(school_id)).toBeNull();

    expect(await relayOnce(relayDb, producer)).toBe(1);
    expect(producer.sent.map((m) => m.key)).toEqual([school_id]);
  });

  test('порядок — за часом запису; пакет обмежено batchSize', async () => {
    const a = await registerSchool('A');
    const b = await registerSchool('B');
    const c = await registerSchool('C');
    const producer = new MemoryProducer();
    expect(await relayOnce(relayDb, producer, 2)).toBe(2);
    expect(await relayOnce(relayDb, producer, 2)).toBe(1);
    expect(producer.sent.map((m) => m.key)).toEqual([a.school_id, b.school_id, c.school_id]);
  });

  test('два relay одночасно не відправляють один рядок двічі (SKIP LOCKED)', async () => {
    for (let i = 0; i < 6; i++) await registerSchool(`S${i}`);
    const p1 = new MemoryProducer();
    const p2 = new MemoryProducer();
    const second = createDb(urls.relay, 2);
    try {
      const [n1, n2] = await Promise.all([relayOnce(relayDb, p1, 3), relayOnce(second, p2, 3)]);
      const rest = await relayOnce(relayDb, p1);
      const keys = [...p1.sent, ...p2.sent].map((m) => m.key);
      expect(n1 + n2 + rest).toBe(6);
      expect(new Set(keys).size).toBe(6);
    } finally {
      await second.destroy();
    }
  });
  /** Подія з корисним навантаженням ~bytes байтів прямо в outbox закладу (як великі події timetable). */
  async function bigEvent(schoolId: string, bytes: number) {
    const eventId = crypto.randomUUID();
    await withSchool(ctx.db, schoolId, (trx) =>
      trx
        .insertInto('outbox')
        .values({ school_id: schoolId, event_id: eventId, topic: 'school.registered', payload: JSON.stringify({ event_id: eventId, pad: 'x'.repeat(bytes) }) })
        .execute(),
    );
    return eventId;
  }
  const isPublished = async (eventId: string) =>
    (await relayDb.selectFrom('outbox').select('published_at').where('event_id', '=', eventId).executeTakeFirstOrThrow()).published_at !== null;

  test('пачка великих подій іде частинами до MAX_SEND_BYTES, а не одним запитом понад 1 МБ', async () => {
    const { school_id } = await registerSchool();
    await relayOnce(relayDb, new MemoryProducer());
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(await bigEvent(school_id, 250_000));
    const producer = new MemoryProducer();
    expect(await relayOnce(relayDb, producer)).toBe(10);
    expect(producer.calls.length).toBeGreaterThanOrEqual(3);
    for (const call of producer.calls) expect(call.reduce((n, m) => n + messageBytes(m), 0)).toBeLessThanOrEqual(MAX_SEND_BYTES);
    for (const id of ids) expect(await isPublished(id)).toBe(true);
  });

  test('подія понад ліміт не блокує наступні: лишається ненадісланою, решта йде, onOversize викликано', async () => {
    const { school_id } = await registerSchool();
    await relayOnce(relayDb, new MemoryProducer());
    const huge = await bigEvent(school_id, 2_000_000);
    const small = await bigEvent(school_id, 100);
    const producer = new MemoryProducer();
    const onOversize = vi.fn();
    expect(await relayOnce(relayDb, producer, { onOversize })).toBe(1);
    expect(await isPublished(small)).toBe(true);
    expect(await isPublished(huge)).toBe(false);
    expect(onOversize).toHaveBeenCalledWith(expect.objectContaining({ event_id: huge, school_id }));
    // Прибираємо, щоб завелика подія не заважала іншим тестам цього файлу.
    await maintDb.deleteFrom('outbox').where('event_id', '=', huge).execute();
  });

  test('впала не перша частина — надіслані частини зафіксовано, решта йде наступним проходом', async () => {
    const { school_id } = await registerSchool();
    await relayOnce(relayDb, new MemoryProducer());
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await bigEvent(school_id, 250_000));
    const producer = new MemoryProducer();
    producer.failOn = 2;
    const first = await relayOnce(relayDb, producer);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(6);
    expect(await relayOnce(relayDb, producer)).toBe(6 - first);
    for (const id of ids) expect(await isPublished(id)).toBe(true);
    // Кожна подія — рівно один раз: у тексті події її власний event_id.
    expect(producer.sent).toHaveLength(6);
    expect(new Set(producer.sent.map((m) => JSON.parse(m.value).event_id))).toEqual(new Set(ids));
  });

  test('chunkBySize: порядок збережено, межа не перевищується, завеликий елемент — окремою частиною', () => {
    expect(chunkBySize([3, 3, 3, 9, 1], (n) => n, 6)).toEqual([[3, 3], [3], [9], [1]]);
    expect(chunkBySize([], (n: number) => n, 6)).toEqual([]);
  });
});

describe('startRelay', () => {
  test('відправляє в циклі, після збою повторює, stop чекає поточний прохід', async () => {
    const producer = new MemoryProducer();
    producer.failNext = 1;
    const warn = vi.fn();
    const log = { ...silent, warn, debug: vi.fn() } as unknown as typeof silent;
    const { school_id } = await registerSchool();
    const relay = startRelay(relayDb, producer, log, 20);
    await vi.waitFor(() => expect(producer.sent.map((m) => m.key)).toContain(school_id), { timeout: 5_000 });
    await relay.stop();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), expect.stringContaining('relay'));

    // Після stop нові події лишаються в outbox до наступного запуску.
    const later = await registerSchool();
    await new Promise((r) => setTimeout(r, 100));
    expect(await publishedAt(later.school_id)).toBeNull();
    await relayOnce(relayDb, producer);
  });
});

describe('щоденна чистка outbox (tenant_maint)', () => {
  const insertEvent = async (schoolId: string) =>
    withSchool(ctx.db, schoolId, (trx) =>
      trx
        .insertInto('outbox')
        .values({ school_id: schoolId, event_id: crypto.randomUUID(), topic: 'school.registered', payload: JSON.stringify({ t: 1 }) })
        .execute(),
    );
  const setPublished = (schoolId: string, at: string | null) =>
    relayDb
      .updateTable('outbox')
      .set({ published_at: at === null ? null : sql<Date>`${at}::timestamptz` })
      .where('school_id', '=', schoolId)
      .execute();
  const count = async (schoolId: string) =>
    Number((await relayDb.selectFrom('outbox').select(relayDb.fn.countAll().as('n')).where('school_id', '=', schoolId).executeTakeFirstOrThrow()).n);

  test('видаляє лише надіслані понад 7 днів тому; ненадіслані не чіпає ніколи', async () => {
    const now = new Date('2026-11-20T12:00:00Z');
    const old = crypto.randomUUID();
    const fresh = crypto.randomUUID();
    const unsent = crypto.randomUUID();
    await insertEvent(old);
    await insertEvent(fresh);
    await insertEvent(unsent);
    await setPublished(old, '2026-11-13T11:59:00Z');
    await setPublished(fresh, '2026-11-13T12:01:00Z');
    await relayDb.updateTable('outbox').set({ created_at: sql<Date>`'2026-01-01'::timestamptz` }).where('school_id', '=', unsent).execute();

    const res = await cleanup(maintDb, now);
    expect(res.outbox).toBeGreaterThanOrEqual(1);
    expect(await count(old)).toBe(0);
    expect(await count(fresh)).toBe(1);
    expect(await count(unsent)).toBe(1);
    // Прибрати за собою, щоб relay в інших тестах не відправляв ці рядки.
    await setPublished(unsent, '2026-11-19T00:00:00Z');
  });

  test('scheduleCleanup: перший прохід за розкладом, помилка логується, зупинка прибирає таймери', async () => {
    const info = vi.fn();
    const error = vi.fn();
    const log = { ...silent, info, error } as unknown as typeof silent;
    const stop = scheduleCleanup(maintDb, log, 10);
    await vi.waitFor(() => expect(info).toHaveBeenCalledWith(expect.objectContaining({ outbox: expect.any(Number) }), 'щоденна чистка'));
    stop();

    // Неправильний пароль: кожен прохід падає на підключенні.
    const badUrl = new URL(urls.maint);
    badUrl.password = 'wrong-password';
    const broken = createDb(badUrl.toString(), 1);
    const stopBroken = scheduleCleanup(broken, log, 10);
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'щоденна чистка не вдалася'));
    stopBroken();
    await broken.destroy();
  });
});

const { brokers: givenBrokers, enabled: kafkaEnabled } = inject('kafka');

/** Вільний порт хоста: брокер оголошує клієнтам саме його (advertised listener). */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });

describe.runIf(kafkaEnabled)('справжня Kafka', () => {
  let brokers: string[];
  let container: StartedTestContainer | undefined;
  let producer: Producer;

  beforeAll(async () => {
    if (givenBrokers) {
      brokers = givenBrokers.split(',');
    } else {
      const port = await freePort();
      container = await new GenericContainer(KAFKA_IMAGE)
        .withExposedPorts({ container: 9092, host: port })
        .withEnvironment({
          KAFKA_NODE_ID: '1',
          KAFKA_PROCESS_ROLES: 'broker,controller',
          KAFKA_LISTENERS: 'PLAINTEXT://:9092,CONTROLLER://:9093',
          KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://localhost:${port}`,
          KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
          KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
          KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT',
          // Як у platform: топіки створює лише kafka-init.
          KAFKA_AUTO_CREATE_TOPICS_ENABLE: 'false',
          KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
          KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
          KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
          KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
        })
        .withWaitStrategy(Wait.forLogMessage(/Kafka Server started/))
        .withStartupTimeout(120_000)
        .start();
      brokers = [`localhost:${port}`];
    }
    const admin = new Admin({ clientId: 'test-admin', bootstrapBrokers: brokers });
    try {
      await admin.createTopics({ topics: ['school.registered'], partitions: 3, replicas: 1 });
    } catch (err) {
      // Уже запущений брокер зі стенду platform: топік створив kafka-init.
      if (!/already exists/i.test(String((err as Error).message) + JSON.stringify(err))) throw err;
    } finally {
      await admin.close();
    }
    producer = createProducer({ brokers, clientId: 'tenant-service-test' });
  });
  afterAll(async () => {
    await producer?.close();
    await container?.stop();
  });

  test('relay → топік school.registered: ключ school_id і конверт, який читає school-service', async () => {
    const { school_id } = await registerSchool('Ліцей Kafka');
    // Інші рядки в outbox, якщо є, теж підуть — шукаємо свій за ключем.
    while ((await relayOnce(relayDb, producer)) > 0);
    expect(await publishedAt(school_id)).toBeInstanceOf(Date);

    const consumer = new Consumer({
      clientId: 'test-reader',
      groupId: `test-reader-${crypto.randomUUID()}`,
      bootstrapBrokers: brokers,
      deserializers: stringDeserializers,
    });
    const stream = await consumer.consume({ topics: ['school.registered'], mode: 'earliest', autocommit: false });
    let found: { key?: string; value?: string } | undefined;
    const timer = setTimeout(() => void stream.close(), 30_000);
    try {
      for await (const m of stream) {
        if (m.key === school_id) {
          found = { key: m.key, value: m.value };
          break;
        }
      }
    } finally {
      clearTimeout(timer);
      await stream.close();
      await consumer.close(true);
    }
    expect(found?.key).toBe(school_id);
    expect(JSON.parse(found!.value!)).toMatchObject({ type: 'school.registered', school_id, data: { name: 'Ліцей Kafka' } });
  });
});
