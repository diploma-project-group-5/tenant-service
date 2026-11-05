// Реєстрація закладу й список: справжній PostgreSQL, підробний Keycloak.
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { inject } from 'vitest';
import { createDb } from '../src/db/index.js';
import { KeycloakError } from '../src/keycloak.js';
import { FakeKeycloak, testApp, uniqueLogin } from './helpers.js';

let ctx: Awaited<ReturnType<typeof testApp>>;
let keycloak: FakeKeycloak;
// Читати outbox може лише relay: робочій ролі SELECT на outbox не видано.
const relayDb = createDb(inject('pg').relay, 2);

beforeAll(async () => {
  keycloak = new FakeKeycloak();
  ctx = await testApp({ keycloak });
});
afterAll(async () => {
  await ctx.app.close();
  await ctx.db.destroy();
  await relayDb.destroy();
});

async function register(payload: unknown) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/v1/tenant/schools',
    headers: { authorization: `Bearer ${await ctx.tokens.sysadmin()}`, 'x-request-id': 'req-test-1' },
    payload: payload as object,
  });
}

describe('POST /api/v1/tenant/schools', () => {
  test('201: school_id, логін, тимчасовий пароль; no-store', async () => {
    const login = uniqueLogin();
    const res = await register({ name: '  Ліцей № 17  ', login });
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['login', 'school_id', 'temporary_password']);
    expect(body.login).toBe(login);
    expect(body.school_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.temporary_password).toMatch(/^[A-Za-z2-9]{16}$/);
  });

  test('укладач у Keycloak: той самий логін, school_id і тимчасовий пароль', async () => {
    const login = uniqueLogin();
    const body = (await register({ name: 'Гімназія', login })).json();
    const user = [...keycloak.users.values()].find((u) => u.login === login);
    expect(user).toMatchObject({ login, schoolId: body.school_id, temporaryPassword: body.temporary_password });
  });

  test('заклад у реєстрі: назва без пробілів по краях, логін, id користувача Keycloak', async () => {
    const login = uniqueLogin();
    const body = (await register({ name: '  Ліцей № 5  ', login })).json();
    const row = await ctx.db.selectFrom('schools').selectAll().where('school_id', '=', body.school_id).executeTakeFirstOrThrow();
    expect(row.name).toBe('Ліцей № 5');
    expect(row.scheduler_login).toBe(login);
    const user = [...keycloak.users.values()].find((u) => u.login === login);
    expect(row.scheduler_user_id).toBe(user?.userId);
  });

  test('подія school.registered в outbox — конверт і дані', async () => {
    const login = uniqueLogin();
    const body = (await register({ name: 'Ліцей № 3', login })).json();
    const rows = await relayDb.selectFrom('outbox').selectAll().where('school_id', '=', body.school_id).execute();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.topic).toBe('school.registered');
    expect(row.published_at).toBeNull();
    const event = row.payload as Record<string, unknown>;
    expect(event).toMatchObject({
      event_id: row.event_id,
      type: 'school.registered',
      schema_version: '1.0',
      source: 'tenant-service',
      correlation_id: 'req-test-1',
      school_id: body.school_id,
      data: { school_id: body.school_id, name: 'Ліцей № 3' },
    });
    expect(Object.keys(event).sort()).toEqual(
      ['correlation_id', 'data', 'event_id', 'schema_version', 'school_id', 'source', 'time', 'type'],
    );
    expect(new Date(event.time as string).toString()).not.toBe('Invalid Date');
  });

  test('логін з великими літерами й пробілами зберігається в нижньому регістрі', async () => {
    const login = uniqueLogin('Upper');
    const res = await register({ name: 'Школа', login: `  ${login.toUpperCase()} ` });
    expect(res.statusCode).toBe(201);
    expect(res.json().login).toBe(login.toLowerCase());
  });

  test('зайнятий логін → 409 login_taken, у реєстрі нічого нового', async () => {
    const login = uniqueLogin();
    expect((await register({ name: 'Перша', login })).statusCode).toBe(201);
    const before = await ctx.db.selectFrom('schools').select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow();
    const res = await register({ name: 'Друга', login });
    expect(res.statusCode).toBe(409);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ status: 409, code: 'login_taken' });
    const after = await ctx.db.selectFrom('schools').select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow();
    expect(after.n).toBe(before.n);
  });

  test.each([
    ['недопустимі символи', { name: 'Ліцей', login: 'ліцей' }],
    ['пробіл усередині', { name: 'Ліцей', login: 'school one' }],
    ['закороткий', { name: 'Ліцей', login: 'ab' }],
    ['задовгий', { name: 'Ліцей', login: 'a'.repeat(65) }],
    ['порожня назва', { name: '   ', login: 'valid-login' }],
    ['назва понад 200', { name: 'x'.repeat(201), login: 'valid-login' }],
    ['без логіна', { name: 'Ліцей' }],
    ['не обʼєкт', 'рядок'],
  ])('%s → 400 validation_failed, Keycloak не викликається', async (_case, payload) => {
    const usersBefore = keycloak.users.size;
    const res = await register(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ status: 400, code: 'validation_failed' });
    expect(keycloak.users.size).toBe(usersBefore);
  });

  test('тимчасовий пароль не потрапляє в лог', async () => {
    const body = (await register({ name: 'Ліцей логів', login: uniqueLogin() })).json();
    const log = ctx.logs.lines.join('');
    expect(log).toContain(body.school_id);
    expect(log).not.toContain(body.temporary_password);
  });

  test('Keycloak недоступний → 500 problem+json, у реєстрі нічого', async () => {
    const login = uniqueLogin();
    keycloak.failCreateWith = new KeycloakError('Keycloak не видав сервісний токен: HTTP 503', 503);
    try {
      const res = await register({ name: 'Ліцей', login });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({ code: 'internal' });
      expect(JSON.stringify(res.json())).not.toContain('Keycloak');
    } finally {
      keycloak.failCreateWith = null;
    }
    const row = await ctx.db.selectFrom('schools').select('school_id').where('scheduler_login', '=', login).executeTakeFirst();
    expect(row).toBeUndefined();
  });
});

describe('відкат: транзакція не вдалася → користувача в Keycloak видалено', () => {
  test('логін уже є в реєстрі, але зник з Keycloak → 409 і користувача прибрано', async () => {
    const login = uniqueLogin();
    const first = (await register({ name: 'Перша', login })).json();
    // Адмін вручну видалив користувача в консолі Keycloak, а рядок у реєстрі лишився.
    const firstUser = [...keycloak.users.values()].find((u) => u.schoolId === first.school_id)!;
    keycloak.users.delete(firstUser.userId);

    const res = await register({ name: 'Друга', login });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('login_taken');
    expect([...keycloak.users.values()].some((u) => u.login === login)).toBe(false);
    expect(keycloak.deleted.length).toBeGreaterThan(0);
  });

  test('база недоступна → 500, створеного користувача видалено', async () => {
    const broken = createDb('postgres://nobody:wrong@127.0.0.1:1/none', 1);
    const local = await testApp({ keycloak, db: broken });
    const deletedBefore = keycloak.deleted.length;
    const res = await local.app.inject({
      method: 'POST',
      url: '/api/v1/tenant/schools',
      headers: { authorization: `Bearer ${await local.tokens.sysadmin()}` },
      payload: { name: 'Ліцей', login: uniqueLogin() },
    });
    expect(res.statusCode).toBe(500);
    expect(keycloak.deleted.length).toBe(deletedBefore + 1);
    const health = await local.app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(503);
    await local.app.close();
    await broken.destroy();
  });

  test('видалення в Keycloak теж упало → 500 і запис у лог для ручної процедури', async () => {
    const broken = createDb('postgres://nobody:wrong@127.0.0.1:1/none', 1);
    const failingDelete = new FakeKeycloak();
    failingDelete.deleteUser = async () => {
      throw new KeycloakError('HTTP 503', 503);
    };
    const local = await testApp({ keycloak: failingDelete, db: broken });
    const res = await local.app.inject({
      method: 'POST',
      url: '/api/v1/tenant/schools',
      headers: { authorization: `Bearer ${await local.tokens.sysadmin()}` },
      payload: { name: 'Ліцей', login: uniqueLogin() },
    });
    expect(res.statusCode).toBe(500);
    expect(local.logs.lines.join('')).toContain('видаліть користувача в консолі Keycloak вручну');
    await local.app.close();
    await broken.destroy();
  });
});

describe('GET /api/v1/tenant/schools', () => {
  test('список: school_id, назва, логін, created_at; новіші зверху', async () => {
    const a = (await register({ name: 'Список А', login: uniqueLogin() })).json();
    const b = (await register({ name: 'Список Б', login: uniqueLogin() })).json();
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/tenant/schools',
      headers: { authorization: `Bearer ${await ctx.tokens.sysadmin()}` },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<Record<string, string>>;
    const ia = list.findIndex((s) => s.school_id === a.school_id);
    const ib = list.findIndex((s) => s.school_id === b.school_id);
    expect(ib).toBeLessThan(ia);
    expect(Object.keys(list[ib]!).sort()).toEqual(['created_at', 'login', 'name', 'school_id']);
    expect(list[ib]).toMatchObject({ name: 'Список Б', login: b.login });
    expect(list.some((s) => 'temporary_password' in s)).toBe(false);
  });
});
