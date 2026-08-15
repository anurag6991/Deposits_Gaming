import * as XLSX from 'xlsx';
import { z } from 'zod';
import { prisma, withTransaction } from '../../db/prisma.js';
import { testDataScope, type Actor } from '../../db/scope.js';
import { AppError } from '../../lib/errors.js';
import { writeAudit, type AuditContext } from '../audit/audit.service.js';

/**
 * Bulk test-data import.
 *
 * Deliberately format-agnostic: the brief said the column layout is not final,
 * so the mapping from spreadsheet header to field is chosen per upload and
 * stored on the batch. Nothing here assumes a fixed column order or set.
 *
 * Flow: upload -> parse -> map -> validate -> PREVIEW -> confirm -> insert.
 * The preview step exists so a bad file is caught before it touches the pool
 * rather than after. Invalid rows are never inserted.
 */

/** The fields an import can populate. Everything else lands in `extra`. */
export const IMPORTABLE_FIELDS = [
  'firstName',
  'lastName',
  'email',
  'phone',
  'address',
  'city',
  'state',
  'postalCode',
  'dateOfBirth',
] as const;

export type ImportableField = (typeof IMPORTABLE_FIELDS)[number];

/** Spreadsheet header -> field name. Unmapped headers are kept in `extra`. */
export type ColumnMapping = Partial<Record<string, ImportableField | 'ignore' | 'extra'>>;

export interface ParsedRow {
  rowNumber: number;
  values: Record<string, string>;
}

export interface RowError {
  rowNumber: number;
  field: string;
  message: string;
  value?: string;
}

const MAX_ROWS = 50_000;

const ALLOWED_EXTENSIONS = ['csv', 'xlsx', 'xls', 'tsv', 'txt'];

/**
 * Rejects anything that is not plausibly a spreadsheet, before parsing.
 *
 * This guard is necessary because the XLSX library is extremely permissive: hand
 * it arbitrary binary and it will not throw, it will interpret the bytes as CSV
 * and hand back nonsense rows. Without this check a corrupt upload — or a file
 * with a spreadsheet extension that is actually something else — becomes junk
 * records in the pool rather than a clear error at the door.
 */
function assertLooksLikeSpreadsheet(buffer: Buffer, filename: string): void {
  if (buffer.length === 0) {
    throw new AppError('UNSUPPORTED_FILE_TYPE', { message: 'That file is empty.' });
  }

  const extension = filename.split('.').pop()?.toLowerCase() ?? '';
  if (!ALLOWED_EXTENSIONS.includes(extension)) {
    throw new AppError('UNSUPPORTED_FILE_TYPE');
  }

  const isOfficeZip = buffer.length > 1 && buffer[0] === 0x50 && buffer[1] === 0x4b; // "PK"
  const isLegacyXls =
    buffer.length > 7 && buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));

  if (extension === 'xlsx') {
    // An .xlsx is a zip archive; anything else with that name is mislabelled.
    if (!isOfficeZip) {
      throw new AppError('UNSUPPORTED_FILE_TYPE', {
        message: 'That file is not a valid XLSX workbook.',
      });
    }
    return;
  }

  if (extension === 'xls') {
    if (!isLegacyXls && !isOfficeZip) {
      throw new AppError('UNSUPPORTED_FILE_TYPE', {
        message: 'That file is not a valid Excel workbook.',
      });
    }
    return;
  }

  // Text formats: a NUL byte in the first block means it is binary, whatever the
  // extension claims. Real CSV never contains one.
  const head = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (head.includes(0x00)) {
    throw new AppError('UNSUPPORTED_FILE_TYPE', {
      message: 'That file looks like binary data, not a CSV. Save it as CSV or XLSX and try again.',
    });
  }

  // Reject text that is not decodable, which would otherwise import as mojibake.
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(head);
  const replacementChars = (decoded.match(/�/g) ?? []).length;
  if (replacementChars > head.length * 0.05) {
    throw new AppError('UNSUPPORTED_FILE_TYPE', {
      message: 'That file is not readable as text. Save it as UTF-8 CSV or as XLSX.',
    });
  }
}

/**
 * Reads a CSV or XLSX buffer into rows.
 *
 * `raw: false` makes the parser hand back formatted strings, which stops Excel
 * turning a phone number like 0412345678 into the number 412345678 or a postal
 * code into scientific notation. Everything is validated as text.
 */
export function parseSpreadsheet(buffer: Buffer, filename: string): { headers: string[]; rows: ParsedRow[] } {
  assertLooksLikeSpreadsheet(buffer, filename);

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false, raw: false });
  } catch {
    throw new AppError('UNSUPPORTED_FILE_TYPE', {
      internal: { filename },
      message: 'That file could not be read. Save it as CSV or XLSX and try again.',
    });
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new AppError('NO_VALID_ROWS', { message: 'The file has no sheets.' });

  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new AppError('NO_VALID_ROWS', { message: 'The first sheet is empty.' });

  const matrix = XLSX.utils.sheet_to_json<string[]>(sheet, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: false,
  });

  const headerRow = matrix[0];
  if (!headerRow || headerRow.length === 0) {
    throw new AppError('NO_VALID_ROWS', { message: 'The file has no header row.' });
  }

  const headers = headerRow.map((h) => String(h ?? '').trim());

  if (matrix.length - 1 > MAX_ROWS) {
    throw new AppError('UPLOAD_TOO_LARGE', {
      message: `That file has more than ${MAX_ROWS.toLocaleString()} rows. Split it into smaller files.`,
    });
  }

  const rows: ParsedRow[] = [];
  for (let i = 1; i < matrix.length; i += 1) {
    const raw = matrix[i];
    if (!raw) continue;

    const values: Record<string, string> = {};
    let hasContent = false;

    headers.forEach((header, col) => {
      const cell = String(raw[col] ?? '').trim();
      values[header] = cell;
      if (cell) hasContent = true;
    });

    // Skip rows that are entirely blank rather than reporting them as errors —
    // trailing empties are an artefact of how people save spreadsheets.
    if (hasContent) rows.push({ rowNumber: i + 1, values });
  }

  return { headers, rows };
}

/** Guesses a mapping from header names so the user usually just confirms it. */
export function suggestMapping(headers: string[]): ColumnMapping {
  const normalise = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

  const patterns: Array<[RegExp, ImportableField]> = [
    [/^(first|given|fore)?name$|^firstname$|^fname$/, 'firstName'],
    [/^(last|sur|family)name$|^lname$/, 'lastName'],
    [/mail/, 'email'],
    [/phone|mobile|cell|contact|tel/, 'phone'],
    [/address|street|addr/, 'address'],
    [/city|town/, 'city'],
    [/state|province|region|county/, 'state'],
    [/postal|zip|pincode|pin/, 'postalCode'],
    [/dob|birth/, 'dateOfBirth'],
  ];

  const mapping: ColumnMapping = {};
  const taken = new Set<ImportableField>();

  for (const header of headers) {
    const key = normalise(header);
    const match = patterns.find(([re]) => re.test(key));
    if (match && !taken.has(match[1])) {
      mapping[header] = match[1];
      taken.add(match[1]);
    } else {
      mapping[header] = 'extra';
    }
  }

  return mapping;
}

const emailSchema = z.string().email();
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export interface ValidatedRow {
  rowNumber: number;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  dateOfBirth: Date | null;
  extra: Record<string, string>;
}

export interface ValidationReport {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  errors: RowError[];
  /** First few valid rows, so the user can eyeball the mapping before importing. */
  sample: ValidatedRow[];
}

/**
 * Validates rows against the mapping and detects duplicates.
 *
 * Duplicates are checked twice: within the file itself, and against records the
 * same owner already holds for that country. A file re-uploaded by accident
 * should import nothing, not a second copy of everything.
 */
export async function validateRows(
  ownerUserId: string,
  countryCode: string,
  rows: ParsedRow[],
  mapping: ColumnMapping,
): Promise<{ valid: ValidatedRow[]; report: ValidationReport }> {
  const errors: RowError[] = [];
  const valid: ValidatedRow[] = [];

  const seenEmails = new Set<string>();
  const seenPhones = new Set<string>();
  let duplicateRows = 0;

  // One query for existing keys rather than a lookup per row.
  const existing = await prisma.testData.findMany({
    where: { ownerUserId, countryCode },
    select: { email: true, phone: true },
  });
  for (const e of existing) {
    if (e.email) seenEmails.add(e.email.toLowerCase());
    if (e.phone) seenPhones.add(e.phone);
  }

  const fieldFor = (header: string) => mapping[header];

  for (const row of rows) {
    const record: Record<string, string> = {};
    const extra: Record<string, string> = {};

    for (const [header, value] of Object.entries(row.values)) {
      const target = fieldFor(header);
      if (!target || target === 'ignore') continue;
      if (target === 'extra') {
        if (value) extra[header] = value;
        continue;
      }
      record[target] = value;
    }

    const rowErrors: RowError[] = [];

    const firstName = (record.firstName ?? '').trim();
    const lastName = (record.lastName ?? '').trim();

    if (!firstName) {
      rowErrors.push({ rowNumber: row.rowNumber, field: 'firstName', message: 'First name is required' });
    }
    if (!lastName) {
      rowErrors.push({ rowNumber: row.rowNumber, field: 'lastName', message: 'Last name is required' });
    }

    const rawEmail = (record.email ?? '').trim().toLowerCase();
    let email: string | null = null;
    if (rawEmail) {
      if (emailSchema.safeParse(rawEmail).success) {
        email = rawEmail;
      } else {
        rowErrors.push({
          rowNumber: row.rowNumber,
          field: 'email',
          message: 'Not a valid email address',
          value: rawEmail,
        });
      }
    }

    // Keep digits and a leading +; spreadsheets add spaces, dashes and brackets.
    const rawPhone = (record.phone ?? '').trim();
    let phone: string | null = null;
    if (rawPhone) {
      const cleaned = rawPhone.replace(/(?!^\+)[^\d]/g, '');
      if (cleaned.replace(/\D/g, '').length < 6) {
        rowErrors.push({
          rowNumber: row.rowNumber,
          field: 'phone',
          message: 'Phone number looks too short',
          value: rawPhone,
        });
      } else {
        phone = cleaned;
      }
    }

    let dateOfBirth: Date | null = null;
    const rawDob = (record.dateOfBirth ?? '').trim();
    if (rawDob) {
      if (dateSchema.safeParse(rawDob).success) {
        dateOfBirth = new Date(`${rawDob}T00:00:00Z`);
      } else {
        rowErrors.push({
          rowNumber: row.rowNumber,
          field: 'dateOfBirth',
          message: 'Use the format YYYY-MM-DD',
          value: rawDob,
        });
      }
    }

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
      continue;
    }

    // Duplicate detection, matching the partial unique indexes in migration 002.
    const isDuplicate = (email && seenEmails.has(email)) || (phone && seenPhones.has(phone));
    if (isDuplicate) {
      duplicateRows += 1;
      errors.push({
        rowNumber: row.rowNumber,
        field: email && seenEmails.has(email) ? 'email' : 'phone',
        message: 'Already present in this pool',
        value: email ?? phone ?? '',
      });
      continue;
    }

    if (email) seenEmails.add(email);
    if (phone) seenPhones.add(phone);

    valid.push({
      rowNumber: row.rowNumber,
      firstName,
      lastName,
      email,
      phone,
      address: (record.address ?? '').trim() || null,
      city: (record.city ?? '').trim() || null,
      state: (record.state ?? '').trim() || null,
      postalCode: (record.postalCode ?? '').trim() || null,
      dateOfBirth,
      extra,
    });
  }

  return {
    valid,
    report: {
      totalRows: rows.length,
      validRows: valid.length,
      invalidRows: rows.length - valid.length - duplicateRows,
      duplicateRows,
      // Capped so a catastrophically bad file does not return a 50k-item payload.
      errors: errors.slice(0, 500),
      sample: valid.slice(0, 10),
    },
  };
}

/**
 * Stage 1: parse, validate, and store a pending batch. Nothing enters the pool.
 */
export async function previewImport(
  actor: Actor,
  input: { buffer: Buffer; filename: string; countryCode: string; mapping?: ColumnMapping },
): Promise<{ batchId: string; headers: string[]; mapping: ColumnMapping; report: ValidationReport }> {
  const countryCode = input.countryCode.toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    throw new AppError('VALIDATION_FAILED', {
      fields: { countryCode: 'Use a two-letter country code, for example US or GB.' },
    });
  }

  const { headers, rows } = parseSpreadsheet(input.buffer, input.filename);
  if (rows.length === 0) throw new AppError('NO_VALID_ROWS');

  const mapping = input.mapping ?? suggestMapping(headers);
  const { report } = await validateRows(actor.id, countryCode, rows, mapping);

  const batch = await prisma.importBatch.create({
    data: {
      ownerUserId: actor.id,
      filename: input.filename,
      countryCode,
      columnMapping: mapping as object,
      totalRows: report.totalRows,
      validRows: report.validRows,
      invalidRows: report.invalidRows,
      duplicateRows: report.duplicateRows,
      errorReport: report.errors as unknown as object,
      status: 'PENDING_CONFIRM',
    },
    select: { id: true },
  });

  return { batchId: batch.id, headers, mapping, report };
}

/**
 * Stage 2: re-validate and insert.
 *
 * The file is re-parsed rather than cached between the two calls: holding
 * megabytes of uploaded data in memory between requests does not survive a
 * restart or a second server process, and re-validating also catches records
 * another import added in the meantime.
 */
export async function confirmImport(
  actor: Actor,
  ctx: AuditContext,
  input: { batchId: string; buffer: Buffer; mapping?: ColumnMapping },
): Promise<{ imported: number; skipped: number; report: ValidationReport }> {
  const batch = await prisma.importBatch.findFirst({
    where: { id: input.batchId, ownerUserId: actor.id },
    select: { id: true, countryCode: true, columnMapping: true, status: true, filename: true },
  });
  if (!batch) throw new AppError('NOT_FOUND');
  if (batch.status !== 'PENDING_CONFIRM') throw new AppError('IMPORT_NOT_PENDING');

  const { rows } = parseSpreadsheet(input.buffer, batch.filename);
  const mapping = (input.mapping ?? batch.columnMapping) as ColumnMapping;
  const { valid, report } = await validateRows(actor.id, batch.countryCode, rows, mapping);

  if (valid.length === 0) {
    await prisma.importBatch.update({
      where: { id: batch.id },
      data: { status: 'CANCELLED', errorReport: report.errors as unknown as object },
    });
    throw new AppError('NO_VALID_ROWS');
  }

  const imported = await withTransaction(
    async (tx) => {
      const created = await tx.testData.createMany({
        data: valid.map((r) => ({
          ownerUserId: actor.id,
          importBatchId: batch.id,
          countryCode: batch.countryCode,
          firstName: r.firstName,
          lastName: r.lastName,
          email: r.email,
          phone: r.phone,
          address: r.address,
          city: r.city,
          state: r.state,
          postalCode: r.postalCode,
          dateOfBirth: r.dateOfBirth,
          extra: r.extra,
          status: 'AVAILABLE' as const,
        })),
        // The partial unique indexes are the final authority. Anything the
        // in-memory check missed because of a concurrent import is skipped here
        // rather than aborting the whole batch.
        skipDuplicates: true,
      });

      await tx.importBatch.update({
        where: { id: batch.id },
        data: {
          status: 'IMPORTED',
          totalRows: report.totalRows,
          validRows: report.validRows,
          invalidRows: report.invalidRows,
          duplicateRows: report.duplicateRows,
          importedRows: created.count,
          errorReport: report.errors as unknown as object,
        },
      });

      await writeAudit(tx, ctx, {
        action: 'testdata.imported',
        entityType: 'import_batch',
        entityId: batch.id,
        metadata: {
          countryCode: batch.countryCode,
          imported: created.count,
          invalid: report.invalidRows,
          duplicates: report.duplicateRows,
        },
      });

      return created.count;
    },
    { timeoutMs: 120_000 },
  );

  return { imported, skipped: report.totalRows - imported, report };
}

/** Pool depth per country for the owners this actor can see. */
export async function poolStats(actor: Actor) {
  const scope = testDataScope(actor);

  const grouped = await prisma.testData.groupBy({
    by: ['countryCode', 'status'],
    where: scope,
    _count: { _all: true },
  });

  const byCountry = new Map<string, Record<string, number>>();
  for (const row of grouped) {
    const entry = byCountry.get(row.countryCode) ?? {};
    entry[row.status] = row._count._all;
    byCountry.set(row.countryCode, entry);
  }

  return [...byCountry.entries()]
    .map(([countryCode, counts]) => ({
      countryCode,
      available: counts.AVAILABLE ?? 0,
      reserved: counts.RESERVED ?? 0,
      used: counts.USED ?? 0,
      disabled: counts.DISABLED ?? 0,
      total: Object.values(counts).reduce((a, b) => a + b, 0),
    }))
    .sort((a, b) => a.countryCode.localeCompare(b.countryCode));
}

/**
 * Super Admin / owner action: return a record to the pool, disable it, or reset
 * a consumed one. Every reset is audited because it rewrites history.
 */
export async function manageRecord(
  actor: Actor,
  ctx: AuditContext,
  id: string,
  action: 'release' | 'disable' | 'reset',
  reason?: string,
) {
  const record = await prisma.testData.findFirst({
    where: { id, ...testDataScope(actor) },
    select: { id: true, status: true },
  });
  if (!record) throw new AppError('NOT_FOUND');

  if (action === 'reset' && actor.role !== 'SUPER_ADMIN') throw new AppError('FORBIDDEN');

  return withTransaction(async (tx) => {
    if (action === 'reset') {
      // A consumed record is attached to a lead or deposit. Removing that
      // linkage silently would corrupt reporting, so refuse and make the caller
      // reset the activity instead.
      const [lead, deposit] = await Promise.all([
        tx.lead.findUnique({ where: { testDataId: id }, select: { id: true } }),
        tx.deposit.findUnique({ where: { testDataId: id }, select: { id: true } }),
      ]);
      if (lead || deposit) {
        throw new AppError('CONFLICT', {
          message:
            'This record is attached to a completed activity. Reset that activity first, which will return the record to the pool.',
        });
      }
    }

    const updated = await tx.testData.update({
      where: { id },
      data: {
        status: action === 'disable' ? 'DISABLED' : 'AVAILABLE',
        reservedByUserId: null,
        reservedAt: null,
        reservationExpiresAt: null,
        ...(action === 'reset' ? { usedAt: null, usedByUserId: null, usedOfferId: null } : {}),
      },
      select: { id: true, status: true },
    });

    await writeAudit(tx, ctx, {
      action:
        action === 'disable'
          ? 'testdata.disabled'
          : action === 'reset'
            ? 'testdata.reset'
            : 'testdata.released',
      entityType: 'test_data',
      entityId: id,
      metadata: { from: record.status, to: updated.status, reason: reason ?? null },
    });

    return updated;
  });
}
