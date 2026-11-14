import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';

// List of paths that don't require authentication. Matched as whole path segments
// (matchesPath), so '/api/user' does not also open '/api/users'.
const publicPaths = ['/login', '/api/user', '/api/health'];

function matchesPath(pathname: string, path: string): boolean {
  return pathname === path || pathname.startsWith(path + '/');
}

// Rate limiting (simple in-memory, per server instance; consider Redis for production)
const MINUTE = 60000;
const USER_LIMIT = 600; // per signed-in user per minute
const IP_LIMIT = 100; // per IP per minute, for anything without a valid session
const CREDENTIAL_LIMIT = 10; // per IP per minute, password-checking /api/user actions
const MAX_BUCKETS = 5000;
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();

// /api/user actions that check or set a password. These are always counted per IP in their
// own, stricter bucket, even when the caller has a valid session, so holding one session
// cannot buy a higher rate for guessing someone else's password.
const credentialActions = new Set(['login', 'partner-login', 'change-password', 'set-user-password']);

// Client address for rate limiting. Next 15 has no request.ip, so this comes from headers.
// Assumption: in production the app is only reachable through Dokploy's Traefik, which
// (with its default forwardedHeaders settings) drops X-Forwarded-For / X-Real-Ip sent by an
// untrusted client and then appends the address of the connection it accepted. A client can
// still prepend fake entries if a trusted proxy passes them on, so only the RIGHT-MOST entry
// (added by our own proxy) is used, never the first. If the app is ever exposed without
// that proxy, or behind a CDN, these headers are client-controlled or name the CDN edge,
// and the limits become per-header rather than per-client.
function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const entries = forwarded.split(',').map((s) => s.trim()).filter(Boolean);
    if (entries.length) return entries[entries.length - 1];
  }
  return request.headers.get('x-real-ip')?.trim() || 'unknown';
}

// Drop expired windows once the map gets large. If it is still large (many distinct keys
// inside one minute, e.g. spoofed X-Forwarded-For values), also drop the oldest entries so
// memory stays bounded. Each sweep at least halves the map, so the cost is amortised.
function pruneBuckets(now: number) {
  for (const [key, record] of rateLimitMap) {
    if (now > record.resetTime) rateLimitMap.delete(key);
  }
  let excess = rateLimitMap.size - MAX_BUCKETS / 2;
  for (const key of rateLimitMap.keys()) {
    if (excess-- <= 0) break;
    rateLimitMap.delete(key);
  }
}

function rateLimit(key: string, maxRequests: number, windowMs = MINUTE): boolean {
  const now = Date.now();
  const record = rateLimitMap.get(key);

  if (!record || now > record.resetTime) {
    if (!record && rateLimitMap.size >= MAX_BUCKETS) pruneBuckets(now);
    // Delete before set so the key moves to the end of the Map's insertion order,
    // which keeps "oldest first" accurate for pruneBuckets.
    rateLimitMap.delete(key);
    rateLimitMap.set(key, { count: 1, resetTime: now + windowMs });
    return true;
  }

  if (record.count >= maxRequests) {
    return false;
  }

  record.count++;
  return true;
}

type AuthResult =
  | { status: 'ok'; payload: JWTPayload }
  | { status: 'none' | 'no-secret' | 'expired' | 'forbidden' }
  | { status: 'invalid'; error: unknown };

// Verify the auth_token cookie once; the result feeds both the rate limiter and the
// auth/role checks below. Only a token whose signature verifies counts as a session.
async function checkAuth(request: NextRequest): Promise<AuthResult> {
  const token = request.cookies.get('auth_token')?.value;
  if (!token) return { status: 'none' };

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) return { status: 'no-secret' };

  try {
    const secret = new TextEncoder().encode(jwtSecret);
    const { payload } = await jwtVerify(token, secret);

    // Check token expiration
    if (payload.exp && payload.exp * 1000 < Date.now()) return { status: 'expired' };

    // Allow primary admin and partner accounts
    if (payload.role !== 'admin' && payload.role !== 'partner') return { status: 'forbidden' };

    return { status: 'ok', payload };
  } catch (error) {
    return { status: 'invalid', error };
  }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isStatic = pathname.startsWith('/_next') || pathname.startsWith('/public');

  const auth: AuthResult = isStatic ? { status: 'none' } : await checkAuth(request);

  // Get client IP for rate limiting
  const ip = clientIp(request);

  // Apply rate limiting (except for static assets)
  if (!isStatic) {
    const isLogin = matchesPath(pathname, '/login');
    const isAuthEntry = isLogin || matchesPath(pathname, '/api/user');
    const isCredentialAction = matchesPath(pathname, '/api/user') &&
      credentialActions.has(request.nextUrl.searchParams.get('action') || '');

    let allowed: boolean;
    if (isCredentialAction) {
      allowed = rateLimit(`cred:${ip}`, CREDENTIAL_LIMIT);
    } else if (auth.status === 'ok' && !isLogin) {
      // Key on the actual signed-in user (actorId, as getActorUserId in lib/auth.ts).
      // `id` is the data owner, which partner logins share with the primary admin.
      const userId = auth.payload.actorId ?? auth.payload.id;
      allowed = rateLimit(`user:${userId}`, USER_LIMIT);
    } else if (isAuthEntry) {
      // Login page and anonymous/credential /api/user calls get their own per-IP bucket, so
      // stale tabs polling without a session cannot use up the office's login allowance.
      allowed = rateLimit(`auth:${ip}`, IP_LIMIT);
    } else {
      allowed = rateLimit(`ip:${ip}`, IP_LIMIT);
    }

    if (!allowed) {
      return new NextResponse('Too Many Requests', { status: 429 });
    }
  }

  // Security headers for all responses
  const response = NextResponse.next();

  // Add security headers
  response.headers.set('X-DNS-Prefetch-Control', 'off');
  response.headers.set('X-Download-Options', 'noopen');
  response.headers.set('X-Permitted-Cross-Domain-Policies', 'none');

  // Validate origin for API requests
  if (pathname.startsWith('/api') && request.method !== 'GET') {
    const origin = request.headers.get('origin');
    const host = request.headers.get('host');

    // For non-GET API requests, verify same-origin: the Origin's host[:port] must equal the
    // Host header exactly (a substring test would accept https://<host>.evil.com). Requests
    // without an Origin header are allowed; the sameSite=strict session cookie covers those.
    if (origin) {
      let sameOrigin = false;
      try {
        sameOrigin = !!host && new URL(origin).host === host;
      } catch {
        sameOrigin = false; // malformed Origin (including the literal "null")
      }
      if (!sameOrigin) {
        return new NextResponse('Forbidden - Invalid Origin', { status: 403 });
      }
    }
  }

  // Allow static files and public paths
  if (isStatic ||
      pathname === '/favicon.ico' ||
      pathname === '/manifest.json' ||
      pathname.startsWith('/icons/') ||
      publicPaths.some(path => matchesPath(pathname, path))) {
    return response;
  }

  // Scheduled-job endpoints are called by the in-process scheduler without a session;
  // every handler under /api/scheduled/ checks the INTERNAL_API_KEY bearer itself
  // (lib/internalAuth.ts) and fails closed when the key is unset.
  if (pathname.startsWith('/api/scheduled/')) {
    return response;
  }

  switch (auth.status) {
    case 'ok':
      // Allow the request to proceed
      return response;
    case 'none':
      // If there's no token, redirect to login
      return NextResponse.redirect(new URL('/login', request.url));
    case 'no-secret':
      console.error('JWT_SECRET not set in environment');
      return NextResponse.redirect(new URL('/login', request.url));
    case 'expired':
      return NextResponse.redirect(new URL('/login?error=session_expired', request.url));
    case 'forbidden':
      return NextResponse.redirect(new URL('/login?error=access_denied', request.url));
    case 'invalid':
      console.error('Token verification failed:', auth.error);
      return NextResponse.redirect(new URL('/login?error=session_expired', request.url));
  }
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|manifest.json|icons/|public).*)',
  ],
};
