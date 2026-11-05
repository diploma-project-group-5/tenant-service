# tenant-service

Реєстр закладів «Лад» і створення укладача розкладу в Keycloak. Єдиний сервіс, що працює з усіма закладами й тримає секрет admin API Keycloak (специфікація, розділи 02, 06, 15).

Node 24 · TypeScript 6.0 · Fastify 5 · Kysely + PostgreSQL 16 · jose · Vitest 4.1 + Testcontainers.

## API

Усі маршрути — лише з токеном клієнта `web` і роллю `sysadmin`. Без токена або з недійсним — 401, без ролі — 403. Помилки — `application/problem+json` з полем `code`.

| Маршрут | Відповідь |
|---|---|
| `POST /api/v1/tenant/schools` `{ "name", "login" }` | 201 `{ "school_id", "login", "temporary_password" }`, заголовок `Cache-Control: no-store`; 409 `login_taken`; 400 `validation_failed` |
| `GET /api/v1/tenant/schools` | 200 `[{ "school_id", "name", "login", "created_at" }]`, новіші зверху |
| `GET /health` | 200 `{ "status": "ok" }` або 503, якщо недоступна база; через шлюз не відкривається |

Логін: 3–64 символи `a-z 0-9 . _ -`, зберігається в нижньому регістрі (так само його зберігає Keycloak). Назва: 1–200 символів, пробіли по краях обрізаються.

## Реєстрація закладу

1. Укладач створюється в Keycloak одним запитом: група `schedulers` (дає роль `scheduler`), атрибут `school_id`, тимчасовий пароль із 16 випадкових символів і обов'язкова зміна пароля при першому вході.
2. Однією транзакцією в базу пишуться заклад у реєстрі й подія `school.registered` в outbox.
3. Якщо транзакція не вдалася, користувача в Keycloak видаляємо. Якщо не вдалося й видалення, у лозі буде повідомлення для ручної процедури.

Тимчасовий пароль показується адміну один раз, сервіс його не зберігає й не пише в лог (є тест).

Прийнятий ризик MVP (розділ 06): якщо процес упаде між кроками 1 і 2, у Keycloak лишиться користувач без закладу, і повторний `POST /schools` з тим самим логіном дасть 409. Тоді адмін видаляє користувача в консолі Keycloak і повторює реєстрацію.

## База даних

| Таблиця | RLS | Хто що може |
|---|---|---|
| `schools` — реєстр | немає (задокументований виняток) | `tenant_app`: SELECT, INSERT |
| `outbox` — події | `FORCE ROW LEVEL SECURITY` | `tenant_app`: INSERT лише свого закладу; `tenant_relay`: SELECT, UPDATE усіх; `tenant_maint`: SELECT, DELETE усіх |

Таблиці належать `tenant_owner`, міграції запускаються окремою командою (`make migrate`), не при старті сервісу. Ролі й базу створює `db-init` у репозиторії `platform`.

> **Тимчасово до появи пакета `@lad/db`.** `withSchool` і запис в outbox поки живуть у `src/db/index.ts`. Коли пакет з'явиться, вони замінюються імпортом з нього, а міграція outbox звіряється з його схемою. Відправлення подій з outbox у Kafka (relay) — теж частина `@lad/db`, у цьому сервісі його немає.

## Локальна розробка

Потрібні Node 24 (`node -v`) і запущений Docker.

```bash
cp .env.example .env
make install
make migrate
make dev
```

Перед цим у `platform` має працювати `make up`. Сервіс слухає `:3001`, шлюз сам веде на нього `http://localhost/api/v1/tenant/...`. Токен адміна для curl: у `platform` виконати `make token u=sysadmin p=<SYSADMIN_PASSWORD>`.

Admin API Keycloak сервіс викликає **напряму** (`KEYCLOAK_URL=http://localhost:8180/idp`), а не через шлюз: шлюз навмисно закриває `/idp/admin`.

## Тести

```bash
make test
```

Vitest сам піднімає PostgreSQL 16.15 і Keycloak 26.8.1 у контейнерах (Testcontainers) — потрібен лише запущений Docker. Keycloak імпортує `test/fixtures/lad-realm.json` — копію realm з `platform`; CI перевіряє, що копія не розійшлася з `platform/develop`.

| Файл | Що перевіряє |
|---|---|
| `test/auth.test.ts` | 401/403 на всі види поганих токенів, problem+json, 404, `/health` |
| `test/schools.test.ts` | реєстрація, outbox і конверт події, нормалізація логіна, 409, валідація, пароль не в лозі, відкат користувача Keycloak |
| `test/db.test.ts` | RLS на outbox, права ролей, відсутність BYPASSRLS, міграції up/down |
| `test/keycloak.test.ts` | клієнт admin API на справжньому Keycloak, перевірка JWT за справжнім JWKS, повна реєстрація через HTTP |
| `test/units.test.ts` | тимчасовий пароль, конфігурація |

Покриття: поріг 90% рядків і функцій, 80% гілок — нижче CI не пропустить.

Правило: нова поведінка — новий тест у тій самій гілці; знайдена помилка — спершу тест, що її відтворює.

## Команди

| Команда | Що робить |
|---|---|
| `make install` | залежності точно за `package-lock.json` |
| `make dev` | сервіс з перезапуском при змінах |
| `make migrate` | міграції бази tenant |
| `make test` | усі тести з покриттям |
| `make check` | lint + типи + тести, як у CI |
| `make build` | зібрати `dist/` |
| `make docker-build` | зібрати образ |
