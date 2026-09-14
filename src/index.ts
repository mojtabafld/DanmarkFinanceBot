import { bot } from './bot';
import { prisma } from './database/db';
import { pruneStaleSessions } from './database/sessionStore';
import { validateConfig } from './config';
import { startDeadlineSweep } from './jobs/deadlineSweep';
import { pruneIdleBuckets } from './data/rateLimit';
import * as http from 'http';

async function main() {
  try {
    // Resolve every environment variable up front so a misconfigured deploy fails
    // here rather than at the first message that happens to need the value.
    validateConfig();

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

    const pruned = await pruneStaleSessions();
    if (pruned > 0) console.log(`🧹 Removed ${pruned} stale session(s).`);
    await pruneIdleBuckets().catch(err => console.error('Rate bucket prune failed:', err));

    // Nothing else moves a stalled trade, so this must be running for a deal to have
    // any deadline at all.
    const stopSweep = startDeadlineSweep(bot.telegram);

    // Enable graceful stop. These must be registered BEFORE launching: under long
    // polling `bot.launch()` does not resolve until polling stops, so anything
    // awaited after it never runs and the process had no SIGTERM handling at all.
    let stopping = false;
    const stopApp = async (signal: string) => {
      if (stopping) return;
      stopping = true;
      console.log(`⏳ Stopping application (${signal})...`);
      try {
        stopSweep();
        bot.stop(signal);
        await new Promise<void>(resolve => server.close(() => resolve()));
        await prisma.$disconnect();
      } catch (err) {
        console.error('Error during shutdown:', err);
      } finally {
        process.exit(0);
      }
    };

    process.once('SIGINT', () => void stopApp('SIGINT'));
    process.once('SIGTERM', () => void stopApp('SIGTERM'));

    console.log('⏳ Starting Telegram Bot...');
    // Deliberately not awaited: with long polling this promise settles only when the
    // bot stops. The onLaunch callback fires once Telegram has accepted the bot.
    bot
      .launch({ allowedUpdates: ['message', 'callback_query', 'chat_member'] }, () =>
        console.log('🚀 Telegram Bot is running and listening for updates!')
      )
      .catch(err => {
        console.error('❌ Bot polling stopped unexpectedly:', err);
        process.exit(1);
      });

  } catch (error) {
    console.error('❌ Critical error during bot startup:', error);
    process.exit(1);
  }
}

main();
