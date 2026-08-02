import * as dotenv from 'dotenv';
import * as path from 'path';

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

export const config: Config = {
  BOT_TOKEN: getEnv('BOT_TOKEN').trim(),
  BOT_USERNAME: getEnv('BOT_USERNAME').replace(/[@\s"']/g, '').trim(),
  GROUP_CHAT_ID: parseInt(getEnv('GROUP_CHAT_ID').trim(), 10),
  DATABASE_URL: getEnv('DATABASE_URL').trim(),
  ADMIN_USERNAME: getEnv('ADMIN_USERNAME').replace(/[@\s"']/g, '').trim(),
  ADMIN_CHAT_ID: parseInt(getEnv('ADMIN_CHAT_ID').trim(), 10),
};
