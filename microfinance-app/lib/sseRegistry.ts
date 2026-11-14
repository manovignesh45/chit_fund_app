/**
 * Per-user registry and response helper for the Server-Sent Events streams
 * (/api/messages/stream, /api/notifications/stream).
 *
 * Each open stream registers a client under the signed-in user. A stream is cleaned up exactly
 * once (unregistered, heartbeat and expiry timers cleared, controller closed) on whichever comes
 * first: the browser cancelling the stream, the request being aborted, a failed write, or the
 * session token expiring. A user may hold at most MAX_STREAMS_PER_USER streams per registry;
 * beyond that new streams get 429 (EventSource does not retry a non-200 answer, so this cannot
 * turn into a reconnect loop the way evicting the oldest stream would).
 */

export const MAX_STREAMS_PER_USER = 5;
const HEARTBEAT_MS = 25000;

export type SSEClient = {
  id: string;
  send: (chunk: string) => void;
};

export type SSERegistry = ReturnType<typeof createSSERegistry>;

export function formatSSE(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** `globalKey` keeps the map on globalThis so it survives dev hot reloads. */
export function createSSERegistry(globalKey: string) {
  const store = globalThis as unknown as Record<string, Map<number, Map<string, SSEClient>> | undefined>;
  const clientsByUser = store[globalKey] ?? new Map<number, Map<string, SSEClient>>();
  store[globalKey] = clientsByUser;

  const unregister = (userId: number, clientId: string): void => {
    const clients = clientsByUser.get(userId);
    if (!clients) return;
    clients.delete(clientId);
    if (clients.size === 0) clientsByUser.delete(userId);
  };

  return {
    unregister,

    /** Adds the client; false (and nothing added) when the user already has the maximum. */
    register(userId: number, client: SSEClient): boolean {
      let clients = clientsByUser.get(userId);
      if (!clients) {
        clients = new Map();
        clientsByUser.set(userId, clients);
      }
      if (clients.size >= MAX_STREAMS_PER_USER) return false;
      clients.set(client.id, client);
      return true;
    },


    /** Sends one SSE event to every stream of the user. */
    push(userId: number, event: string, data: unknown): void {
      const clients = clientsByUser.get(userId);
      if (!clients?.size) return;
      const payload = formatSSE(event, data);
      // Copy: a failed send cleans its client up, which removes it from this map.
      for (const client of [...clients.values()]) {
        try {
          client.send(payload);
        } catch {
          unregister(userId, client.id);
        }
      }
    },

    /** Open streams, for one user or in total. */
    size(userId?: number): number {
      if (userId !== undefined) return clientsByUser.get(userId)?.size ?? 0;
      let total = 0;
      for (const clients of clientsByUser.values()) total += clients.size;
      return total;
    },
  };
}

/**
 * Opens an SSE stream for `userId` in `registry`. `connected` supplies the payload of the
 * initial `connected` event. `expiresAt` (ms since epoch, e.g. the JWT exp) closes the stream
 * when the session ends, so a stream never outlives the token that opened it.
 */
export function openSSEStream(opts: {
  request: Request;
  registry: SSERegistry;
  userId: number;
  connected: () => Promise<unknown>;
  expiresAt?: number | null;
}): Response {
  const { request, registry, userId, connected, expiresAt } = opts;
  const clientId = crypto.randomUUID();
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (expiryTimer) clearTimeout(expiryTimer);
    registry.unregister(userId, clientId);
    request.signal?.removeEventListener('abort', cleanup);
    try {
      controller?.close();
    } catch {
      // already closed or cancelled
    }
  };

  const send = (chunk: string) => {
    if (closed || !controller) return;
    try {
      controller.enqueue(encoder.encode(chunk));
    } catch {
      cleanup();
    }
  };

  if (expiresAt !== undefined && expiresAt !== null && expiresAt <= Date.now()) {
    return new Response('Unauthorized', { status: 401 });
  }
  if (!registry.register(userId, { id: clientId, send })) {
    return new Response('Too many open streams', { status: 429 });
  }
  if (request.signal?.aborted) {
    cleanup();
    return new Response(null, { status: 499 });
  }
  request.signal?.addEventListener('abort', cleanup, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(c) {
      controller = c;
      heartbeat = setInterval(() => send(': ping\n\n'), HEARTBEAT_MS);
      if (expiresAt) {
        expiryTimer = setTimeout(cleanup, Math.min(expiresAt - Date.now(), 2 ** 31 - 1));
      }
      try {
        send(formatSSE('connected', await connected()));
      } catch (error) {
        console.error('SSE stream setup failed:', error);
        cleanup();
      }
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
