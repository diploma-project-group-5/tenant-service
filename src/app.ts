// HTTP-застосунок tenant-service. Залежності передаються ззовні, тож тести підставляють
// справжній PostgreSQL і підробний Keycloak або навпаки.
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { sql } from 'kysely';
import { requireRole, type TokenVerifier } from './auth.js';
import type { Db } from './db/index.js';
import { LoginTakenError, type KeycloakAdmin } from './keycloak.js';
import { problem, sendProblem } from './problem.js';
import { LOGIN_PATTERN, listSchools, normalizeLogin, registerSchool } from './schools.js';

export interface AppDeps {
  db: Db;
  keycloak: KeycloakAdmin;
  verifyToken: TokenVerifier;
  logger?: FastifyServerOptions['logger'];
}

/** Шлюз не зрізає префікс: маршрути оголошено разом з /api/v1/tenant. */
export const API_PREFIX = '/api/v1/tenant';

const Uuid = Type.String({ format: 'uuid' });

const SchoolRegistration = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 200 }),
    login: Type.String({ minLength: 3, maxLength: 64 }),
  },
  { additionalProperties: false },
);

const SchoolRegistered = Type.Object({
  school_id: Uuid,
  login: Type.String(),
  temporary_password: Type.String(),
});

const SchoolListItem = Type.Object({
  school_id: Uuid,
  name: Type.String(),
  login: Type.String(),
  created_at: Type.String({ format: 'date-time' }),
});

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: deps.logger ?? {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: ['req.headers.authorization', 'temporary_password', '*.temporary_password'],
    },
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof LoginTakenError) {
      return sendProblem(reply, problem(409, 'login_taken', 'Логін уже зайнятий', `Логін ${err.login} уже використовується`));
    }
    const e = err as { validation?: unknown; statusCode?: number; message: string };
    if (e.validation || (e.statusCode && e.statusCode >= 400 && e.statusCode < 500)) {
      return sendProblem(reply, problem(400, 'validation_failed', 'Некоректні дані', e.message));
    }
    request.log.error({ err }, 'необроблена помилка');
    return sendProblem(reply, problem(500, 'internal', 'Внутрішня помилка'));
  });

  app.setNotFoundHandler((_request, reply) => sendProblem(reply, problem(404, 'not_found', 'Не знайдено')));

  // Для healthcheck контейнера. Через шлюз недоступний: шлюз веде лише /api/v1/tenant/*.
  app.get('/health', async (_request, reply) => {
    try {
      await sql`select 1`.execute(deps.db);
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'db_unavailable' });
    }
  });

  const sysadminOnly = requireRole(deps.verifyToken, 'sysadmin');

  app.post(
    `${API_PREFIX}/schools`,
    {
      preHandler: sysadminOnly,
      schema: { body: SchoolRegistration, response: { 201: SchoolRegistered } },
    },
    async (request, reply) => {
      const login = normalizeLogin(request.body.login);
      const name = request.body.name.trim();
      if (!LOGIN_PATTERN.test(login)) {
        return sendProblem(reply, problem(400, 'validation_failed', 'Некоректний логін', 'Логін: 3–64 символи a-z, 0-9, крапка, _ або -'));
      }
      if (!name) {
        return sendProblem(reply, problem(400, 'validation_failed', 'Некоректна назва', 'Назва закладу не може бути порожньою'));
      }
      const result = await registerSchool({ db: deps.db, keycloak: deps.keycloak, log: request.log }, { name, login }, request.id);
      request.log.info({ school_id: result.school_id, login }, 'заклад зареєстровано');
      // Тимчасовий пароль показується один раз: жодних кешів.
      return reply.code(201).header('cache-control', 'no-store').send(result);
    },
  );

  app.get(
    `${API_PREFIX}/schools`,
    { preHandler: sysadminOnly, schema: { response: { 200: Type.Array(SchoolListItem) } } },
    async () => listSchools(deps.db),
  );

  return app;
}
