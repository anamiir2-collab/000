/* =========================================================================
   db.ts — IndexedDB storage layer (100% local, zero Supabase)
   -------------------------------------------------------------------------
   • Same DB name `inventory_pwa_db` as the original app → existing user
     data (products, transactions, rolls, reels, permits, customers,
     settings, importlog, audit) is loaded untouched.
   • Upgrade to v5 ONLY CREATES new stores (users + reservation stores).
     Existing stores / keys / records are never read, rewritten or deleted.
   • Legacy sync stores (tombstones / stockview) are left as-is but unused.
   ========================================================================= */

import type {
  AuditEntry, Customer, ImportLogEntry, LocalUser, Permit, Product,
  ResvAuditEntry, ResvCancellation, ResvLink, ResvTransfer, Reservation,
  Reel, Roll, Transaction,
} from './types';

export const DB_NAME = 'inventory_pwa_db';
export const DB_VERSION = 6;

export const STORES = {
  products: 'products',
  transactions: 'transactions',
  audit: 'audit',
  settings: 'settings',
  rolls: 'rolls',
  reels: 'reels',
  permits: 'permits',
  customers: 'customers',
  importlog: 'importlog',
  users: 'users', // v5: local accounts (PBKDF2) — replaces Supabase Auth
  reservations: 'reservations', // v5 — migrated from localStorage keys
  resvTransfers: 'resvTransfers',
  resvCancellations: 'resvCancellations',
  resvLinks: 'resvLinks',
  resvAudit: 'resvAudit',
} as const;

export type StoreName = (typeof STORES)[keyof typeof STORES];

let _db: IDBDatabase | null = null;
let _openPromise: Promise<IDBDatabase> | null = null;

export class DBError extends Error {
  kind: 'blocked' | 'timeout' | 'unavailable' | 'io';
  constructor(kind: DBError['kind'], message: string, public cause?: unknown) {
    super(message);
    this.name = 'DBError';
    this.kind = kind;
  }
}

export function openDB(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  if (_openPromise) return _openPromise;
  _openPromise = new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      if (typeof indexedDB === 'undefined') {
        throw new DBError('unavailable', 'IndexedDB غير متاح في هذا المتصفح');
      }
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      _openPromise = null;
      reject(err);
      return;
    }
    req.onblocked = () => console.warn('[db] open blocked — another tab holds the database');
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      const upgradeTx = (e.target as IDBOpenDBRequest).transaction;
      const ensure = (name: string, build: (s: IDBObjectStore) => void, keyPath?: string | null, auto?: boolean) => {
        if (db.objectStoreNames.contains(name)) {
          /* v5→v6 repair: some fresh installs created these stores without a
             keyPath (out-of-line keys) — delete & recreate ONLY when the
             schema is wrong; genuine v4 stores (correct keyPath) stay untouched. */
          const st = upgradeTx!.objectStore(name);
          const correct = keyPath ? st.keyPath === keyPath : true;
          if (!correct) {
            db.deleteObjectStore(name);
          } else {
            return;
          }
        }
        const s = db.createObjectStore(name, keyPath ? { keyPath, autoIncrement: !!auto } : undefined);
        build(s);
      };
      const idx = (s: IDBObjectStore, n: string, kp: string, uq = false) => {
        if (!s.indexNames.contains(n)) s.createIndex(n, kp, { unique: uq });
      };
      ensure('products', (s) => { idx(s, 'quality', 'quality'); idx(s, 'combo', 'combo', true); }, 'id', true);
      ensure('transactions', (s) => {
        idx(s, 'date', 'date'); idx(s, 'quality', 'quality'); idx(s, 'combo', 'combo');
        idx(s, 'customer', 'customer'); idx(s, 'fingerprint', 'fingerprint');
        idx(s, 'groupId', 'groupId'); idx(s, 'reelId', 'reelId');
      }, 'id', true);
      ensure('audit', (s) => { idx(s, 'at', 'at'); idx(s, 'entity', 'entity'); }, 'id', true);
      ensure('settings', () => {}, 'key');
      ensure('rolls', (s) => { idx(s, 'rollNo', 'rollNo', true); idx(s, 'date', 'date'); }, 'id', true);
      ensure('reels', (s) => {
        idx(s, 'rollNo', 'rollNo'); idx(s, 'status', 'status');
        idx(s, 'rollReel', 'rollReel', true); idx(s, 'quality', 'quality');
      }, 'id');
      ensure('permits', (s) => {
        idx(s, 'status', 'status'); idx(s, 'cls', 'cls'); idx(s, 'date', 'date');
        idx(s, 'permitKey', 'permitKey', true);
      }, 'id');
      ensure('customers', (s) => { idx(s, 'name', 'name', true); }, 'id', true);
      ensure('importlog', () => {}, 'key');
      /* ---- v5: local users + reservations (additive, never touches old data) ---- */
      ensure('users', (s) => { idx(s, 'email', 'email', true); }, 'id');
      ensure('reservations', () => {}, 'id');
      ensure('resvTransfers', () => {}, 'id');
      ensure('resvCancellations', () => {}, 'id');
      ensure('resvLinks', () => {}, 'id');
      ensure('resvAudit', () => {}, 'id');
    };
    req.onsuccess = () => {
      _db = req.result;
      _db.onversionchange = () => {
        try { _db?.close(); } catch { /* ignore */ }
        _db = null; _openPromise = null;
      };
      resolve(_db);
    };
    req.onerror = () => {
      _openPromise = null;
      reject(new DBError('io', 'فشل فتح قاعدة البيانات المحلية', req.error));
    };
    setTimeout(() => {
      if (_db) return;
      _openPromise = null;
      reject(new DBError('timeout', 'استغرق فتح قاعدة البيانات أكثر من 10 ثوانٍ. أغلق أي تبويبات أخرى للتطبيق ثم أعد المحاولة.'));
    }, 10000);
  });
  return _openPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (st: IDBObjectStore) => IDBRequest | IDBRequest[]): Promise<T> {
  return openDB().then((db) => new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const st = t.objectStore(store);
    let out: IDBRequest | IDBRequest[];
    try { out = fn(st); } catch (err) { reject(err); return; }
    const reqs = Array.isArray(out) ? out : [out];
    let done = 0;
    const results: unknown[] = [];
    let settled = false;
    const finish = (f: () => void) => { if (!settled) { settled = true; f(); } };
    if (reqs.length === 0) { finish(() => resolve([] as unknown as T)); return; }
    reqs.forEach((r, i) => {
      if (!r) { done++; results[i] = undefined; return; }
      r.onsuccess = () => {
        results[i] = r.result; done++;
        if (done >= reqs.length) finish(() => resolve((Array.isArray(out) ? results : results[0]) as T));
      };
      r.onerror = () => finish(() => reject(r.error));
    });
    t.onabort = () => finish(() => reject(t.error));
  }));
}

export const db = {
  getAll<T>(store: string): Promise<T[]> { return tx<T[]>(store, 'readonly', (st) => st.getAll()); },
  get<T>(store: string, key: IDBValidKey): Promise<T | undefined> { return tx<T | undefined>(store, 'readonly', (st) => st.get(key)); },
  count(store: string): Promise<number> { return tx<number>(store, 'readonly', (st) => st.count()); },
  put<T>(store: string, val: T): Promise<IDBValidKey> { return tx(store, 'readwrite', (st) => st.put(val as unknown as Record<string, unknown>)); },
  add<T>(store: string, val: T): Promise<IDBValidKey> { return tx(store, 'readwrite', (st) => st.add(val as unknown as Record<string, unknown>)); },
  del(store: string, key: IDBValidKey): Promise<undefined> { return tx(store, 'readwrite', (st) => st.delete(key)); },
  clear(store: string): Promise<undefined> { return tx(store, 'readwrite', (st) => st.clear()); },

  /** Atomic bulk put: one transaction, all-or-nothing. */
  bulkPut<T>(store: string, items: T[]): Promise<number> {
    return openDB().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(store, 'readwrite');
      const st = t.objectStore(store);
      items.forEach((it) => st.put(it as unknown as Record<string, unknown>));
      t.oncomplete = () => resolve(items.length);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  },

  /** Atomic cross-store work unit (all-or-nothing document save). */
  atomic<T>(storeNames: string[], workFn: (t: IDBTransaction, fail: (e?: Error) => void) => T | undefined, catchErr?: (e: unknown) => void): Promise<T | null> {
    return openDB().then((db) => new Promise((resolve, reject) => {
      let t: IDBTransaction;
      try { t = db.transaction(storeNames, 'readwrite'); } catch (err) { reject(err); return; }
      let result: T | undefined = undefined;
      let fail: Error | undefined = undefined;
      const markFail = (e?: Error) => { fail = e || fail; };
      try {
        result = workFn(t, markFail);
      } catch (err) {
        fail = err instanceof Error ? err : new Error(String(err));
        if (catchErr) catchErr(err);
        try { t.abort(); } catch { /* already aborted */ }
      }
      t.oncomplete = () => resolve(result ?? null);
      t.onerror = () => reject(fail || t.error);
      t.onabort = () => reject(fail || t.error || new Error('transaction aborted'));
    }));
  },

  /* ---------------- settings ---------------- */
  async getSetting<T>(key: string, fallback: T): Promise<T> {
    const v = await db.get<{ key: string; value: T }>('settings', key);
    return v === undefined || v === null ? fallback : v.value;
  },
  setSetting(key: string, value: unknown): Promise<IDBValidKey> {
    return db.put('settings', { key, value });
  },

  /* ---------------- audit ---------------- */
  logAudit(entry: Omit<AuditEntry, 'at' | 'sid'> & { at?: string }): Promise<IDBValidKey> {
    let sid: string;
    try { sid = crypto.randomUUID(); } catch {
      sid = 'sid-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }
    return db.add('audit', { at: new Date().toISOString(), sid, ...entry } as AuditEntry);
  },
  async getAudit(limit?: number): Promise<AuditEntry[]> {
    const rows = await db.getAll<AuditEntry>('audit');
    rows.sort((a, b) => (a.at < b.at ? 1 : -1));
    return limit ? rows.slice(0, limit) : rows;
  },

  /* ---------------- wipe (danger zone / restore) ---------------- */
  async wipeAll(opts?: { keepUsers?: boolean }): Promise<void> {
    const list: string[] = [
      'products', 'transactions', 'audit', 'rolls', 'reels', 'permits',
      'customers', 'importlog',
      'reservations', 'resvTransfers', 'resvCancellations', 'resvLinks', 'resvAudit',
    ];
    if (!opts?.keepUsers) list.push('users');
    await Promise.all(list.map((s) => db.clear(s).catch(() => {})));
    await Promise.all([
      db.setSetting('lastImport', null),
      db.setSetting('docSeqTax', null),
      db.setSetting('docSeqNontax', null),
      db.setSetting('rollSeq', null),
    ]);
  },

  /** Replace only products + transactions (Excel import & replace). */
  async wipeBalanceScope(): Promise<void> {
    await Promise.all([db.clear('products'), db.clear('transactions')]);
  },
};

/* ------------------------- typed data helpers ------------------------- */

export const repo = {
  products: () => db.getAll<Product>('products'),
  transactions: () => db.getAll<Transaction>('transactions'),
  rolls: () => db.getAll<Roll>('rolls'),
  reels: () => db.getAll<Reel>('reels'),
  permits: () => db.getAll<Permit>('permits'),
  customers: () => db.getAll<Customer>('customers'),
  importlog: () => db.getAll<ImportLogEntry>('importlog'),
  users: () => db.getAll<LocalUser>('users'),
  reservations: () => db.getAll<Reservation>('reservations'),
  resvTransfers: () => db.getAll<ResvTransfer>('resvTransfers'),
  resvCancellations: () => db.getAll<ResvCancellation>('resvCancellations'),
  resvLinks: () => db.getAll<ResvLink>('resvLinks'),
  resvAudit: () => db.getAll<ResvAuditEntry>('resvAudit'),
};

export function uuid(): string {
  try { return crypto.randomUUID(); } catch {
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }
}
