import { prisma } from '../../db/prisma.js';

/**
 * System settings.
 *
 * Values that should be tunable without a deploy — timezone, expiry length,
 * reservation TTL, alert thresholds. Cached briefly because they are read on hot
 * paths (every task start reads the reservation TTL) and change perhaps monthly.
 */

export const SETTING_DEFAULTS = {
  app_timezone: 'Asia/Kolkata',
  offer_default_duration_days: 90,
  reservation_ttl_minutes: 30,
  task_session_ttl_minutes: 30,
  low_data_threshold_default: 10,
  max_upload_mb: 10,
  offer_expiry_warning_days: 14,
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;

const CACHE_MS = 30_000;
const cache = new Map<string, { value: unknown; at: number }>();

export function invalidateSettingsCache(key?: string): void {
  if (key) cache.delete(key);
  else cache.clear();
}

async function readSetting(key: string): Promise<unknown> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const row = await prisma.systemSetting.findUnique({ where: { key }, select: { value: true } });
  const value = row?.value ?? null;
  cache.set(key, { value, at: Date.now() });
  return value;
}

export async function getSettingNumber(key: SettingKey, fallback: number): Promise<number> {
  const raw = await readSetting(key);
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function getSettingString(key: SettingKey, fallback: string): Promise<string> {
  const raw = await readSetting(key);
  return typeof raw === 'string' && raw.length > 0 ? raw : fallback;
}

export async function getAllSettings(): Promise<Record<string, unknown>> {
  const rows = await prisma.systemSetting.findMany({
    select: { key: true, value: true, description: true, updatedAt: true },
  });
  const out: Record<string, unknown> = { ...SETTING_DEFAULTS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export async function setSetting(
  key: SettingKey,
  value: unknown,
  updatedById: string,
): Promise<void> {
  await prisma.systemSetting.upsert({
    where: { key },
    create: { key, value: value as object, updatedById },
    update: { value: value as object, updatedById },
  });
  invalidateSettingsCache(key);
}
