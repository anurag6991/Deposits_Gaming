import { afterAll, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { prisma } from '../../db/prisma.js';
import {
  actorFor,
  auditCtx,
  createManager,
  createPublisher,
  createSuperAdmin,
  resetDatabase,
} from '../../test/fixtures.js';
import * as importer from './import.service.js';

/**
 * Bulk import.
 *
 * The importer is where bad data enters the system, so these tests lean on the
 * failure cases: malformed rows, duplicates, spreadsheet formatting damage, and
 * the wrong person uploading. A single bad record silently reaching the pool
 * becomes a failed test task for a publisher weeks later.
 */

afterAll(async () => {
  await prisma.$disconnect();
});

function csv(rows: string[][]): Buffer {
  return Buffer.from(rows.map((r) => r.map((c) => `"${c}"`).join(',')).join('\n'), 'utf8');
}

function xlsx(rows: (string | number)[][]): Buffer {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Sheet1');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

const HEADERS = ['First Name', 'Last Name', 'Email', 'Phone', 'Address', 'City', 'State', 'Zip'];

function row(i: number): string[] {
  return [
    `First${i}`,
    `Last${i}`,
    `person${i}@example.com`,
    `555000${String(i).padStart(4, '0')}`,
    `${i} Main St`,
    'Springfield',
    'IL',
    '62701',
  ];
}

describe('parsing', () => {
  it('reads CSV', () => {
    const { headers, rows } = importer.parseSpreadsheet(csv([HEADERS, row(1), row(2)]), 'f.csv');
    expect(headers).toEqual(HEADERS);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.values['Email']).toBe('person1@example.com');
  });

  it('reads XLSX', () => {
    const { headers, rows } = importer.parseSpreadsheet(xlsx([HEADERS, row(1)]), 'f.xlsx');
    expect(headers).toEqual(HEADERS);
    expect(rows).toHaveLength(1);
  });

  it('keeps a leading zero on a phone number', () => {
    // Excel stores this as a number and would otherwise hand back 412345678.
    const buf = xlsx([['Phone'], ['0412345678']]);
    const { rows } = importer.parseSpreadsheet(buf, 'f.xlsx');
    expect(rows[0]?.values['Phone']).toBe('0412345678');
  });

  it('skips entirely blank rows rather than reporting them as errors', () => {
    const { rows } = importer.parseSpreadsheet(
      csv([HEADERS, row(1), ['', '', '', '', '', '', '', ''], row(2)]),
      'f.csv',
    );
    expect(rows).toHaveLength(2);
  });

  it('reports row numbers matching the spreadsheet, so errors are findable', () => {
    const { rows } = importer.parseSpreadsheet(csv([HEADERS, row(1), row(2)]), 'f.csv');
    // Header is row 1, so the first data row is row 2.
    expect(rows[0]?.rowNumber).toBe(2);
    expect(rows[1]?.rowNumber).toBe(3);
  });

  it('rejects a disallowed extension', () => {
    expect(() => importer.parseSpreadsheet(csv([HEADERS, row(1)]), 'x.bin')).toThrowError();
    expect(() => importer.parseSpreadsheet(csv([HEADERS, row(1)]), 'payload.exe')).toThrowError();
  });

  it('rejects binary content disguised as a CSV', () => {
    // The XLSX library does not throw on arbitrary bytes — it interprets them as
    // CSV and returns nonsense rows. Without an explicit guard this becomes junk
    // records in the pool rather than an error.
    const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x03]);
    expect(() => importer.parseSpreadsheet(binary, 'x.csv')).toThrowError();
  });

  it('rejects a file that claims to be XLSX but is not a zip archive', () => {
    expect(() => importer.parseSpreadsheet(Buffer.from('not a workbook'), 'fake.xlsx')).toThrowError();
  });

  it('rejects an empty file', () => {
    expect(() => importer.parseSpreadsheet(Buffer.alloc(0), 'empty.csv')).toThrowError();
  });

  it('still accepts a genuine XLSX, which is a zip archive', () => {
    const { rows } = importer.parseSpreadsheet(xlsx([HEADERS, row(1)]), 'real.xlsx');
    expect(rows).toHaveLength(1);
  });
});

describe('column mapping', () => {
  it('guesses common header spellings', () => {
    const m = importer.suggestMapping([
      'First Name',
      'last_name',
      'E-Mail Address',
      'Mobile',
      'Zip Code',
    ]);

    expect(m['First Name']).toBe('firstName');
    expect(m['last_name']).toBe('lastName');
    expect(m['E-Mail Address']).toBe('email');
    expect(m['Mobile']).toBe('phone');
    expect(m['Zip Code']).toBe('postalCode');
  });

  it('keeps unrecognised columns as extra rather than discarding them', () => {
    const m = importer.suggestMapping(['First Name', 'Loyalty Tier', 'Referral Source']);
    expect(m['Loyalty Tier']).toBe('extra');
    expect(m['Referral Source']).toBe('extra');
  });

  it('accepts a completely different layout, since the format is not fixed', async () => {
    await resetDatabase();
    const admin = await createSuperAdmin();

    // Reversed order, unusual names, extra columns.
    const buf = csv([
      ['Surname', 'Given Name', 'Contact Number', 'Electronic Mail', 'Notes'],
      ['Smith', 'Jane', '5551234567', 'jane@example.com', 'VIP'],
    ]);

    const preview = await importer.previewImport(actorFor(admin), {
      buffer: buf,
      filename: 'odd.csv',
      countryCode: 'US',
    });

    expect(preview.report.validRows).toBe(1);
    expect(preview.report.sample[0]?.firstName).toBe('Jane');
    expect(preview.report.sample[0]?.lastName).toBe('Smith');
    expect(preview.report.sample[0]?.email).toBe('jane@example.com');
    // The unmapped column is preserved rather than lost.
    expect(preview.report.sample[0]?.extra['Notes']).toBe('VIP');
  });
});

describe('validation', () => {
  it('rejects rows missing a required name', async () => {
    await resetDatabase();
    const admin = await createSuperAdmin();

    const buf = csv([HEADERS, row(1), ['', 'NoFirst', 'a@example.com', '5550001', '', '', '', '']]);

    const preview = await importer.previewImport(actorFor(admin), {
      buffer: buf,
      filename: 'f.csv',
      countryCode: 'US',
    });

    expect(preview.report.validRows).toBe(1);
    expect(preview.report.invalidRows).toBe(1);
    expect(preview.report.errors.some((e) => e.field === 'firstName')).toBe(true);
  });

  it('rejects a malformed email and names the row', async () => {
    await resetDatabase();
    const admin = await createSuperAdmin();

    const bad = ['Bad', 'Email', 'not-an-email', '5550009', '', '', '', ''];
    const buf = csv([HEADERS, row(1), bad]);

    const preview = await importer.previewImport(actorFor(admin), {
      buffer: buf,
      filename: 'f.csv',
      countryCode: 'US',
    });

    const err = preview.report.errors.find((e) => e.field === 'email');
    expect(err).toBeTruthy();
    expect(err?.rowNumber).toBe(3);
    expect(err?.value).toBe('not-an-email');
  });

  it('normalises phone formatting instead of rejecting it', async () => {
    await resetDatabase();
    const admin = await createSuperAdmin();

    const buf = csv([
      ['First Name', 'Last Name', 'Phone'],
      ['Jane', 'Doe', '(555) 123-4567'],
    ]);

    const preview = await importer.previewImport(actorFor(admin), {
      buffer: buf,
      filename: 'f.csv',
      countryCode: 'US',
    });

    expect(preview.report.validRows).toBe(1);
    expect(preview.report.sample[0]?.phone).toBe('5551234567');
  });

  it('lowercases emails so duplicate detection is case-insensitive', async () => {
    await resetDatabase();
    const admin = await createSuperAdmin();

    const buf = csv([
      ['First Name', 'Last Name', 'Email'],
      ['Jane', 'Doe', 'JANE@EXAMPLE.COM'],
    ]);

    const preview = await importer.previewImport(actorFor(admin), {
      buffer: buf,
      filename: 'f.csv',
      countryCode: 'US',
    });

    expect(preview.report.sample[0]?.email).toBe('jane@example.com');
  });

  it('requires a two-letter country code', async () => {
    await resetDatabase();
    const admin = await createSuperAdmin();

    await expect(
      importer.previewImport(actorFor(admin), {
        buffer: csv([HEADERS, row(1)]),
        filename: 'f.csv',
        countryCode: 'USA',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('duplicates', () => {
  it('catches duplicates inside the same file', async () => {
    await resetDatabase();
    const admin = await createSuperAdmin();

    const buf = csv([HEADERS, row(1), row(2), row(1)]);

    const preview = await importer.previewImport(actorFor(admin), {
      buffer: buf,
      filename: 'f.csv',
      countryCode: 'US',
    });

    expect(preview.report.validRows).toBe(2);
    expect(preview.report.duplicateRows).toBe(1);
  });

  it('catches duplicates against records already in the pool', async () => {
    await resetDatabase();
    const admin = await createSuperAdmin();
    const actor = actorFor(admin);
    const buf = csv([HEADERS, row(1), row(2)]);

    const first = await importer.previewImport(actor, {
      buffer: buf,
      filename: 'f.csv',
      countryCode: 'US',
    });
    await importer.confirmImport(actor, auditCtx, { batchId: first.batchId, buffer: buf });

    // The whole file uploaded a second time by mistake.
    const second = await importer.previewImport(actor, {
      buffer: buf,
      filename: 'f.csv',
      countryCode: 'US',
    });

    expect(second.report.validRows).toBe(0);
    expect(second.report.duplicateRows).toBe(2);

    await expect(
      importer.confirmImport(actor, auditCtx, { batchId: second.batchId, buffer: buf }),
    ).rejects.toMatchObject({ code: 'NO_VALID_ROWS' });

    expect(await prisma.testData.count()).toBe(2);
  });

  it('allows two managers to hold the same record independently', async () => {
    await resetDatabase();
    const admin = await createSuperAdmin();
    const alpha = await createManager(admin.id, 'alpha@test.local');
    const beta = await createManager(admin.id, 'beta@test.local');
    const buf = csv([HEADERS, row(1)]);

    for (const mgr of [alpha, beta]) {
      const p = await importer.previewImport(actorFor(mgr), {
        buffer: buf,
        filename: 'f.csv',
        countryCode: 'US',
      });
      const result = await importer.confirmImport(actorFor(mgr), auditCtx, {
        batchId: p.batchId,
        buffer: buf,
      });
      expect(result.imported).toBe(1);
    }

    // Dedupe is scoped per owner, so two managers sourcing the same public list
    // do not block each other.
    expect(await prisma.testData.count()).toBe(2);
  });

  it('allows the same person in two different countries', async () => {
    await resetDatabase();
    const admin = await createSuperAdmin();
    const actor = actorFor(admin);
    const buf = csv([HEADERS, row(1)]);

    for (const country of ['US', 'GB']) {
      const p = await importer.previewImport(actor, {
        buffer: buf,
        filename: 'f.csv',
        countryCode: country,
      });
      await importer.confirmImport(actor, auditCtx, { batchId: p.batchId, buffer: buf });
    }

    expect(await prisma.testData.count()).toBe(2);
  });
});

describe('preview and confirm', () => {
  it('preview inserts nothing', async () => {
    await resetDatabase();
    const admin = await createSuperAdmin();

    await importer.previewImport(actorFor(admin), {
      buffer: csv([HEADERS, row(1), row(2), row(3)]),
      filename: 'f.csv',
      countryCode: 'US',
    });

    expect(await prisma.testData.count()).toBe(0);
    const batch = await prisma.importBatch.findFirstOrThrow({});
    expect(batch.status).toBe('PENDING_CONFIRM');
    expect(batch.importedRows).toBe(0);
  });

  it('confirm inserts only the valid rows', async () => {
    await resetDatabase();
    const admin = await createSuperAdmin();
    const actor = actorFor(admin);

    const buf = csv([
      HEADERS,
      row(1),
      ['', 'NoFirst', 'x@example.com', '5559999', '', '', '', ''],
      row(2),
    ]);

    const preview = await importer.previewImport(actor, {
      buffer: buf,
      filename: 'f.csv',
      countryCode: 'US',
    });
    const result = await importer.confirmImport(actor, auditCtx, {
      batchId: preview.batchId,
      buffer: buf,
    });

    expect(result.imported).toBe(2);
    expect(await prisma.testData.count()).toBe(2);

    // Everything imported is immediately usable and correctly attributed.
    const records = await prisma.testData.findMany();
    expect(records.every((r) => r.status === 'AVAILABLE')).toBe(true);
    expect(records.every((r) => r.countryCode === 'US')).toBe(true);
    expect(records.every((r) => r.ownerUserId === admin.id)).toBe(true);
  });

  it('cannot confirm the same batch twice', async () => {
    await resetDatabase();
    const admin = await createSuperAdmin();
    const actor = actorFor(admin);
    const buf = csv([HEADERS, row(1)]);

    const preview = await importer.previewImport(actor, {
      buffer: buf,
      filename: 'f.csv',
      countryCode: 'US',
    });
    await importer.confirmImport(actor, auditCtx, { batchId: preview.batchId, buffer: buf });

    await expect(
      importer.confirmImport(actor, auditCtx, { batchId: preview.batchId, buffer: buf }),
    ).rejects.toMatchObject({ code: 'IMPORT_NOT_PENDING' });

    expect(await prisma.testData.count()).toBe(1);
  });

  it('a manager cannot confirm another manager batch', async () => {
    await resetDatabase();
    const admin = await createSuperAdmin();
    const alpha = await createManager(admin.id, 'alpha@test.local');
    const beta = await createManager(admin.id, 'beta@test.local');
    const buf = csv([HEADERS, row(1)]);

    const preview = await importer.previewImport(actorFor(alpha), {
      buffer: buf,
      filename: 'f.csv',
      countryCode: 'US',
    });

    await expect(
      importer.confirmImport(actorFor(beta), auditCtx, { batchId: preview.batchId, buffer: buf }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('writes an audit entry recording the counts', async () => {
    await resetDatabase();
    const admin = await createSuperAdmin();
    const actor = actorFor(admin);
    const buf = csv([HEADERS, row(1), row(2)]);

    const preview = await importer.previewImport(actor, {
      buffer: buf,
      filename: 'f.csv',
      countryCode: 'US',
    });
    await importer.confirmImport(actor, auditCtx, { batchId: preview.batchId, buffer: buf });

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'testdata.imported' },
    });
    expect((entry.metadata as Record<string, unknown>).imported).toBe(2);
  });
});

describe('pool stats and record management', () => {
  it('reports depth per country within the actor scope', async () => {
    await resetDatabase();
    const admin = await createSuperAdmin();
    const manager = await createManager(admin.id);
    const actor = actorFor(admin);

    for (const [country, buf] of [
      ['US', csv([HEADERS, row(1), row(2)])],
      ['GB', csv([HEADERS, row(3)])],
    ] as const) {
      const p = await importer.previewImport(actor, {
        buffer: buf,
        filename: 'f.csv',
        countryCode: country,
      });
      await importer.confirmImport(actor, auditCtx, { batchId: p.batchId, buffer: buf });
    }

    const adminStats = await importer.poolStats(actor);
    expect(adminStats.find((s) => s.countryCode === 'US')?.available).toBe(2);
    expect(adminStats.find((s) => s.countryCode === 'GB')?.available).toBe(1);

    // The manager uploaded nothing, so they see nothing — not the central pool.
    const managerStats = await importer.poolStats(actorFor(manager));
    expect(managerStats).toHaveLength(0);
  });

  it('a publisher cannot read pool stats', async () => {
    await resetDatabase();
    const admin = await createSuperAdmin();
    const manager = await createManager(admin.id);
    const publisher = await createPublisher(manager.id, 'p@test.local');

    await expect(importer.poolStats(actorFor(publisher))).rejects.toThrowError();
  });

  it('disabling a record removes it from the available pool', async () => {
    await resetDatabase();
    const admin = await createSuperAdmin();
    const actor = actorFor(admin);
    const buf = csv([HEADERS, row(1)]);

    const p = await importer.previewImport(actor, {
      buffer: buf,
      filename: 'f.csv',
      countryCode: 'US',
    });
    await importer.confirmImport(actor, auditCtx, { batchId: p.batchId, buffer: buf });

    const record = await prisma.testData.findFirstOrThrow({});
    await importer.manageRecord(actor, auditCtx, record.id, 'disable', 'bad data');

    expect(await prisma.testData.count({ where: { status: 'AVAILABLE' } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'testdata.disabled' } })).toBe(1);
  });

  it('refuses to reset a record attached to a completed activity', async () => {
    await resetDatabase();
    const admin = await createSuperAdmin();
    const manager = await createManager(admin.id);
    const publisher = await createPublisher(manager.id, 'p@test.local');
    const actor = actorFor(admin);

    const buf = csv([HEADERS, row(1)]);
    const p = await importer.previewImport(actor, {
      buffer: buf,
      filename: 'f.csv',
      countryCode: 'US',
    });
    await importer.confirmImport(actor, auditCtx, { batchId: p.batchId, buffer: buf });

    const { createOffer, assignPublisher } = await import('../../test/fixtures.js');
    const offer = await createOffer({ ownerUserId: admin.id });
    await assignPublisher(offer.id, publisher.id, admin.id);

    const { startTask } = await import('../tasks/tasks.service.js');
    const { completeLead } = await import('../leads/leads.service.js');
    const task = await startTask(actorFor(publisher), auditCtx, {
      offerId: offer.id,
      type: 'LEAD',
    });
    await completeLead(actorFor(publisher), auditCtx, { taskSessionId: task.taskSessionId });

    const record = await prisma.testData.findFirstOrThrow({});

    // Silently unlinking would leave a lead pointing at a record that is back in
    // circulation, corrupting both the pool and the reporting.
    await expect(
      importer.manageRecord(actor, auditCtx, record.id, 'reset'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
