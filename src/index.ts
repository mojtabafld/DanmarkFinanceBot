import { bot } from './bot';
import { prisma } from './database/db';

async function main() {
  try {
    console.log('⏳ Connecting to database...');
    // Test the database connection
    await prisma.$connect();
    console.log('✅ Database connection established successfully.');

    console.log('⏳ Starting Telegram Bot...');
    // Launch the bot (uses Long Polling)
    await bot.launch();
    console.log('🚀 Telegram Bot is running and listening for updates!');

    // Enable graceful stop
    process.once('SIGINT', () => {
      console.log('⏳ Stopping bot (SIGINT)...');
      bot.stop('SIGINT');
    });
    process.once('SIGTERM', () => {
      console.log('⏳ Stopping bot (SIGTERM)...');
      bot.stop('SIGTERM');
    });

  } catch (error) {
    console.error('❌ Critical error during bot startup:', error);
    process.exit(1);
  }
}

main();
