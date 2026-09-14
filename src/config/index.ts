import * as dotenv from 'dotenv';

// Load env variables
dotenv.config();

export interface Config {
  BOT_TOKEN: string;
  BOT_USERNAME: string;
  GROUP_CHAT_ID: number;
  DATABASE_URL: string;
  ADMIN_USERNAME: string;
  /** Legacy single-admin id. Still read so existing deployments keep working. */
  ADMIN_CHAT_ID: number;
  /** Where admin notifications go. May be a group chat. */
  ADMIN_NOTIFY_CHAT_ID: number;
  /**
   * The one admin who is always recognised, so a fresh deployment has someone who
   * can populate the Admin table and an emptied table cannot lock everyone out.
   * This must be an individual Telegram id, never a group.
   */
  BOOTSTRAP_ADMIN_ID: number;
  /** Hours an identity document is kept after upload before it is deleted. */
  DOCUMENT_RETENTION_HOURS: number;
}

function getEnv(key: string, required = true): string {
  const value = process.env[key];
  if (required && !value) {
    throw new Error(`Environment variable ${key} is missing!`);
  }
  return value || '';
}

function optionalNumericEnv(key: string, fallback: () => number): number {
  const raw = (process.env[key] ?? '').trim();
  if (!raw) return fallback();
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${key} must be a number, got "${raw}"`);
  }
  return parsed;
}

function getNumericEnv(key: string): number {
  const raw = getEnv(key).trim();
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${key} must be a number, got "${raw}"`);
  }
  return parsed;
}

/**
 * Config values are resolved lazily on first property access rather than at import
 * time. Importing a module that only needs, say, a date formatter must not crash the
 * process (or a unit test) just because BOT_TOKEN is unset. Startup still fails fast:
 * `validateConfig()` is called from src/index.ts before the bot launches.
 */
const resolvers: { [K in keyof Config]: () => Config[K] } = {
  BOT_TOKEN: () => getEnv('BOT_TOKEN').trim(),
  BOT_USERNAME: () => getEnv('BOT_USERNAME').replace(/[@\s"']/g, '').trim(),
  GROUP_CHAT_ID: () => getNumericEnv('GROUP_CHAT_ID'),
  DATABASE_URL: () => getEnv('DATABASE_URL').trim(),
  ADMIN_USERNAME: () => getEnv('ADMIN_USERNAME').replace(/[@\s"']/g, '').trim(),
  ADMIN_CHAT_ID: () => getNumericEnv('ADMIN_CHAT_ID'),
  // Both default to the legacy variable, which keeps current deployments running.
  // Split them when the admin chat becomes a group: the notify id may be the group,
  // the bootstrap id must stay an individual or nobody can pass the identity check.
  ADMIN_NOTIFY_CHAT_ID: () => optionalNumericEnv('ADMIN_NOTIFY_CHAT_ID', () => getNumericEnv('ADMIN_CHAT_ID')),
  BOOTSTRAP_ADMIN_ID: () => optionalNumericEnv('BOOTSTRAP_ADMIN_ID', () => getNumericEnv('ADMIN_CHAT_ID')),
  DOCUMENT_RETENTION_HOURS: () => optionalNumericEnv('DOCUMENT_RETENTION_HOURS', () => 24)
};

const cache = new Map<keyof Config, Config[keyof Config]>();

export const config: Config = Object.defineProperties(
  {} as Config,
  Object.fromEntries(
    (Object.keys(resolvers) as (keyof Config)[]).map(key => [
      key,
      {
        enumerable: true,
        get() {
          if (!cache.has(key)) cache.set(key, resolvers[key]());
          return cache.get(key);
        }
      }
    ])
  )
);

/** Resolves every config value so missing or malformed env vars fail at startup. */
export function validateConfig(): void {
  for (const key of Object.keys(resolvers) as (keyof Config)[]) {
    void config[key];
  }
}
