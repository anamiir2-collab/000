/* =========================================================================
   resv.ts — customer reservations engine (tracking-only subsystem)
   -------------------------------------------------------------------------
   Reservations NEVER touch inventory: no add/deduct, no permits, no
   transactions. Links to issue permits are reference-only. The consumption
   registry (voucherLineKey) prevents counting the same permit line twice.
   Data lives in IndexedDB stores (migrated from the original localStorage).
   ========================================================================= */

import { repo, db, uuid } from './db';
import { productWeight, round6 } from './calc';
import { canonicalCustomer } from './utils';
import type {
  BalanceRow, Permit, ResvCancellation, ResvLink, ResvTransfer, Reservation,
  ReservationItem, Transaction, Voucher,
} from './types';

export const RESV_STATUS: Record<string, string> = {
  open: 'مفتوحة',
  loaded: 'مكتملة التحميل',
  transferred: 'محوّلة بالكامل',
  cancelled: 'ملغاة',
};

export const ITEM_STATUS: Record<string, string> = {
  available: 'متاح في المخزون',
  awaiting: 'بانتظار الإنتاج',
  received: 'استُلم في المخزون',
  loaded: 'تم التحميل',
  transferred: 'محوّل لعميل آخر',
  cancelled: 'ملغى',
};

export interface ItemState {
  item: ReservationItem;
  reservation: Reservation;
  required: number;
  loaded: number;
  loadedTransferred: number;
  transferred: number;
  cancelled: number;
  remaining: number;
  available: number;
  awaiting: number;
  estWeightPerReel: number;
  estWeightTotal: number;
  status: string;
  partial: boolean;
  receivedFlag: boolean;
}

export interface ResvState {
  reservation: Reservation;
  status: string;
  items: ItemState[];
  requested: number;
  available: number;
  awaiting: number;
  loaded: number;
  loadedTransferred: number;
  transferred: number;
  cancelled: number;
  remaining: number;
  receivedViaTransfers: number;
}

export interface ComputedAll {
  states: ResvState[];
  reportRows: ReportRow[];
  totals: { reservations: number; requested: number; available: number; awaiting: number; loaded: number; transferred: number; cancelled: number };
}

export interface ReportRow {
  reservationId: string;
  itemId: string;
  customer: string;
  seq: number;
  createdAt: string;
  quality: string;
  gsm: number;
  size: number;
  qty: number;
  available: number;
  loaded: number;
  voucherNos: string[];
  state: ItemState;
  cancelledFull: boolean;
}

function voucherLineKey(v: Voucher, lineIndex: number, quality: string, gsm: number, size: number, reelIds: string[]): string {
  return [v.key, 'L' + lineIndex, quality, gsm, size, 'R:' + [...reelIds].sort().join(',')].join('::');
}

export async function loadResvStores(): Promise<{
  reservations: Reservation[]; transfers: ResvTransfer[]; cancellations: ResvCancellation[]; links: ResvLink[];
}> {
  const [reservations, transfers, cancellations, links] = await Promise.all([
    repo.reservations(), repo.resvTransfers(), repo.resvCancellations(), repo.resvLinks(),
  ]);
  return { reservations, transfers, cancellations, links };
}

/** Full read-only computation (never writes). */
export async function computeAll(
  transactions: Transaction[],
  permits: Permit[],
  balances: Map<string, BalanceRow>,
  weightFactor: number,
): Promise<ComputedAll> {
  const { reservations, transfers, cancellations, links } = await loadResvStores();
  const vouchers: Voucher[] = (await import('./tx')).collectVouchers(transactions, permits);

  /* consumption registry: loadedQty per voucher-line per matched combo */
  const consumed = new Map<string, number>();
  for (const link of links) {
    const v = vouchers.find((x) => x.key === link.voucherKey);
    if (!v) continue; // stale link (permit deleted) — excluded from totals
    const l = v.lines[link.lineIndex];
    if (!l) continue;
    const k = voucherLineKey(v, link.lineIndex, l.quality, l.gsm, l.size, l.reelIds);
    consumed.set(k, (consumed.get(k) || 0) + (link.loadedQty || 0));
  }

  /* last production add per combo (drives استُلم في المخزون) */
  const lastProdAdd = new Map<string, string>();
  for (const t of transactions) {
    if (t.void || !(Number(t.addQty) > 0)) continue;
    const k = comboKeyStr(t.quality, t.gsm, t.size);
    const d = String(t.date).slice(0, 10);
    if (!lastProdAdd.has(k) || d > lastProdAdd.get(k)!) lastProdAdd.set(k, d);
  }

  /* active transfers by source item */
  const activeTransfers = transfers.filter((t) => t.status === 'active');
  const cancellationsByItem = new Map<string, number>();
  for (const c of cancellations) {
    cancellationsByItem.set(c.itemId, (cancellationsByItem.get(c.itemId) || 0) + (c.qty || 0));
  }

  const states: ResvState[] = [];
  const sorted = [...reservations].sort((a, b) =>
    String(a.createdAt).localeCompare(String(b.createdAt)) || (a.seq || 0) - (b.seq || 0));

  for (const r of sorted) {
    const items: ItemState[] = [];
    for (const item of r.items || []) {
      const cnl = cancellationsByItem.get(item.id) || 0;
      const trfs = activeTransfers.filter((t) => t.itemId === item.id);
      const transferredQty = round6(trfs.reduce((s, t) => s + (t.qty || 0), 0));

      /* links pointing at this item */
      const itemLinks = links.filter((l) => l.itemId === item.id && vouchers.some((v) => v.key === l.voucherKey));
      let loadedQty = 0, loadedTrfQty = 0;
      for (const l of itemLinks) {
        if (l.covers === 'transfer') loadedTrfQty += l.loadedQty || 0;
        else loadedQty += l.loadedQty || 0;
      }

      const required = round6(Math.max(0, (item.qtyRequired || 0) - cnl));
      const remaining = round6(Math.max(0, required - loadedQty - transferredQty));

      /* FCFS allocation: items ordered by reservation createdAt (already sorted) */
      const comboKey = comboKeyStr(item.quality, item.gsm, item.size);
      const b = balances.get(comboKey);
      const stockOf = Math.max(0, b ? b.net : 0);
      // allocation is computed globally below (two-pass); placeholder values here
      const it: ItemState = {
        item, reservation: r,
        required, loaded: round6(loadedQty), loadedTransferred: round6(loadedTrfQty),
        transferred: transferredQty, cancelled: cnl, remaining,
        available: 0, awaiting: 0,
        estWeightPerReel: productWeight(item.size, 1, weightFactor),
        estWeightTotal: productWeight(item.size, item.qtyRequired, weightFactor),
        status: 'available', partial: false, receivedFlag: false,
      };
      items.push(it);
    }

    states.push({
      reservation: r, status: 'open', items,
      requested: 0, available: 0, awaiting: 0, loaded: 0, loadedTransferred: 0,
      transferred: 0, cancelled: 0, remaining: 0, receivedViaTransfers: 0,
    });
  }

  /* second pass: global FCFS stock allocation across all active items */
  const stockLeft = new Map<string, number>();
  for (const st of states) {
    if (st.reservation.cancelled) continue;
    for (const it of st.items) {
      if (it.required <= 0) continue;
      const k = comboKeyStr(it.item.quality, it.item.gsm, it.item.size);
      if (!stockLeft.has(k)) {
        const b = balances.get(k);
        stockLeft.set(k, Math.max(0, b ? b.net : 0));
      }
    }
  }
  for (const st of states) {
    if (st.reservation.cancelled) continue;
    for (const it of st.items) {
      if (it.required <= 0) {
        it.available = 0; it.awaiting = 0; it.partial = false;
        it.status = it.transferred > 0 && it.loaded === 0 ? 'transferred' : (it.required <= 0 && it.cancelled > 0 ? 'cancelled' : 'loaded');
        continue;
      }
      const k = comboKeyStr(it.item.quality, it.item.gsm, it.item.size);
      const left = stockLeft.get(k) || 0;
      const take = Math.min(it.remaining, left);
      stockLeft.set(k, round6(left - take));
      it.available = round6(take);
      it.awaiting = round6(Math.max(0, it.remaining - take));
      const prodDate = lastProdAdd.get(k);
      it.receivedFlag = !!(it.available >= it.remaining && prodDate && prodDate >= String(st.reservation.date).slice(0, 10));
      it.partial = it.available > 0 && it.awaiting > 0;
      if (it.remaining <= 0) {
        it.status = it.loaded > 0 || it.loadedTransferred > 0 ? 'loaded' : 'transferred';
      } else {
        it.status = it.receivedFlag ? 'received'
          : it.available >= it.remaining ? 'available'
          : 'awaiting';
      }
    }
  }

  /* per-reservation aggregates + status */
  const reportRows: ReportRow[] = [];
  for (const st of states) {
    const r = st.reservation;
    let requested = 0, available = 0, awaiting = 0, loaded = 0, loadedTransferred = 0;
    let transferred = 0, cancelled = 0, remaining = 0, receivedViaTransfers = 0;
    for (const it of st.items) {
      requested += it.required;
      available += it.available;
      awaiting += it.awaiting;
      loaded += it.loaded;
      loadedTransferred += it.loadedTransferred;
      transferred += it.transferred;
      cancelled += it.cancelled;
      remaining += it.remaining;
    }
    // receivedViaTransfers: display-only count of links that cover transfers
    receivedViaTransfers = links.filter((l) => l.reservationId === r.id && l.covers === 'transfer')
      .reduce((s, l) => s + (l.loadedQty || 0), 0);

    st.requested = round6(requested);
    st.available = round6(available);
    st.awaiting = round6(awaiting);
    st.loaded = round6(loaded);
    st.loadedTransferred = round6(loadedTransferred);
    st.transferred = round6(transferred);
    st.cancelled = round6(cancelled);
    st.remaining = round6(remaining);
    st.receivedViaTransfers = round6(receivedViaTransfers);
    st.status = r.cancelled ? 'cancelled'
      : st.remaining <= 0 ? (st.loaded > 0 ? 'loaded' : (st.transferred > 0 ? 'transferred' : 'cancelled'))
      : 'open';

    /* unified report rows (skip fully-cancelled reservations) */
    if (!r.cancelled) {
      for (const it of st.items) {
        const qty = round6(it.required - it.cancelled);
        if (qty <= 0) continue;
        const voucherNos = Array.from(new Set(
          links.filter((l) => l.itemId === it.item.id).map((l) => l.voucherNo).filter(Boolean),
        ));
        reportRows.push({
          reservationId: r.id, itemId: it.item.id,
          customer: canonicalCustomer(r.customer), seq: r.seq || 0, createdAt: r.createdAt,
          quality: it.item.quality, gsm: it.item.gsm, size: it.item.size,
          qty, available: it.available, loaded: round6(it.loaded + it.loadedTransferred),
          voucherNos, state: it, cancelledFull: false,
        });
      }
    }
  }

  reportRows.sort((a, b) =>
    a.customer.localeCompare(b.customer, 'ar') || a.createdAt.localeCompare(b.createdAt) || a.seq - b.seq);

  return {
    states,
    reportRows,
    totals: {
      reservations: reservations.length,
      requested: round6(reportRows.reduce((s, r) => s + r.qty, 0)),
      available: round6(reportRows.reduce((s, r) => s + r.available, 0)),
      awaiting: round6(reportRows.reduce((s, r) => s + Math.max(0, r.qty - r.available - r.loaded), 0)),
      loaded: round6(reportRows.reduce((s, r) => s + r.loaded, 0)),
      transferred: round6(states.reduce((s, st) => s + st.transferred, 0)),
      cancelled: round6(states.reduce((s, st) => s + st.cancelled, 0)),
    },
  };
}

function comboKeyStr(quality: unknown, gsm: unknown, size: unknown): string {
  return `${String(quality ?? '').trim()}||${String(gsm ?? '')}||${String(size ?? '')}`;
}

/* ------------------------------ mutations ------------------------------ */

export async function nextResvSeq(reservations: Reservation[]): Promise<number> {
  return reservations.reduce((m, r) => Math.max(m, r.seq || 0), 0) + 1;
}

export async function createReservation(input: {
  customer: string; date: string; notes: string;
  items: { quality: string; gsm: number; size: number; qtyRequired: number }[];
}, actor?: string): Promise<Reservation> {
  const { reservations } = await loadResvStores();
  const now = new Date().toISOString();
  const r: Reservation = {
    id: 'res_' + uuid(),
    seq: await nextResvSeq(reservations),
    customer: input.customer.trim(),
    date: input.date,
    notes: input.notes || '',
    cancelled: false,
    createdAt: now,
    items: input.items.map((it) => ({ id: 'itm_' + uuid(), createdAt: now, ...it })),
  };
  await db.put('reservations', r as unknown as Record<string, unknown>);
  await logResv(`إنشاء حجز ${r.seq} للعميل ${r.customer} — ${r.items.length} بند`, actor);
  return r;
}

export async function updateReservation(r: Reservation, actor?: string): Promise<void> {
  r.updatedAt = new Date().toISOString();
  await db.put('reservations', r as unknown as Record<string, unknown>);
  await logResv(`تعديل حجز ${r.seq} (${r.customer})`, actor);
}

export async function logResv(details: string, actor?: string): Promise<void> {
  const e = { id: 'aud_' + uuid(), at: new Date().toISOString(), action: 'resv', details, actor: actor || null };
  await db.put('resvAudit', e as unknown as Record<string, unknown>);
  const all = await repo.resvAudit();
  if (all.length > 800) {
    const sorted = all.sort((a, b) => a.at.localeCompare(b.at));
    for (const old of sorted.slice(0, all.length - 800)) await db.del('resvAudit', old.id);
  }
}

export async function addTransfer(input: {
  fromReservationId: string; itemId: string; qty: number; toCustomer: string; date: string; notes: string;
}, actor?: string): Promise<void> {
  const { reservations } = await loadResvStores();
  const r = reservations.find((x) => x.id === input.fromReservationId);
  if (!r) throw new Error('الحجز المصدر غير موجود');
  const item = (r.items || []).find((i) => i.id === input.itemId);
  if (!item) throw new Error('البند غير موجود');
  if (input.toCustomer.trim() === r.customer.trim()) throw new Error('العميل المستلم يجب أن يختلف عن عميل الحجز المصدر');
  if (!(input.qty > 0)) throw new Error('أدخل كمية التحويل');
  const t: ResvTransfer = {
    id: 'trf_' + uuid(),
    fromReservationId: r.id, fromReservationSeq: r.seq, fromCustomer: r.customer,
    toCustomer: input.toCustomer.trim(), toReservationId: null,
    itemId: item.id, quality: item.quality, gsm: item.gsm, size: item.size,
    qty: input.qty, date: input.date, notes: input.notes || '',
    status: 'active', cancelledAt: null,
    createdAt: new Date().toISOString(),
  };
  await db.put('resvTransfers', t as unknown as Record<string, unknown>);
  await logResv(`تحويل ${input.qty} بكرة من حجز ${r.seq} (${r.customer}) إلى ${t.toCustomer}`, actor);
}

export async function cancelTransfer(transferId: string, actor?: string): Promise<void> {
  const t = await db.get<ResvTransfer>('resvTransfers', transferId);
  if (!t) throw new Error('التحويل غير موجود');
  t.status = 'cancelled';
  t.cancelReason = 'إلغاء يدوي';
  t.cancelledAt = new Date().toISOString();
  await db.put('resvTransfers', t as unknown as Record<string, unknown>);
  await logResv(`إلغاء تحويل ${t.qty} بكرة من حجز ${t.fromReservationSeq} إلى ${t.toCustomer}`, actor);
}

export async function cancelReservationQty(input: {
  reservationId: string; itemId?: string; qty: number; date: string; reason: string;
}, actor?: string): Promise<void> {
  const { reservations } = await loadResvStores();
  const r = reservations.find((x) => x.id === input.reservationId);
  if (!r) throw new Error('الحجز غير موجود');
  const items = input.itemId ? (r.items || []).filter((i) => i.id === input.itemId) : (r.items || []);
  if (!items.length) throw new Error('لا توجد بنود للإلغاء');
  const perItem = input.itemId ? input.qty : input.qty;
  for (const item of items) {
    const c: ResvCancellation = {
      id: 'cnl_' + uuid(),
      reservationId: r.id, reservationSeq: r.seq, customer: r.customer,
      itemId: item.id,
      level: input.itemId ? (input.qty >= item.qtyRequired ? 'item' : 'partial') : 'reservation',
      quality: item.quality, gsm: item.gsm, size: item.size,
      qty: perItem, date: input.date, reason: input.reason || '',
      createdAt: new Date().toISOString(),
    };
    await db.put('resvCancellations', c as unknown as Record<string, unknown>);
  }
  if (!input.itemId) {
    r.cancelled = true;
    r.cancelDate = input.date;
    r.cancelReason = input.reason || '';
    r.updatedAt = new Date().toISOString();
    await db.put('reservations', r as unknown as Record<string, unknown>);
  }
  await logResv(`إلغاء ${input.qty} بكرة من حجز ${r.seq} (${r.customer})${input.reason ? ' — ' + input.reason : ''}`, actor);
}

export async function addLink(input: {
  reservationId: string; itemId: string; voucher: Voucher; lineIndex: number;
  loadedQty: number; covers: 'remaining' | 'transfer'; transferId?: string | null;
}, actor?: string): Promise<void> {
  const { reservations } = await loadResvStores();
  const r = reservations.find((x) => x.id === input.reservationId);
  if (!r) throw new Error('الحجز غير موجود');
  const item = (r.items || []).find((i) => i.id === input.itemId);
  if (!item) throw new Error('البند غير موجود');
  const l = input.voucher.lines[input.lineIndex];
  if (!l) throw new Error('سطر الإذن غير موجود');
  const link: ResvLink = {
    id: 'lnk_' + uuid(),
    reservationId: r.id, reservationSeq: r.seq, customer: r.customer,
    itemId: item.id,
    voucherKey: input.voucher.key, voucherKind: input.voucher.kind,
    voucherPermitId: input.voucher.permitId || null,
    voucherNo: input.voucher.permitNo, voucherCls: input.voucher.cls || '',
    voucherDate: input.voucher.date, voucherCustomer: input.voucher.customer,
    lineIndex: input.lineIndex, lineQty: l.qty,
    matched: { quality: l.quality, gsm: l.gsm, size: l.size },
    loadedQty: input.loadedQty,
    covers: input.covers, transferId: input.transferId ?? null,
    linkedAt: new Date().toISOString(),
  };
  await db.put('resvLinks', link as unknown as Record<string, unknown>);
  await logResv(`ربط إذن ${input.voucher.permitNo} بحجز ${r.seq} — تحميل ${input.loadedQty} بكرة`, actor);
}

export async function removeLink(linkId: string, actor?: string): Promise<void> {
  const link = await db.get<ResvLink>('resvLinks', linkId);
  if (!link) return;
  await db.del('resvLinks', linkId);
  await logResv(`إلغاء ربط إذن ${link.voucherNo} من حجز ${link.reservationSeq} — الإذن نفسه لن يُعدل ولا يُحذف`, actor);
}
