import { createSSERegistry } from './sseRegistry';

/** Open /api/messages/stream connections, keyed by the signed-in (actor) user id. */
export const messageClients = createSSERegistry('__messageSSEClients');

export function pushMessageEvent(
  userId: number,
  event: 'chat_message' | 'unread_count',
  data: unknown
): void {
  messageClients.push(userId, event, data);
}

export function pushMessageToUsers(
  userIds: number[],
  event: 'chat_message' | 'unread_count',
  data: unknown
): void {
  for (const userId of userIds) {
    pushMessageEvent(userId, event, data);
  }
}
