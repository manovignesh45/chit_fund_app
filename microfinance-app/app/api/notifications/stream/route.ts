import { NextRequest } from 'next/server';
import prisma from '../../../../lib/prisma';
import { getActorUserId, getSessionExpiry } from '../../../../lib/auth';
import { notificationClients } from '../../../../lib/notificationStream';
import { openSSEStream } from '../../../../lib/sseRegistry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const userId = await getActorUserId(request);
  if (!userId) {
    return new Response('Unauthorized', { status: 401 });
  }

  return openSSEStream({
    request,
    registry: notificationClients,
    userId,
    expiresAt: await getSessionExpiry(request),
    connected: async () => ({
      unreadCount: await prisma.notification.count({ where: { userId, read: false } }),
    }),
  });
}
