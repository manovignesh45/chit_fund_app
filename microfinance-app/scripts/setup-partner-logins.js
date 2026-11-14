/**
 * Create a login account for each active business partner of the primary admin that has none.
 * New logins get a random password nobody knows; the primary admin then sets each partner's
 * password on the /users page ("Set password"). Existing users are never modified.
 * (The app does the same automatically when a partner is created or the admin opens /users.)
 *
 * Usage: node scripts/setup-partner-logins.js
 */
require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

function partnerEmail(partnerName, adminEmail) {
  const slug = partnerName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const domain = adminEmail.includes('@') ? adminEmail.split('@')[1] : 'amfincorp.local';
  return `${slug}@${domain}`;
}

async function uniquePartnerEmail(partner, adminEmail) {
  const [local, domain] = partnerEmail(partner.name, adminEmail).split('@');
  const slug = local || `partner${partner.id}`;
  const candidates = [`${slug}@${domain}`, `${slug}+${partner.id}@${domain}`];
  for (let n = 2; n < 50; n++) candidates.push(`${slug}+${partner.id}-${n}@${domain}`);
  for (const email of candidates) {
    if (!(await prisma.user.findUnique({ where: { email }, select: { id: true } }))) return email;
  }
  return `${slug}+${partner.id}-${crypto.randomBytes(4).toString('hex')}@${domain}`;
}

async function main() {
  console.log('Creating missing partner login accounts...\n');

  const primaryAdmin = await prisma.user.findFirst({
    where: { role: 'admin', dataOwnerId: null },
    orderBy: { id: 'asc' },
  });
  if (!primaryAdmin) throw new Error('Primary admin account not found');

  const partners = await prisma.partner.findMany({
    where: { createdById: primaryAdmin.id, isActive: true },
    orderBy: { name: 'asc' },
  });

  for (const partner of partners) {
    const existing = await prisma.user.findFirst({ where: { partnerId: partner.id } });
    if (existing) {
      console.log(`  ${partner.name} → ${existing.email} (already has a login, unchanged)`);
      continue;
    }
    const email = await uniquePartnerEmail(partner, primaryAdmin.email);
    await prisma.user.create({
      data: {
        name: partner.name,
        email,
        password: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10),
        role: 'partner',
        partnerId: partner.id,
        dataOwnerId: primaryAdmin.id,
      },
    });
    console.log(`  ${partner.name} → ${email} (created; set its password on /users)`);
  }

  console.log('\nDone. Set each new partner password on the /users page before they log in.');
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
