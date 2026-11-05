// Реєстр закладів (розділ 06, «Реєстрація й перший вхід»).
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { withSchool, type Db } from './db/index.js';
import { LoginTakenError, type KeycloakAdmin } from './keycloak.js';
import { generateTemporaryPassword } from './password.js';

export const LOGIN_PATTERN = /^[a-z0-9._-]{3,64}$/;

export interface RegisterSchoolInput {
  name: string;
  login: string;
}

export interface RegisteredSchool {
  school_id: string;
  login: string;
  /** Показується адміну один раз; сервіс його не зберігає й не логує. */
  temporary_password: string;
}

export interface SchoolListItem {
  school_id: string;
  name: string;
  login: string;
  created_at: string;
}

export interface SchoolsDeps {
  db: Db;
  keycloak: KeycloakAdmin;
  log: FastifyBaseLogger;
}

/** Логін так, як його збереже Keycloak: без пробілів по краях і в нижньому регістрі. */
export const normalizeLogin = (login: string): string => login.trim().toLowerCase();

/**
 * 1. Укладач у Keycloak (група schedulers, school_id, тимчасовий пароль, UPDATE_PASSWORD).
 * 2. Однією транзакцією — заклад у реєстрі й подія school.registered в outbox.
 * 3. Якщо транзакція не вдалася — користувача в Keycloak видаляємо.
 * Падіння процесу між кроками 1 і 2 лишає користувача без закладу: прийнятий ризик MVP,
 * ручна процедура адміна (розділ 06): видалити користувача в консолі й повторити POST /schools.
 */
export async function registerSchool(
  deps: SchoolsDeps,
  input: RegisterSchoolInput,
  correlationId: string,
): Promise<RegisteredSchool> {
  const name = input.name.trim();
  const login = normalizeLogin(input.login);
  const schoolId = randomUUID();
  const temporaryPassword = generateTemporaryPassword();

  const { userId } = await deps.keycloak.createScheduler({ login, schoolId, temporaryPassword });

  try {
    await withSchool(deps.db, schoolId, async (trx) => {
      const registeredAt = new Date().toISOString();
      await trx
        .insertInto('schools')
        .values({ school_id: schoolId, name, scheduler_login: login, scheduler_user_id: userId })
        .execute();
      const eventId = randomUUID();
      await trx
        .insertInto('outbox')
        .values({
          school_id: schoolId,
          event_id: eventId,
          topic: 'school.registered',
          payload: JSON.stringify({
            event_id: eventId,
            type: 'school.registered',
            schema_version: '1.0',
            source: 'tenant-service',
            time: registeredAt,
            correlation_id: correlationId,
            school_id: schoolId,
            data: { school_id: schoolId, name, registered_at: registeredAt },
          }),
        })
        .execute();
    });
  } catch (err) {
    try {
      await deps.keycloak.deleteUser(userId);
    } catch (rollbackErr) {
      deps.log.error(
        { err: rollbackErr, userId, login },
        'відкат не вдався: видаліть користувача в консолі Keycloak вручну',
      );
    }
    // Логін є в реєстрі, але його вже не було в Keycloak (видалили вручну) — той самий 409.
    if ((err as { code?: string }).code === '23505') throw new LoginTakenError(login);
    throw err;
  }

  return { school_id: schoolId, login, temporary_password: temporaryPassword };
}

export async function listSchools(db: Db): Promise<SchoolListItem[]> {
  const rows = await db
    .selectFrom('schools')
    .select(['school_id', 'name', 'scheduler_login', 'created_at'])
    .orderBy('created_at', 'desc')
    .execute();
  return rows.map((r) => ({
    school_id: r.school_id,
    name: r.name,
    login: r.scheduler_login,
    created_at: r.created_at.toISOString(),
  }));
}
