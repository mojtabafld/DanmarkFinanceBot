import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * Test files run one at a time.
     *
     * The integration suites share one PostgreSQL database and each truncates the
     * tables it uses, so running them in parallel made them wipe each other's
     * fixtures mid-assertion. That produced failures that came and went between runs,
     * which is worse than no coverage: it teaches you to re-run until green.
     *
     * The whole suite takes a couple of seconds, so serialising costs nothing worth
     * having. Per-file isolation via separate schemas would be the answer if it ever
     * did.
     */
    setupFiles: ['./tests/setup.ts'],
    fileParallelism: false,
    sequence: { concurrent: false }
  }
});
