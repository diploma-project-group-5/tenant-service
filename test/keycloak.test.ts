// Клієнт admin API на справжньому Keycloak 26.8.1 з realm lad (той самий файл, що в platform),
// і повна реєстрація через HTTP: справжній Keycloak + справжній PostgreSQL.
import { afterAll, describe, expect, test } from 'vitest';
import { inject } from 'vitest';
import { createTokenVerifier, remoteKeys } from '../src/auth.js';
import { createKeycloakAdmin, KeycloakError, LoginTakenError } from '../src/keycloak.js';
import { testApp, uniqueLogin } from './helpers.js';

const kc = inject('keycloak');
const created: string[] = [];

async function masterToken(): Promise<string> {
  const res = await fetch(`${kc.url}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: 'admin', password: kc.adminPassword }),
  });
  return ((await res.json()) as { access_token: string }).access_token;
}

// Відповіді admin API у тестах читаємо без опису всіх полів.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function adminGet(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${kc.url}/admin/realms/lad${path}`, { headers: { authorization: `Bearer ${await masterToken()}` } });
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
}

function client(fetchImpl?: typeof fetch) {
  return createKeycloakAdmin({
    baseUrl: kc.url,
    realm: 'lad',
    clientId: 'tenant-service',
    clientSecret: kc.tenantSecret,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

afterAll(async () => {
  const admin = client();
  for (const id of created) await admin.deleteUser(id);
});

describe('клієнт admin API Keycloak', () => {
  test('створює укладача: група schedulers, school_id, обовʼязкова зміна пароля', async () => {
    const login = uniqueLogin();
    const schoolId = crypto.randomUUID();
    const { userId } = await client().createScheduler({ login, schoolId, temporaryPassword: 'Temp-Pass-0123456' });
    created.push(userId);

    const user = await adminGet(`/users/${userId}`);
    expect(user.body).toMatchObject({ username: login, enabled: true, requiredActions: ['UPDATE_PASSWORD'] });
    expect(user.body.attributes.school_id).toEqual([schoolId]);
    const groups = await adminGet(`/users/${userId}/groups`);
    expect(groups.body.map((g: { path: string }) => g.path)).toEqual(['/schedulers']);
    const roles = await adminGet(`/users/${userId}/role-mappings/realm/composite`);
    expect(roles.body.map((r: { name: string }) => r.name)).toContain('scheduler');
  });

  test('зайнятий логін → LoginTakenError', async () => {
    const login = uniqueLogin();
    const { userId } = await client().createScheduler({ login, schoolId: crypto.randomUUID(), temporaryPassword: 'Temp-Pass-0123456' });
    created.push(userId);
    await expect(
      client().createScheduler({ login, schoolId: crypto.randomUUID(), temporaryPassword: 'Temp-Pass-0123456' }),
    ).rejects.toBeInstanceOf(LoginTakenError);
  });

  test('пароль не за політикою → KeycloakError без пароля в повідомленні', async () => {
    const err = await client()
      .createScheduler({ login: uniqueLogin(), schoolId: crypto.randomUUID(), temporaryPassword: 'short' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeycloakError);
    expect((err as Error).message).not.toContain('short');
  });

  test('видаляє користувача; повторне видалення — не помилка', async () => {
    const admin = client();
    const { userId } = await admin.createScheduler({ login: uniqueLogin(), schoolId: crypto.randomUUID(), temporaryPassword: 'Temp-Pass-0123456' });
    await admin.deleteUser(userId);
    expect((await adminGet(`/users/${userId}`)).status).toBe(404);
    await expect(admin.deleteUser(userId)).resolves.toBeUndefined();
  });

  test('сервісний токен береться один раз і кешується', async () => {
    let tokenRequests = 0;
    const counting: typeof fetch = (input, init) => {
      if (String(input).endsWith('/protocol/openid-connect/token')) tokenRequests++;
      return fetch(input, init);
    };
    const admin = client(counting);
    for (let i = 0; i < 3; i++) {
      const { userId } = await admin.createScheduler({ login: uniqueLogin(), schoolId: crypto.randomUUID(), temporaryPassword: 'Temp-Pass-0123456' });
      created.push(userId);
    }
    expect(tokenRequests).toBe(1);
  });

  test('Keycloak не зміг видалити → KeycloakError', async () => {
    const failingDelete: typeof fetch = (input, init) =>
      init?.method === 'DELETE' ? Promise.resolve(new Response('', { status: 500 })) : fetch(input, init);
    await expect(client(failingDelete).deleteUser(crypto.randomUUID())).rejects.toBeInstanceOf(KeycloakError);
  });

  test('неправильний секрет клієнта → KeycloakError', async () => {
    const admin = createKeycloakAdmin({ baseUrl: kc.url, realm: 'lad', clientId: 'tenant-service', clientSecret: 'wrong' });
    await expect(
      admin.createScheduler({ login: uniqueLogin(), schoolId: crypto.randomUUID(), temporaryPassword: 'Temp-Pass-0123456' }),
    ).rejects.toBeInstanceOf(KeycloakError);
  });
});

describe('перевірка JWT за справжніми ключами Keycloak (JWKS)', () => {
  async function serviceAccountToken(): Promise<string> {
    const res = await fetch(`${kc.url}/realms/lad/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: 'tenant-service', client_secret: kc.tenantSecret }),
    });
    return ((await res.json()) as { access_token: string }).access_token;
  }
  const keys = () => remoteKeys(`${kc.url}/realms/lad/protocol/openid-connect/certs`);
  // iss — та адреса, яку Keycloak вважає публічною; беремо її з discovery, а не вгадуємо.
  const issuer = async () =>
    ((await (await fetch(`${kc.url}/realms/lad/.well-known/openid-configuration`)).json()) as { issuer: string }).issuer;

  test('підпис і iss справжнього токена проходять перевірку', async () => {
    const verify = createTokenVerifier({ issuer: await issuer(), clientId: 'tenant-service', keys: keys() });
    const payload = await verify(await serviceAccountToken());
    expect(payload.azp).toBe('tenant-service');
  });

  test('токен іншого клієнта відхиляється (сервіс приймає лише web)', async () => {
    const verify = createTokenVerifier({ issuer: await issuer(), clientId: 'web', keys: keys() });
    await expect(verify(await serviceAccountToken())).rejects.toThrow(/azp/);
  });

  test('чужий iss відхиляється навіть з правильним підписом', async () => {
    const verify = createTokenVerifier({ issuer: 'http://evil/idp/realms/lad', clientId: 'tenant-service', keys: keys() });
    await expect(verify(await serviceAccountToken())).rejects.toThrow();
  });
});

describe('реєстрація через HTTP зі справжнім Keycloak і PostgreSQL', () => {
  test('POST /schools створює укладача в Keycloak з тим самим school_id, що й у реєстрі', async () => {
    const ctx = await testApp({ keycloak: client() });
    try {
      const login = uniqueLogin();
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/tenant/schools',
        headers: { authorization: `Bearer ${await ctx.tokens.sysadmin()}` },
        payload: { name: 'Ліцей інтеграції', login },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      const row = await ctx.db.selectFrom('schools').selectAll().where('school_id', '=', body.school_id).executeTakeFirstOrThrow();
      created.push(row.scheduler_user_id);
      const user = await adminGet(`/users/${row.scheduler_user_id}`);
      expect(user.body.username).toBe(login);
      expect(user.body.attributes.school_id).toEqual([body.school_id]);

      const again = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/tenant/schools',
        headers: { authorization: `Bearer ${await ctx.tokens.sysadmin()}` },
        payload: { name: 'Дубль', login },
      });
      expect(again.statusCode).toBe(409);
      expect(again.json().code).toBe('login_taken');
    } finally {
      await ctx.app.close();
      await ctx.db.destroy();
    }
  });
});
