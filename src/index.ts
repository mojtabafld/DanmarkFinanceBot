import { bot } from './bot';
import { prisma } from './database/db';
import * as http from 'http';

async function main() {
  try {
    console.log('⏳ Connecting to database...');
    // Test the database connection
    await prisma.$connect();
    console.log('✅ Database connection established successfully.');

    // Start a dummy HTTP server for DigitalOcean App Platform Health Checks
    const port = process.env.PORT || 3000;
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
    });

    server.listen(port, () => {
      console.log(`📡 Health check server listening on port ${port}`);
    });

    console.log('⏳ Starting Telegram Bot...');
    // Launch the bot (uses Long Polling)
    await bot.launch();
    console.log('🚀 Telegram Bot is running and listening for updates!');

    // Enable graceful stop
    const stopApp = () => {
      console.log('⏳ Stopping application...');
      bot.stop();
      server.close(() => {
        prisma.$disconnect();
        process.exit(0);
      });
    };

    process.once('SIGINT', stopApp);
    process.once('SIGTERM', stopApp);

  } catch (error) {
    console.error('❌ Critical error during bot startup:', error);
    process.exit(1);
  }
}

main();
