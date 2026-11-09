import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Піднімає PostgreSQL 16.15 і Keycloak 26.8.1 (Testcontainers) один раз на весь прогін.
    globalSetup: ['test/global-setup.ts'],
    // Файли по черзі: relay забирає з outbox усі ненадіслані рядки бази, і паралельний прогін
    // інших файлів зробив би їхні перевірки outbox випадковими.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Точки входу лише збирають залежності й запускають процес. Адаптер Kafka перевіряє
      // relay.test.ts зі справжньою Kafka; без Docker (TEST_KAFKA=off) його пропускають, тож у поріг він не входить.
      exclude: ['src/server.ts', 'src/migrate.ts', 'src/kafka/platformatic.ts'],
      reporter: ['text', 'text-summary'],
      // Новий код без тестів не пройде: покриття не може впасти нижче цих порогів.
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 80 },
    },
  },
});
