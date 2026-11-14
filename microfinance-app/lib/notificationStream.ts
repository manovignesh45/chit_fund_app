import { createSSERegistry } from './sseRegistry';

/** Open /api/notifications/stream connections, keyed by the signed-in (actor) user id. */
export const notificationClients = createSSERegistry('__notificationSSEClients');

export function pushNotificationEvent(
  userId: number,
  event: 'notification' | 'unread_count',
  data: unknown
): void {
  notificationClients.push(userId, event, data);
}

export function pushToUsers(
  userIds: number[],
  event: 'notification' | 'unread_count',
  data: unknown
): void {
  for (const userId of userIds) {
    pushNotificationEvent(userId, event, data);
  }
}
