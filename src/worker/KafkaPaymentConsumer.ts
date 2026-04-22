import { Kafka, Consumer, EachMessagePayload, logLevel } from 'kafkajs';
import logger from '@/utils/logger';
import { dispatchPaymentEvent, PaymentEvent } from './NotificationDispatcher';

const enabled = (process.env.KAFKA_ENABLED || '').toLowerCase() === 'true';
const brokers = (process.env.KAFKA_BROKERS || 'nn-kafka:9092').split(',');
const clientId = process.env.KAFKA_CLIENT_ID || 'notification-service';
const groupId = process.env.KAFKA_CONSUMER_GROUP || 'notification-dispatcher';
const topic = process.env.KAFKA_PAYMENT_EVENTS_TOPIC || 'payment.events';

let consumer: Consumer | null = null;

export async function startKafkaPaymentConsumer(): Promise<void> {
  if (!enabled) {
    logger.info('[KafkaConsumer] disabled (KAFKA_ENABLED != true)');
    return;
  }

  try {
    const kafka = new Kafka({ clientId, brokers, logLevel: logLevel.NOTHING });
    consumer = kafka.consumer({ groupId });
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: false });
    logger.info('[KafkaConsumer] subscribed to %s (group=%s)', topic, groupId);

    await consumer.run({
      eachMessage: async ({ message }: EachMessagePayload) => {
        if (!message.value) return;
        let evt: PaymentEvent;
        try {
          evt = JSON.parse(message.value.toString());
        } catch (err: any) {
          logger.error('[KafkaConsumer] invalid JSON: %s', err.message);
          return;
        }
        try {
          await dispatchPaymentEvent(evt);
        } catch (err: any) {
          // Never throw — that would re-deliver forever. Log and move on.
          logger.error('[KafkaConsumer] dispatch failed: %s', err.message);
        }
      },
    });
  } catch (err: any) {
    logger.error('[KafkaConsumer] failed to start: %s', err.message);
  }
}

export async function stopKafkaPaymentConsumer(): Promise<void> {
  if (consumer) {
    await consumer.disconnect();
    consumer = null;
  }
}
