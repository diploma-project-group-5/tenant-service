// Доступ: лише токен клієнта web з роллю sysadmin; помилки — application/problem+json.
import { generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { testApp } from './helpers.js';

let ctx: Awaited<ReturnType<typeof testApp>>;
beforeAll(async () => {
  ctx = await testApp();
});
afterAll(async () => {
  await ctx.app.close();
  await ctx.db.destroy();
});

const getSchools = (token?: string) =>
  ctx.app.inject({
    method: 'GET',
    url: '/api/v1/tenant/schools',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

describe('доступ до /api/v1/tenant/schools', () => {
  test('без токена → 401 problem+json', async () => {
    const res = await getSchools();
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ status: 401, code: 'unauthorized' });
  });

  test('сміття замість токена → 401', async () => {
    expect((await getSchools('not-a-jwt')).statusCode).toBe(401);
  });

  test('заголовок без Bearer → 401', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/tenant/schools', headers: { authorization: 'Basic abc' } });
    expect(res.statusCode).toBe(401);
  });

  test('прострочений токен → 401', async () => {
    const token = await ctx.tokens.sign({ realm_access: { roles: ['sysadmin'] } }, { expiresIn: Math.floor(Date.now() / 1000) - 60 });
    expect((await getSchools(token)).statusCode).toBe(401);
  });

  test('чужий iss → 401', async () => {
    const token = await ctx.tokens.sign({ realm_access: { roles: ['sysadmin'] } }, { issuer: 'http://evil/idp/realms/lad' });
    expect((await getSchools(token)).statusCode).toBe(401);
  });

  test('токен іншого клієнта (azp) → 401', async () => {
    const token = await ctx.tokens.sign({ azp: 'tenant-service', realm_access: { roles: ['sysadmin'] } });
    expect((await getSchools(token)).statusCode).toBe(401);
  });

  test('підписаний чужим ключем → 401', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    const token = await ctx.tokens.sign({ realm_access: { roles: ['sysadmin'] } }, { key: privateKey });
    expect((await getSchools(token)).statusCode).toBe(401);
  });

  test('укладач (scheduler) → 403', async () => {
    const res = await getSchools(await ctx.tokens.scheduler());
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ status: 403, code: 'forbidden' });
  });

  test('sysadmin → 200', async () => {
    expect((await getSchools(await ctx.tokens.sysadmin())).statusCode).toBe(200);
  });

  test('POST без ролі sysadmin нічого не створює', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tenant/schools',
      headers: { authorization: `Bearer ${await ctx.tokens.scheduler()}` },
      payload: { name: 'Ліцей', login: 'nope-login' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('інше', () => {
  test('битий JSON у тілі → 400 problem+json', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tenant/schools',
      headers: { authorization: `Bearer ${await ctx.tokens.sysadmin()}`, 'content-type': 'application/json' },
      payload: '{"name": ',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'validation_failed' });
  });

  test('токен без azp → 401', async () => {
    const token = await ctx.tokens.sign({ azp: undefined, realm_access: { roles: ['sysadmin'] } });
    expect((await getSchools(token)).statusCode).toBe(401);
  });

  test('невідомий маршрут → 404 problem+json', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/tenant/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'not_found' });
  });

  test('/health перевіряє базу', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});
