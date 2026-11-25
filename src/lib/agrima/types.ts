/* =========================================================================
   types.ts — Agrima ERP data model (fully local, no Supabase)
   -------------------------------------------------------------------------
   The IndexedDB schema keeps the SAME database name (`inventory_pwa_db`)
   and the SAME store shapes as the original app (v4), so any data already
   stored in the user's browser is loaded untouched. v5 adds purely-new
   stores: local users (auth) + reservations (migrated from localStorage).
   ========================================================================= */

export type ReelStatus = 'available' | 'dispatched' | 'returned' | 'undefined';
export type PermitStatus = 'draft' | 'approved';
export type PermitCls = 'ض' | 'غ';
export type Role = 'admin' | 'warehouse';

export interface Product {
  id?: number;
  quality: string;
  gsm: number | string | null;
  size: number | string | null;
  combo: string;
  source?: string;
  refBalance?: number | null;
  refWeight?: number | null;
  createdAt?: string;
}

export interface Transaction {
  id?: number;
  date: string; // ISO YYYY-MM-DD
  quality: string;
  gsm: number | string | null;
  size: number | string | null;
  customer: string;
  permitNo: string;
  addQty: number;
  outQty: number;
  weight: number | null; // kg
  settlement: string; // 'ض' | 'غ' | ''
  notes: string;
  source?: string; // manual | excel | reels | permit
  excelRow?: number | null;
  fingerprint: string;
  createdAt?: string;
  updatedAt?: string | null;
  groupId?: string | null;
  reelId?: string | null;
  void?: boolean;
  weightUnit?: string;
  permitId?: string;
}

export interface Roll {
  id?: number;
  rollNo: number;
  gram: number | null;
  date: string;
  notes: string;
  source?: string; // reels | excel
  createdAt?: string;
  updatedAt?: string | null;
}

export interface Reel {
  id: string;
  rollNo: number;
  reelNo: number;
  size: number | null;
  weight: number | null; // kg
  gram: number | null;
  quality: string | null;
  status: ReelStatus;
  permitRef?: {
    permitId: string;
    permitNo: string;
    cls: string;
    customer: string;
    date: string;
  } | null;
  source?: string;
  rollReel: string; // unique "rollNo|reelNo"
  createdAt?: string;
  updatedAt?: string | null;
}

export interface PermitLine {
  quality: string;
  gsm: number;
  size: number;
  qty: number;
  weight?: number | null; // per-bale manual weight (optional)
  reelIds?: string[];
  weightKg?: number | null; // Σ selected reel weights (or manual × qty)
}

export interface PermitTotals {
  rolls: number;
  weightKg: number;
  weightEstimated: boolean;
}

export interface Permit {
  id: string;
  permitNo: string;
  cls: PermitCls;
  customer: string;
  date: string;
  notes: string;
  status: PermitStatus;
  lines: PermitLine[];
  groupId?: string | null;
  source?: string;
  createdAt?: string;
  approvedAt?: string | null;
  updatedAt?: string | null;
  permitKey?: string; // 'cls|permitNo'
  totals?: PermitTotals | null;
}

export interface Customer {
  id?: number;
  name: string;
  notes?: string;
  source?: string;
  createdAt?: string;
}

export interface AuditEntry {
  id?: number;
  entity: string;
  action: string;
  entityId?: string | number;
  before?: unknown;
  after?: unknown;
  at: string;
  details?: string;
  actor?: string | null;
  sid?: string;
}

export interface ImportLogEntry {
  key: string;
  fileName: string;
  kind: string;
  at: string;
  summary?: Record<string, unknown>;
}

/* ---------------------------- local auth ---------------------------- */

export interface LocalUser {
  id: string;
  email: string;
  fullName: string;
  role: Role | '';
  active: boolean;
  passHash: string; // pbkdf2$iterations$saltB64$hashB64
  createdAt: string;
  lastLoginAt?: string | null;
  updatedAt?: string | null;
}

export interface SessionProfile {
  id: string;
  email: string;
  fullName: string;
  role: Role | '';
  active: boolean;
}

/* -------------------------- reservations ---------------------------- */

export interface ReservationItem {
  id: string;
  quality: string;
  gsm: number;
  size: number;
  qtyRequired: number;
  createdAt?: string;
}

export interface Reservation {
  id: string; // 'res_...'
  seq: number;
  customer: string;
  date: string;
  notes?: string;
  cancelled: boolean;
  cancelDate?: string | null;
  cancelReason?: string;
  createdAt: string;
  updatedAt?: string;
  items: ReservationItem[];
}

export interface ResvTransfer {
  id: string; // 'trf_...'
  fromReservationId: string;
  fromReservationSeq: number;
  fromCustomer: string;
  toCustomer: string;
  toReservationId: string | null;
  itemId: string;
  quality: string;
  gsm: number;
  size: number;
  qty: number;
  date: string;
  notes?: string;
  status: 'active' | 'cancelled';
  cancelReason?: string;
  cancelledAt?: string | null;
  createdAt: string;
}

export interface ResvCancellation {
  id: string; // 'cnl_...'
  reservationId: string;
  reservationSeq: number;
  customer: string;
  itemId: string;
  level: 'reservation' | 'item' | 'partial';
  quality: string;
  gsm: number;
  size: number;
  qty: number;
  date: string;
  reason?: string;
  createdAt: string;
}

export interface ResvLink {
  id: string; // 'lnk_...'
  reservationId: string;
  reservationSeq: number;
  customer: string;
  itemId: string;
  voucherKey: string;
  voucherKind: 'permit' | 'derived';
  voucherPermitId: string | null;
  voucherNo: string;
  voucherCls: string;
  voucherDate: string;
  voucherCustomer: string;
  lineIndex: number;
  lineQty: number;
  matched: { quality: string; gsm: number; size: number };
  loadedQty: number;
  covers: 'remaining' | 'transfer';
  transferId?: string | null;
  notes?: string;
  linkedAt: string;
}

export interface ResvAuditEntry {
  id: string;
  at: string;
  action: string;
  details: string;
  actor?: string;
}

/* ------------------------- vouchers / reports ------------------------ */

export interface VoucherLine {
  quality: string;
  family: string;
  gsm: number;
  weight: number | null;
  size: number;
  qty: number;
  reelCount: number;
  reelIds: string[];
  weightKg?: number | null;
  weightEstimated?: boolean;
}

export interface Voucher {
  key: string;
  kind: 'permit' | 'derived';
  permitId?: string | null;
  status: PermitStatus | 'imported';
  permitNo: string;
  cls: PermitCls | '';
  customer: string;
  date: string;
  notes: string;
  groupId?: string | null;
  lines: VoucherLine[];
  totalRolls: number;
  totalWeightKg: number | null;
  weightEstimated: boolean;
  minId: number;
  createdAt?: string;
  multiDate?: boolean;
  customerConflict?: boolean;
  conflictCustomers?: string[];
}

export interface BalanceRow {
  key: string;
  quality: string;
  family?: string;
  gsm: number | string | null;
  size: number | string | null;
  weight?: number | null;
  add: number;
  out: number;
  net: number;
}

export interface Settings {
  companyName: string;
  lang: 'ar' | 'en';
  weightFactor: number;
  docSeqTax: number;
  docSeqNontax: number;
  rollSeq: number;
  usedDocNos?: string[];
  lastImport?: { at: string; newTx: number; dupTx: number; inFileDup: number; newProd: number; existingProd: number; sheets?: string[] } | null;
  lastWarehouseImport?: { at: string; rolls: number; reels: number } | null;
}

export type Route =
  | 'dashboard' | 'inventory' | 'products'
  | 'issuedocs' | 'issuedoc' | 'baker-issue'
  | 'reservations' | 'reservation-form' | 'reservation-details'
  | 'outlog' | 'production' | 'history' | 'addtx'
  | 'reels-add' | 'rolls'
  | 'customers'
  | 'reports' | 'import' | 'backup' | 'settings'
  | 'users' | 'audit' | 'account';
