import 'dotenv/config';
import { createApp } from './app';
import logger from './utils/logger';
import { startKafkaPaymentConsumer, stopKafkaPaymentConsumer } from './worker/KafkaPaymentConsumer';
import { disconnectProducer } from './kafka/producer';
import prisma from './config/prisma';

const PORT = Number(process.env.PORT || 5070);

async function main() {
  const app = createApp();
  const server = app.listen(PORT, () => {
    logger.info('Notification Service HTTP listening on :%d', PORT);
  });

  // Run the Kafka consumer in the same process so a single container exposes
  // both REST and the dispatcher worker. Split into a worker-server.ts later
  // if horizontal scaling needs separate scaling profiles.
  await startKafkaPaymentConsumer();

  const shutdown = async (signal: string) => {
    logger.info('Received %s, shutting down…', signal);
    server.close();
    await stopKafkaPaymentConsumer();
    await disconnectProducer();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('Fatal startup error: %s', err.message);
  process.exit(1);
});
