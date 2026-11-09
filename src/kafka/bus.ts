// Межа між сервісом і Kafka. Relay працює з цим інтерфейсом, тож у тестах його підміняє шина
// в пам'яті, а в проді — адаптер @platformatic/kafka (platformatic.ts).
// tenant-service лише публікує (school.registered) і нічого не слухає, тому консюмера тут немає.
// ТИМЧАСОВО до @lad/db: той самий інтерфейс, що в school-service і timetable-service.

export interface OutgoingMessage {
  topic: string;
  /** Ключ партиції — завжди school_id (розділ 12). */
  key: string;
  value: string;
  headers?: Record<string, string>;
}

export interface Producer {
  /** Підтверджує запис усіх повідомлень (acks=all) або кидає виняток. */
  send(messages: OutgoingMessage[]): Promise<void>;
  close(): Promise<void>;
}
