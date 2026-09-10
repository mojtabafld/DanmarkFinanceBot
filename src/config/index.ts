import * as dotenv from 'dotenv';

// Load env variables
dotenv.config();

export interface Config {
  BOT_TOKEN: string;
  BOT_USERNAME: string;
  GROUP_CHAT_ID: number;
  DATABASE_URL: string;
  ADMIN_USERNAME: string;
  ADMIN_CHAT_ID: number;
}

function getEnv(key: string, required = true): string {
  const value = process.env[key];
  if (required && !value) {
    throw new Error(`Environment variable ${key} is missing!`);
  }
  return value || '';
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
  ADMIN_CHAT_ID: () => getNumericEnv('ADMIN_CHAT_ID')
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
