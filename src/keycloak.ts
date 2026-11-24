// Admin API Keycloak від імені сервісного акаунта tenant-service.
// Права акаунта — лише на користувачів (manage-users, view-users, query-users); роль scheduler
// укладач отримує через групу /schedulers, тож роль окремо читати й призначати не треба.

export interface CreateSchedulerInput {
  login: string;
  schoolId: string;
  temporaryPassword: string;
}

export interface KeycloakAdmin {
  /** Створює укладача з тимчасовим паролем і обов'язковою зміною. Зайнятий логін — LoginTakenError. */
  createScheduler(input: CreateSchedulerInput): Promise<{ userId: string }>;
  /** Видаляє користувача (відкат реєстрації). Відсутній користувач — не помилка. */
  deleteUser(userId: string): Promise<void>;
}

export class LoginTakenError extends Error {
  constructor(readonly login: string) {
    super(`Логін ${login} уже зайнятий`);
    this.name = 'LoginTakenError';
  }
}

export class KeycloakError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'KeycloakError';
  }
}

export interface KeycloakAdminOptions {
  /** Keycloak внутрішньою мережею, разом з /idp: http://keycloak:8080/idp */
  baseUrl: string;
  realm: string;
  clientId: string;
  clientSecret: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export function createKeycloakAdmin(opts: KeycloakAdminOptions): KeycloakAdmin {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const realmUrl = `${opts.baseUrl}/realms/${opts.realm}`;
  const adminUrl = `${opts.baseUrl}/admin/realms/${opts.realm}`;
  let cached: { token: string; expiresAt: number } | null = null;

  async function serviceToken(): Promise<string> {
    if (cached && cached.expiresAt - Date.now() > 30_000) return cached.token;
    const res = await doFetch(`${realmUrl}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new KeycloakError(`Keycloak не видав сервісний токен: HTTP ${res.status}`, res.status);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    cached = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return cached.token;
  }

  async function admin(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await doFetch(`${adminUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await serviceToken()}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401) cached = null;
    return res;
  }

  return {
    async createScheduler({ login, schoolId, temporaryPassword }) {
      const res = await admin('POST', '/users', {
        username: login,
        enabled: true,
        groups: ['/schedulers'],
        attributes: { school_id: [schoolId] },
        credentials: [{ type: 'password', value: temporaryPassword, temporary: true }],
        requiredActions: ['UPDATE_PASSWORD'],
      });
      if (res.status === 409) throw new LoginTakenError(login);
      if (res.status !== 201) {
        // Тіло відповіді Keycloak не містить пароля, але в повідомлення його все одно не беремо.
        throw new KeycloakError(`Keycloak не створив користувача: HTTP ${res.status}`, res.status);
      }
      const userId = res.headers.get('location')?.split('/').pop();
      if (!userId) throw new KeycloakError('Keycloak не повернув Location нового користувача', res.status);
      return { userId };
    },

    async deleteUser(userId) {
      const res = await admin('DELETE', `/users/${encodeURIComponent(userId)}`);
      if (res.status !== 204 && res.status !== 404) {
        throw new KeycloakError(`Keycloak не видалив користувача ${userId}: HTTP ${res.status}`, res.status);
      }
    },
  };
}
