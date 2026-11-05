import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Піднімає PostgreSQL 16.15 і Keycloak 26.8.1 (Testcontainers) один раз на весь прогін.
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Точки входу лише збирають залежності й запускають процес.
      exclude: ['src/server.ts', 'src/migrate.ts'],
      reporter: ['text', 'text-summary'],
      // Новий код без тестів не пройде: покриття не може впасти нижче цих порогів.
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 80 },
    },
  },
});
