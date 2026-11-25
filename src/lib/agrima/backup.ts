/* =========================================================================
   backup.ts — full JSON backup / restore + data export (100% local)
   Backup includes: users, business stores, settings, audit, reservations.
   Restore validates the file structure BEFORE replacing anything, downloads
   an automatic safety backup of current data first, and requires explicit
   confirmation. Restore is atomic-ish: wipe + bulkPut; failures leave the
   safety backup in the user's downloads.
   ========================================================================= */

import { db, repo } from './db';
import { downloadBlob } from './utils';
import type { AuditEntry } from './types';

export const BACKUP_SCHEMA = 5;

const BACKUP_STORES = [
  'products', 'transactions', 'rolls', 'reels', 'permits', 'customers',
  'importlog', 'users',
  'reservations', 'resvTransfers', 'resvCancellations', 'resvLinks', 'resvAudit',
] as const;

const REQUIRED_FIELDS: Record<string, string[]> = {
  products: ['quality'],
  transactions: ['date', 'quality'],
  rolls: ['rollNo'],
  reels: ['id'],
  permits: ['id'],
  customers: ['name'],
  importlog: ['key'],
  users: ['email'],
  reservations: ['id'],
  resvTransfers: ['id'],
  resvCancellations: ['id'],
  resvLinks: ['id'],
  resvAudit: ['id'],
};

export interface BackupPayload {
  app: string;
  schema: number;
  exportedAt: string;
  settings?: { key: string; value: unknown }[];
  audit?: AuditEntry[];
  [k: string]: unknown;
}

export async function buildBackupPayload(): Promise<BackupPayload> {
  const payload: BackupPayload = {
    app: 'inventory-pwa',
    schema: BACKUP_SCHEMA,
    exportedAt: new Date().toISOString(),
  };
  const repoMap = repo as unknown as Record<string, () => Promise<unknown>>;
  for (const store of BACKUP_STORES) {
    payload[store] = repoMap[store] ? await repoMap[store]() : [];
  }
  payload.settings = (await db.getAll<{ key: string; value: unknown }>('settings')).filter(
    (s) => !String(s.key).startsWith('sync:'),
  );
  payload.audit = await db.getAudit(500);
  return payload;
}

function rowsAreSane(rows: unknown, fields: string[]): boolean {
  if (!Array.isArray(rows)) return false;
  return rows.every((r) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return false;
    return fields.every((f) => f in (r as Record<string, unknown>));
  });
}

export function validateBackupSchema(data: unknown): string[] {
  const errors: string[] = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return ['الملف ليس نسخة احتياطية صالحة'];
  }
  const d = data as Record<string, unknown>;
  if (d.app !== 'inventory-pwa') errors.push('وسم التطبيق غير مطابق (app !== inventory-pwa)');
  if (!Array.isArray(d.transactions)) errors.push('سجل الحركات مفقود أو غير صالح');
  const known = new Set<string>([...BACKUP_STORES, 'settings', 'audit', 'schema', 'exportedAt', 'app']);
  const unknownKeys: string[] = [];
  for (const key of Object.keys(d)) {
    if (!known.has(key)) { unknownKeys.push(key); continue; }
    if (key === 'settings') {
      if (!Array.isArray(d.settings)) errors.push('قسم الإعدادات غير صالح');
      continue;
    }
    if (key === 'audit') {
      if (!Array.isArray(d.audit)) errors.push('سجل العمليات غير صالح');
      continue;
    }
    const fields = REQUIRED_FIELDS[key];
    if (fields && !rowsAreSane(d[key], fields)) errors.push(`بيانات غير سليمة في مخزن «${key}»`);
  }
  if (unknownKeys.length) {
    errors.push(`ملاحظة: مفاتيح غير معروفة لن تُستعاد (${unknownKeys.join(', ')}) — الملف الأصلي محفوظ لديك كما هو`);
  }
  return errors;
}

export async function downloadBackup(actor?: string): Promise<number> {
  const payload = await buildBackupPayload();
  const txCount = (payload.transactions as unknown[] | undefined)?.length || 0;
  const permitCount = (payload.permits as unknown[] | undefined)?.length || 0;
  const json = JSON.stringify(payload, null, 1);
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const fileName = `inventory_backup_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.json`;
  downloadBlob(new Blob([json], { type: 'application/json' }), fileName);
  await db.logAudit({
    entity: 'database', action: 'backup', entityId: 'backup',
    details: `تنزيل نسخة احتياطية كاملة (${txCount} حركة — ${permitCount} إذن)`,
    actor: actor || null,
  });
  return txCount;
}

export async function restoreBackup(file: File, actor?: string): Promise<{ tx: number; prod: number }> {
  const text = await file.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch {
    throw new Error('الملف ليس JSON صالحًا');
  }
  const errors = validateBackupSchema(data);
  const fatal = errors.filter((e) => !e.startsWith('ملاحظة:'));
  if (fatal.length) throw new Error('ملف النسخة الاحتياطية غير صالح: ' + fatal.join(' — '));
  const d = data as BackupPayload & Record<string, Record<string, unknown>[]>;

  // safety backup of current data BEFORE replacement
  await downloadBackup(actor);

  const keepUsers = Array.isArray(d.users) && d.users.length > 0 ? false : true;
  await db.wipeAll({ keepUsers });
  const putStores = ['products', 'transactions', 'rolls', 'reels', 'permits', 'customers', 'importlog'] as const;
  for (const store of putStores) {
    const rows = (d[store] || []) as Record<string, unknown>[];
    const clean = rows.map((r) => {
      const c = { ...r };
      if (store === 'products' || store === 'transactions' || store === 'rolls' || store === 'customers') delete c.id;
      return c;
    });
    if (clean.length) await db.bulkPut(store, clean);
  }
  // users: only if present (never locked out — admin always kept otherwise)
  const userRows = (d.users || []) as Record<string, unknown>[];
  if (userRows.length && !keepUsers) {
    await db.bulkPut('users', userRows);
  }
  const resvStores = ['reservations', 'resvTransfers', 'resvCancellations', 'resvLinks', 'resvAudit'] as const;
  for (const store of resvStores) {
    const rows = (d[store] || []) as Record<string, unknown>[];
    if (rows.length) await db.bulkPut(store, rows);
  }
  const settings = (d.settings || []) as { key: string; value: unknown }[];
  for (const s of settings) {
    if (!s || typeof s !== 'object' || !s.key) continue;
    await db.put('settings', s);
  }
  const audit = (d.audit || []) as AuditEntry[];
  if (audit.length) {
    await db.bulkPut('audit', audit.map((a) => ({ ...a, id: undefined })) as unknown as Record<string, unknown>[]);
  }
  const tx = ((d.transactions || []) as unknown[]).length;
  const prod = ((d.products || []) as unknown[]).length;
  await db.logAudit({
    entity: 'database', action: 'restore', entityId: 'restore',
    details: `استعادة نسخة احتياطية: tx=${tx}, prod=${prod}`,
    actor: actor || null,
  });
  return { tx, prod };
}
