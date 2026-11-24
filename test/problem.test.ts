// Розділ 07: кожна помилка — application/problem+json з type, title, status, code (detail — за потреби).
// Перевіряємо всі види помилок сервісу одним правилом, а не лише status і code в окремих тестах.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { KeycloakError } from '../src/keycloak.js';
import { FakeKeycloak, testApp, uniqueLogin } from './helpers.js';

let ctx: Awaited<ReturnType<typeof testApp>>;
let keycloak: FakeKeycloak;
beforeAll(async () => {
  keycloak = new FakeKeycloak();
  ctx = await testApp({ keycloak });
});
afterAll(async () => {
  await ctx.app.close();
  await ctx.db.destroy();
});

type Res = Awaited<ReturnType<typeof ctx.app.inject>>;

function expectProblem(res: Res, status: number, code: string) {
  expect(res.statusCode).toBe(status);
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  const body = res.json();
  expect(body).toMatchObject({ type: `urn:lad:problem:${code}`, status, code });
  expect(typeof body.title).toBe('string');
  expect(body.title.length).toBeGreaterThan(0);
  // Лише поля формату: внутрішні подробиці (стек, SQL, повідомлення бібліотек) назовні не йдуть.
  for (const key of Object.keys(body)) expect(['type', 'title', 'status', 'code', 'detail']).toContain(key);
}

const post = async (payload: unknown, token?: string) =>
  ctx.app.inject({
    method: 'POST',
    url: '/api/v1/tenant/schools',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: payload as object,
  });

describe('формат помилок problem+json (розділ 07)', () => {
  test('401 без токена', async () => {
    expectProblem(await ctx.app.inject({ method: 'GET', url: '/api/v1/tenant/schools' }), 401, 'unauthorized');
  });

  test('403 укладач на маршруті адміна', async () => {
    expectProblem(await post({ name: 'Ліцей', login: uniqueLogin() }, await ctx.tokens.scheduler()), 403, 'forbidden');
  });

  test('404 невідомий маршрут', async () => {
    expectProblem(await ctx.app.inject({ method: 'GET', url: '/api/v1/tenant/nope' }), 404, 'not_found');
  });

  test('400 некоректне тіло', async () => {
    expectProblem(await post({ name: 'Ліцей' }, await ctx.tokens.sysadmin()), 400, 'validation_failed');
  });

  test('409 зайнятий логін', async () => {
    const login = uniqueLogin();
    const token = await ctx.tokens.sysadmin();
    expect((await post({ name: 'Ліцей', login }, token)).statusCode).toBe(201);
    expectProblem(await post({ name: 'Інший ліцей', login }, token), 409, 'login_taken');
  });

  test('500 збій Keycloak — без подробиць збою назовні', async () => {
    keycloak.failCreateWith = new KeycloakError('Keycloak не видав сервісний токен: HTTP 503', 503);
    try {
      const res = await post({ name: 'Ліцей', login: uniqueLogin() }, await ctx.tokens.sysadmin());
      expectProblem(res, 500, 'internal');
      expect(res.body).not.toContain('503');
    } finally {
      keycloak.failCreateWith = null;
    }
  });
});
