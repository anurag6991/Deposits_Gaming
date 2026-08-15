/**
 * Development seed.
 *
 * Never runs in production — `npm run db:seed` is gated by
 * ops/scripts/guard-dev-only.mjs, which refuses when NODE_ENV=production or the
 * DATABASE_URL points at deposits_prod.
 *
 * Passwords here are obviously fake and only ever reach a local database.
 */

import { PrismaClient } from '@prisma/client';
import { hash } from '@node-rs/argon2';

const prisma = new PrismaClient();

const DEV_PASSWORD = 'DevPassword123';

const ARGON = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

function monthKeyFor(date: Date): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
  });
  const parts = fmt.format(date).split('-');
  return `${parts[0]}-${parts[1]}`;
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed a production environment');
  }

  console.log('Clearing development data…');
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      audit_logs, notifications, system_settings,
      gameplay_records, withdrawals, balance_entries, deposit_status_changes,
      deposits, leads, task_sessions,
      proxy_assignments, proxies,
      advances, offer_publishers, offer_extensions, offers,
      test_data, import_batches, sessions, users
    RESTART IDENTITY CASCADE
  `);

  const passwordHash = await hash(DEV_PASSWORD, ARGON);

  const admin = await prisma.user.create({
    data: {
      email: 'admin@deposits.local',
      passwordHash,
      fullName: 'Super Admin',
      role: 'SUPER_ADMIN',
      mustChangePassword: false,
    },
  });

  const managers = await Promise.all(
    ['Priya Sharma', 'Rahul Verma'].map((fullName, i) =>
      prisma.user.create({
        data: {
          email: `manager${i + 1}@deposits.local`,
          passwordHash,
          fullName,
          role: 'MANAGER',
          createdById: admin.id,
          mustChangePassword: false,
        },
      }),
    ),
  );

  const publishers = [];
  for (const [index, manager] of managers.entries()) {
    for (let p = 1; p <= 3; p += 1) {
      publishers.push(
        await prisma.user.create({
          data: {
            email: `publisher${index * 3 + p}@deposits.local`,
            passwordHash,
            fullName: `Publisher ${index * 3 + p}`,
            role: 'PUBLISHER',
            managerId: manager.id,
            createdById: manager.id,
            mustChangePassword: false,
          },
        }),
      );
    }
  }

  console.log('Creating test data…');
  const countries = ['US', 'GB', 'CA'];
  for (const country of countries) {
    await prisma.testData.createMany({
      data: Array.from({ length: 120 }, (_, i) => ({
        ownerUserId: admin.id,
        countryCode: country,
        firstName: ['James', 'Mary', 'Robert', 'Linda', 'David'][i % 5] as string,
        lastName: ['Smith', 'Johnson', 'Brown', 'Davis', 'Wilson'][i % 5] as string,
        email: `${country.toLowerCase()}.person${i}@testmail.local`,
        phone: `${country === 'US' ? '1555' : country === 'GB' ? '4477' : '1604'}${String(i).padStart(6, '0')}`,
        address: `${i + 1} Test Street`,
        city: country === 'US' ? 'Springfield' : country === 'GB' ? 'Manchester' : 'Toronto',
        state: country === 'US' ? 'IL' : country === 'GB' ? 'England' : 'ON',
        postalCode: country === 'US' ? '62701' : country === 'GB' ? 'M1 2AB' : 'M5H 2N2',
        status: 'AVAILABLE' as const,
      })),
    });
  }

  // A small manager-owned pool, so the own-pool-before-central behaviour is
  // visible in development.
  await prisma.testData.createMany({
    data: Array.from({ length: 15 }, (_, i) => ({
      ownerUserId: managers[0]!.id,
      countryCode: 'US',
      firstName: 'Managed',
      lastName: `Lead${i}`,
      email: `managed.lead${i}@testmail.local`,
      phone: `1999${String(i).padStart(6, '0')}`,
      city: 'Chicago',
      state: 'IL',
      postalCode: '60601',
      status: 'AVAILABLE' as const,
    })),
  });

  console.log('Creating offers…');
  const offerSpecs = [
    { name: 'USA Casino Test', brand: 'LuckySpin', country: 'US', owner: admin.id, leadInterval: 300, depositInterval: 7200 },
    { name: 'UK Slots Test', brand: 'RoyalReels', country: 'GB', owner: admin.id, leadInterval: 180, depositInterval: 3600 },
    { name: 'Canada Sports Test', brand: 'MapleBet', country: 'CA', owner: managers[0]!.id, leadInterval: 600, depositInterval: 10_800 },
  ];

  const offers = [];
  for (const spec of offerSpecs) {
    offers.push(
      await prisma.offer.create({
        data: {
          name: spec.name,
          brand: spec.brand,
          description: `Internal testing for ${spec.brand}`,
          publisherInstructions: 'Use the proxy provided. Complete registration fully before marking done.',
          countryCode: spec.country,
          url: 'https://example.com/offer',
          status: 'ACTIVE',
          ownerUserId: spec.owner,
          createdById: spec.owner,
          startDate: new Date(),
          expiryDate: new Date(Date.now() + 90 * 86_400_000),
          monthlyLeadTarget: 100,
          monthlyDepositTarget: 50,
          monthlyDepositAmountTarget: '10000.00',
          leadIntervalSeconds: spec.leadInterval,
          depositIntervalSeconds: spec.depositInterval,
          gameplayIntervalDays: 3,
        },
      }),
    );
  }

  for (const offer of offers) {
    for (const publisher of publishers) {
      await prisma.offerPublisher.create({
        data: { offerId: offer.id, publisherId: publisher.id, assignedById: admin.id, active: true },
      });
    }
  }

  console.log('Creating proxies…');
  for (const country of countries) {
    await prisma.proxy.create({
      data: {
        label: `${country} residential`,
        host: `proxy-${country.toLowerCase()}.example.net`,
        port: 8080,
        protocol: 'HTTP',
        username: `user_${country.toLowerCase()}`,
        countryCode: country,
        status: 'ACTIVE',
        ownerUserId: admin.id,
      },
    });
  }

  await prisma.advance.create({
    data: {
      publisherId: publishers[0]!.id,
      managerId: managers[0]!.id,
      monthKey: monthKeyFor(new Date()),
      amount: '500.00',
      status: 'PAID',
      paidOn: new Date(),
      notes: 'Monthly advance',
      createdById: managers[0]!.id,
    },
  });

  await prisma.systemSetting.createMany({
    data: [
      { key: 'app_timezone', value: 'Asia/Kolkata' },
      { key: 'offer_default_duration_days', value: 90 },
      { key: 'reservation_ttl_minutes', value: 30 },
      { key: 'task_session_ttl_minutes', value: 30 },
    ],
  });

  console.log(`
Seed complete.

  Super Admin   admin@deposits.local
  Managers      manager1@deposits.local, manager2@deposits.local
  Publishers    publisher1@deposits.local … publisher6@deposits.local

  Password for all: ${DEV_PASSWORD}

  ${offers.length} offers, ${countries.length * 120 + 15} test records, 3 proxies.
`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
