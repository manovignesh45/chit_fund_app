import { NextRequest } from 'next/server';
import { getCurrentUserId, getActorUserId, getSessionExpiry } from '../../../../lib/auth';
import { getUnreadMessageCount } from '../../../../lib/messages';
import { messageClients } from '../../../../lib/messageStream';
import { openSSEStream } from '../../../../lib/sseRegistry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const actorId = await getActorUserId(request);
  const dataOwnerId = await getCurrentUserId(request);
  if (!actorId || !dataOwnerId) {
    return new Response('Unauthorized', { status: 401 });
  }

  return openSSEStream({
    request,
    registry: messageClients,
    userId: actorId,
    expiresAt: await getSessionExpiry(request),
    connected: async () => ({ unreadCount: await getUnreadMessageCount(dataOwnerId, actorId) }),
  });
}
