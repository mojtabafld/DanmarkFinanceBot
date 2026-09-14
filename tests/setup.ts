/**
 * Environment for tests that touch modules reading configuration.
 *
 * Config resolves lazily and caches on first access, so these must be in place before
 * any module under test imports it. Real secrets are never needed: nothing in the
 * suite talks to Telegram, and the integration tests use whatever DATABASE_URL the
 * runner already provides.
 */
process.env.BOT_TOKEN ??= '000000:test-token-not-a-real-secret';
process.env.BOT_USERNAME ??= 'TestBot';
process.env.GROUP_CHAT_ID ??= '-1000000000001';
process.env.ADMIN_USERNAME ??= 'TestAdmin';
process.env.ADMIN_CHAT_ID ??= '111111';
process.env.DATABASE_URL ??= '';
