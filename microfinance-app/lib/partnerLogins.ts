import { randomBytes } from 'crypto';
import { hash } from 'bcrypt';
import prisma from './prisma';

/**
 * Login accounts for business partners (role 'partner', dataOwnerId = primary admin).
 *
 * A partner's login is created when the partner is created or re-activated
 * (app/api/partners) and, for partners that predate that, when the primary admin opens
 * the user list (list-users). Each new login gets a random, unusable password: the
 * primary admin sets a real one from the /users page (set-user-password). Existing
 * users are never modified here; read and login paths never write.
 */

function partnerEmail(partnerName: string, adminEmail: string): string {
  const slug = partnerName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const domain = adminEmail.includes('@') ? adminEmail.split('@')[1] : 'amfincorp.local';
  return `${slug}@${domain}`;
}

async function getPrimaryAdmin() {
  return prisma.user.findFirst({
    where: { role: 'admin', dataOwnerId: null },
    orderBy: { id: 'asc' },
  });
}

/** bcrypt hash of 32 random bytes nobody knows: the account exists but cannot be logged into yet. */
async function unusablePasswordHash(): Promise<string> {
  return hash(randomBytes(32).toString('hex'), 10);
}

/** `slug@domain`, or `slug+<partnerId>@domain` (then `-2`, `-3`, ...) when that address is taken. */
async function uniquePartnerEmail(partner: { id: number; name: string }, adminEmail: string): Promise<string> {
  const base = partnerEmail(partner.name, adminEmail);
  const [local, domain] = base.split('@');
  const slug = local || `partner${partner.id}`;
  const candidates = [`${slug}@${domain}`, `${slug}+${partner.id}@${domain}`];
  for (let n = 2; n < 50; n++) candidates.push(`${slug}+${partner.id}-${n}@${domain}`);

  for (const email of candidates) {
    const taken = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (!taken) return email;
  }
  return `${slug}+${partner.id}-${randomBytes(4).toString('hex')}@${domain}`;
}

/**
 * Creates the login for one active partner of the primary admin if it has none.
 * Returns the login's email when one was created, otherwise null.
 */
export async function ensurePartnerLoginUser(partnerId: number): Promise<string | null> {
  const primaryAdmin = await getPrimaryAdmin();
  if (!primaryAdmin) return null;

  const partner = await prisma.partner.findFirst({
    where: { id: partnerId, createdById: primaryAdmin.id, isActive: true },
  });
  if (!partner) return null;

  const existingUser = await prisma.user.findFirst({ where: { partnerId: partner.id }, select: { id: true } });
  if (existingUser) return null;

  const email = await uniquePartnerEmail(partner, primaryAdmin.email);
  await prisma.user.create({
    data: {
      name: partner.name,
      email,
      password: await unusablePasswordHash(),
      role: 'partner',
      partnerId: partner.id,
      dataOwnerId: primaryAdmin.id,
    },
  });
  return email;
}

/** Creates missing logins for every active partner of the primary admin (never touches existing users). */
export async function ensurePartnerLoginUsers(): Promise<{
  primaryAdminId: number;
  created: string[];
  existing: string[];
}> {
  const primaryAdmin = await getPrimaryAdmin();
  if (!primaryAdmin) {
    throw new Error('Primary admin account not found');
  }

  const partners = await prisma.partner.findMany({
    where: { createdById: primaryAdmin.id, isActive: true },
    orderBy: { name: 'asc' },
  });

  const created: string[] = [];
  const existing: string[] = [];
  for (const partner of partners) {
    const email = await ensurePartnerLoginUser(partner.id);
    if (email) created.push(partner.name);
    else existing.push(partner.name);
  }

  return { primaryAdminId: primaryAdmin.id, created, existing };
}

/** The login of an active partner of the primary admin (partner-login action). */
export async function findPartnerLoginUser(partnerId: number) {
  const primaryAdmin = await getPrimaryAdmin();
  if (!primaryAdmin) return null;

  return prisma.user.findFirst({
    where: {
      partnerId,
      dataOwnerId: primaryAdmin.id,
      role: 'partner',
      partner: { isActive: true, createdById: primaryAdmin.id },
    },
    include: { partner: true },
  });
}

export async function getLoginPartners() {
  const primaryAdmin = await getPrimaryAdmin();
  if (!primaryAdmin) {
    return [];
  }

  return prisma.partner.findMany({
    where: { createdById: primaryAdmin.id, isActive: true },
    orderBy: { name: 'asc' },
    // Public (no session): only what a sign-in picker needs.
    select: { id: true, name: true },
  });
}

const loginUserInclude = { partner: { select: { id: true, name: true, isActive: true } } } as const;

export async function findUserByEmailOrUsername(identifier: string) {
  const trimmed = identifier.trim();
  if (!trimmed) return null;

  // Exact email match
  let user = await prisma.user.findUnique({
    where: { email: trimmed },
    include: loginUserInclude,
  });

  if (user) return user;

  const primaryAdmin = await getPrimaryAdmin();

  if (!trimmed.includes('@') && primaryAdmin) {
    // Username → partner email e.g. "Mano" → mano@domain.com
    const guessedEmail = partnerEmail(trimmed, primaryAdmin.email);
    user = await prisma.user.findUnique({
      where: { email: guessedEmail },
      include: loginUserInclude,
    });
    if (user) return user;

    // Match by display name (case-insensitive)
    user = await prisma.user.findFirst({
      where: {
        name: { equals: trimmed, mode: 'insensitive' },
        role: { in: ['admin', 'partner'] },
      },
      include: loginUserInclude,
    });
  }

  return user;
}

export { partnerEmail };
