// Адаптер Kafka на @platformatic/kafka — та сама бібліотека й налаштування, що в school-service
// і timetable-service. Продюсер ідемпотентний з acks=all; топіки створює лише kafka-init.
import { Producer as KafkaProducer, ProduceAcks, stringSerializers } from '@platformatic/kafka';
import type { OutgoingMessage, Producer } from './bus.js';

export function createProducer(opts: { brokers: string[]; clientId: string }): Producer {
  const producer = new KafkaProducer({
    clientId: opts.clientId,
    bootstrapBrokers: opts.brokers,
    serializers: stringSerializers,
    idempotent: true,
    acks: ProduceAcks.ALL,
    // auto.create.topics.enable=false: неіснуючий топік — помилка, а не мовчазне створення.
    autocreateTopics: false,
  });
  return {
    async send(messages: OutgoingMessage[]) {
      if (messages.length === 0) return;
      await producer.send({
        messages: messages.map((m) => ({ topic: m.topic, key: m.key, value: m.value, ...(m.headers ? { headers: m.headers } : {}) })),
      });
    },
    close: () => producer.close(),
  };
}
