/* =========================================================================
   tx.ts — business operations layer (exact port of transactions.js logic)
   -------------------------------------------------------------------------
   IMPORTANT: every multi-record operation runs inside ONE atomic IndexedDB
   transaction using fully SYNCHRONOUS request chaining (each step queues
   its next request inside an onsuccess handler). IndexedDB auto-commits a
   transaction when no requests are pending, so no `await` may occur inside
   the atomic callback — this is what makes document saving + numbering
   counters + reel status flips all-or-nothing.
   Zero Supabase anywhere.
   ========================================================================= */

import { db, repo, uuid } from './db';
import {
  cleanStr, comboKey, comboKeyOf, computeBalances, isComboComplete,
  round6, toNumberOrRaw,
} from './calc';
import { canonicalCustomer, productFamily, sizesLabel } from './utils';
import type {
  Permit, PermitCls, PermitLine, Reel, ReelStatus, Roll, Transaction, Voucher, VoucherLine,
} from './types';

export const CLS_LABEL: Record<string, string> = { 'ض': 'ضريبي', 'غ': 'غير ضريبي' };
export const SEQ_KEYS: Record<string, string> = { 'ض': 'docSeqTax', 'غ': 'docSeqNontax' };
export const PERMIT_GROUP_PREFIX = 'P:';

export const REEL_STATUS: Record<ReelStatus, string> = {
  available: 'متاحة',
  dispatched: 'مصروفة',
  returned: 'مرجعة للمورد',
  undefined: 'غير محددة',
};

/* ------------------------------ fingerprint ------------------------------ */

export function txFingerprint(t: Omit<Transaction, 'fingerprint'>): string {
  return [
    cleanStr(t.date), cleanStr(t.quality), toNumberOrRaw(t.gsm), toNumberOrRaw(t.size),
    cleanStr(t.customer), cleanStr(t.permitNo), Number(t.addQty) || 0, Number(t.outQty) || 0,
    cleanStr(t.settlement),
  ].join('||');
}

/* ------------------------------ validation ------------------------------ */

export function validateTransaction(t: Partial<Transaction>): string[] {
  const errors: string[] = [];
  if (!cleanStr(t.date)) errors.push('التاريخ مطلوب');
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanStr(t.date))) errors.push('صيغة التاريخ غير صحيحة');
  if (!cleanStr(t.quality)) errors.push('اسم الصنف مطلوب');
  if (!cleanStr(t.customer)) errors.push('اسم العميل أو الجهة مطلوب');
  const a = Number(t.addQty) || 0;
  const o = Number(t.outQty) || 0;
  if (a < 0 || o < 0) errors.push('الكمية لا يمكن أن تكون سالبة');
  if (a > 0 && o > 0) errors.push('لا يمكن إدخال إضافة وصرف معًا في نفس الحركة');
  if (a === 0 && o === 0) errors.push('يجب إدخال كمية (إضافة أو صرف)');
  if (!isComboComplete(t.quality, t.gsm, t.size)) errors.push('الجرام والمقاس مطلوبان لحساب الرصيد');
  return errors;
}

export function normalizeRow(t: Partial<Transaction>, source = 'manual'): Transaction {
  const a = Number(t.addQty) || 0;
  const o = Number(t.outQty) || 0;
  const w = t.weight == null ? null : Number(t.weight);
  const settlementRaw = cleanStr(t.settlement);
  const row: Transaction = {
    date: cleanStr(t.date),
    quality: cleanStr(t.quality),
    gsm: toNumberOrRaw(t.gsm),
    size: toNumberOrRaw(t.size),
    customer: cleanStr(t.customer),
    permitNo: cleanStr(t.permitNo),
    addQty: round6(a), outQty: round6(o),
    weight: w === null || isNaN(w) ? null : round6(w),
    settlement: settlementRaw,
    notes: cleanStr(t.notes),
    groupId: cleanStr(t.groupId) || null,
    reelId: t.reelId ?? null,
    source: source || 'manual',
    excelRow: t.excelRow ?? null,
    createdAt: t.createdAt || new Date().toISOString(),
    updatedAt: null,
    void: !!t.void,
    fingerprint: '',
  };
  row.fingerprint = txFingerprint(row);
  return row;
}

/* --------------------- sync helpers inside transactions --------------------- */

/** Product-master top-up: queues an index read; the write happens in its onsuccess (sync chain). */
function ensureProductInTx(t: IDBTransaction, quality: string, gsm: unknown, size: unknown, source: string): void {
  const combo = comboKey(quality, gsm, size);
  if (!isComboComplete(quality, gsm, size)) return;
  const st = t.objectStore('products');
  const req = st.index('combo').get(combo);
  req.onsuccess = () => {
    if (req.result) {
      const p = req.result as Record<string, unknown>;
      if (!p.source || p.source === 'discovered') {
        p.source = source;
        st.put(p);
      }
    } else {
      st.add({
        quality: cleanStr(quality), gsm: toNumberOrRaw(gsm), size: toNumberOrRaw(size),
        combo, source, createdAt: new Date().toISOString(),
      });
    }
  };
}

function auditInTx(t: IDBTransaction, entry: { entity: string; action: string; entityId?: string | number; details?: string; actor?: string | null; before?: unknown; after?: unknown }): void {
  t.objectStore('audit').add({
    at: new Date().toISOString(), sid: uuid(), ...entry,
  } as unknown as Record<string, unknown>);
}

/* ------------------------------ CRUD: rows ------------------------------ */

export async function addTransactionGroup(
  header: Partial<Transaction>, sizes: { size: number; qty: number; which: 'add' | 'out' }[], actor?: string,
): Promise<void> {
  const gid = uuid();
  const rows = sizes.map((s) => normalizeRow({
    ...header,
    size: s.size,
    addQty: s.which === 'add' ? s.qty : 0,
    outQty: s.which === 'out' ? s.qty : 0,
    groupId: gid,
  }));
  for (const r of rows) {
    const errs = validateTransaction(r);
    if (errs.length) throw new Error(errs[0]);
  }
  await db.atomic(['transactions', 'products', 'audit'], (t) => {
    const st = t.objectStore('transactions');
    rows.forEach((r) => {
      ensureProductInTx(t, r.quality, r.gsm, r.size, 'manual');
      st.add(r as unknown as Record<string, unknown>);
    });
    auditInTx(t, {
      entity: 'movement', action: 'add', entityId: gid,
      details: `إضافة حركة مجمعة: ${cleanStr(header.quality)} / ${toNumberOrRaw(header.gsm)} — ${sizes.length} مقاس (${canonicalCustomer(header.customer)})`,
      actor: actor || null,
    });
    return true;
  });
}

export async function replaceMovement(
  oldRows: Transaction[], newRow: Partial<Transaction>, actor?: string,
): Promise<void> {
  const errs = validateTransaction(newRow);
  if (errs.length) throw new Error(errs[0]);
  const row = normalizeRow({ ...newRow, groupId: oldRows.length > 1 ? oldRows[0].groupId : (newRow.groupId ?? null) });
  await db.atomic(['transactions', 'products', 'audit'], (t) => {
    const st = t.objectStore('transactions');
    oldRows.forEach((r) => st.delete(r.id as number));
    ensureProductInTx(t, row.quality, row.gsm, row.size, 'manual');
    st.add(row as unknown as Record<string, unknown>);
    auditInTx(t, {
      entity: 'movement', action: 'edit', entityId: oldRows[0].groupId || String(oldRows[0].id),
      before: oldRows.map((r) => ({ size: r.size, addQty: r.addQty, outQty: r.outQty })),
      after: { size: row.size, addQty: row.addQty, outQty: row.outQty },
      details: 'تعديل حركة (مسجل في سجل التدقيق)',
      actor: actor || null,
    });
    return true;
  });
}

export async function updateTransaction(id: number, patch: Partial<Transaction>, actor?: string): Promise<void> {
  const old = await db.get<Transaction>('transactions', id);
  if (!old) throw new Error('الحركة غير موجودة');
  const merged = normalizeRow({ ...old, ...patch });
  const errs = validateTransaction(merged);
  if (errs.length) throw new Error(errs[0]);
  merged.id = id;
  merged.updatedAt = new Date().toISOString();
  await db.atomic(['transactions', 'products', 'audit'], (t) => {
    const st = t.objectStore('transactions');
    ensureProductInTx(t, merged.quality, merged.gsm, merged.size, 'manual');
    st.put(merged as unknown as Record<string, unknown>);
    auditInTx(t, {
      entity: 'movement', action: 'edit', entityId: String(id),
      before: { size: old.size, addQty: old.addQty, outQty: old.outQty, customer: old.customer, permitNo: old.permitNo, weight: old.weight, settlement: old.settlement },
      after: { size: merged.size, addQty: merged.addQty, outQty: merged.outQty, customer: merged.customer, permitNo: merged.permitNo, weight: merged.weight, settlement: merged.settlement },
      details: 'تعديل حركة (التعديل مسجل في سجل التدقيق)',
      actor: actor || null,
    });
    return true;
  });
}

export async function deleteMovement(rows: Transaction[], actor?: string): Promise<void> {
  if (!rows.length) return;
  await db.atomic(['transactions', 'audit'], (t) => {
    const st = t.objectStore('transactions');
    rows.forEach((r) => { if (r.id != null) st.delete(r.id); });
    auditInTx(t, {
      entity: 'movement', action: 'delete',
      entityId: rows[0].groupId || String(rows[0].id),
      before: rows.map((r) => ({ date: r.date, quality: r.quality, size: r.size, addQty: r.addQty, outQty: r.outQty })),
      details: `حذف حركة: ${rows[0].quality} — ${sizesLabel(rows.map((r) => ({ size: r.size, qty: r.addQty || r.outQty })))}`,
      actor: actor || null,
    });
    return true;
  });
}

/* --------------------------- doc numbering --------------------------- */

export async function nextDocNumbers(): Promise<{ tax: number; nontax: number; maxTax: number; maxNontax: number }> {
  const txRows = await repo.transactions();
  const permits = await repo.permits();
  const maxOf = (cls: string) => {
    let mx = 0;
    for (const r of txRows) {
      if (!r.outQty || r.void) continue;
      if (r.settlement !== cls) continue;
      const n = Number(r.permitNo);
      if (!isNaN(n) && String(n) === String(r.permitNo).trim() && n > mx) mx = n;
    }
    for (const p of permits) {
      if (p.cls !== cls) continue;
      const n = Number(p.permitNo);
      if (!isNaN(n) && String(n) === String(p.permitNo).trim() && n > mx) mx = n;
    }
    return mx;
  };
  const maxTax = maxOf('ض');
  const maxNontax = maxOf('غ');
  const seqTax = (await db.getSetting<number | null>('docSeqTax', null)) ?? 0;
  const seqNontax = (await db.getSetting<number | null>('docSeqNontax', null)) ?? 0;
  return {
    tax: Math.max(maxTax + 1, seqTax || 1),
    nontax: Math.max(maxNontax + 1, seqNontax || 1),
    maxTax, maxNontax,
  };
}

export async function saveDocSequences(tax: number, nontax: number): Promise<void> {
  await Promise.all([db.setSetting('docSeqTax', tax), db.setSetting('docSeqNontax', nontax)]);
}

/* ------------------------- vouchers (unified) ------------------------- */

interface TxGroup {
  key: string; rows: Transaction[]; date: string; quality: string;
  gsm: number | string | null; customer: string; permitNo: string;
  settlement: string; notes: string; source: string; add: number; out: number; id: number;
}

export function buildGroups(rows: Transaction[]): TxGroup[] {
  const map = new Map<string, TxGroup>();
  for (const r of rows) {
    const key = r.groupId ? 'G:' + r.groupId : 'S:' + r.id;
    let g = map.get(key);
    if (!g) {
      g = {
        key, rows: [], date: r.date, quality: r.quality, gsm: r.gsm, customer: r.customer,
        permitNo: r.permitNo, settlement: r.settlement, notes: r.notes, source: r.source || '',
        add: 0, out: 0, id: r.id as number,
      };
      map.set(key, g);
    }
    g.rows.push(r);
    g.add += Number(r.addQty) || 0;
    g.out += Number(r.outQty) || 0;
  }
  const list = Array.from(map.values());
  for (const g of list) { g.add = round6(g.add); g.out = round6(g.out); }
  list.sort((a, b) => {
    const d = String(b.date).localeCompare(String(a.date));
    if (d !== 0) return d;
    return (b.id || 0) - (a.id || 0);
  });
  return list;
}

/** Unified voucher list: app permits + derived (imported) documents. */
export function collectVouchers(transactions: Transaction[], permits: Permit[]): Voucher[] {
  const out: Voucher[] = [];
  const permitGroupIds = new Set(permits.map((p) => PERMIT_GROUP_PREFIX + p.id));

  /* --- A. app permits --- */
  for (const p of permits) {
    const lines: VoucherLine[] = p.lines.map((l: PermitLine) => {
      /* line weight: actual reel weight (weightKg) else manual per-bale × qty.
         The voucher-level TOTAL still uses the frozen p.totals snapshot,
         but line detail keeps the real recorded weight for printing. */
      const lineW = l.weightKg != null ? round6(l.weightKg)
        : (l.weight && l.weight > 0 ? round6(l.weight * l.qty) : null);
      const est = lineW == null;
      return {
        quality: l.quality, family: productFamily(l.quality), gsm: Number(l.gsm),
        weight: l.weight ?? null, size: Number(l.size), qty: Number(l.qty) || 0,
        reelCount: (l.reelIds || []).length, reelIds: l.reelIds || [],
        weightKg: lineW,
        weightEstimated: est,
      };
    });
    let totalWeightKg: number | null = null;
    let weightEstimated = false;
    if (p.status === 'approved' && p.totals) {
      totalWeightKg = p.totals.weightKg ?? null;
      weightEstimated = !!p.totals.weightEstimated;
    } else {
      const known = lines.filter((l) => l.weightKg != null);
      totalWeightKg = known.length ? round6(known.reduce((s, l) => s + (l.weightKg || 0), 0)) : null;
      weightEstimated = lines.some((l) => l.weightEstimated);
    }
    out.push({
      key: 'PT|' + p.id, kind: 'permit', permitId: p.id, status: p.status,
      permitNo: p.permitNo, cls: p.cls, customer: p.customer, date: p.date,
      notes: p.notes || '', groupId: PERMIT_GROUP_PREFIX + p.id, lines,
      totalRolls: round6(lines.reduce((s, l) => s + l.qty, 0)),
      totalWeightKg, weightEstimated, minId: 0, createdAt: p.createdAt,
    });
  }

  /* --- B. derived (imported) documents --- */
  const derivedRows = transactions.filter((r) =>
    r.outQty > 0 && !r.void && (!r.groupId || !permitGroupIds.has(r.groupId)));
  const buckets = new Map<string, Transaction[]>();
  for (const r of derivedRows) {
    const bKey = r.permitNo
      ? `DV|${r.settlement || ''}|${r.permitNo}|${r.customer}`
      : (r.groupId ? `DG:${r.groupId}` : `DS:${r.id}`);
    let arr = buckets.get(bKey);
    if (!arr) { arr = []; buckets.set(bKey, arr); }
    arr.push(r);
  }
  for (const [bKey, rows] of buckets) {
    const dates = Array.from(new Set(rows.map((r) => String(r.date).slice(0, 10)))).sort();
    const first = rows[0];
    const noteCounts = new Map<string, number>();
    for (const r of rows) {
      const n = cleanStr(r.notes);
      if (n && !/^رول \d+/.test(n)) noteCounts.set(n, (noteCounts.get(n) || 0) + 1);
    }
    let note = '';
    let best = 0;
    noteCounts.forEach((c, n) => { if (c > best) { best = c; note = n; } });
    const lineMap = new Map<string, VoucherLine>();
    for (const r of rows) {
      const lk = cleanStr(r.quality) + '||' + String(toNumberOrRaw(r.gsm)) + '||W:' + (r.weight == null ? '—' : String(Number(r.weight)));
      let line = lineMap.get(lk);
      if (!line) {
        line = {
          quality: cleanStr(r.quality), family: productFamily(r.quality),
          gsm: Number(toNumberOrRaw(r.gsm)) || 0, weight: r.weight == null ? null : Number(r.weight),
          size: Number(toNumberOrRaw(r.size)) || 0, qty: 0, reelCount: 0, reelIds: [],
          weightKg: null, weightEstimated: r.weight == null,
        };
        lineMap.set(lk, line);
      }
      line.qty += Number(r.outQty) || 0;
      if (r.weight != null) {
        line.weightKg = round6((line.weightKg || 0) + Number(r.weight));
        line.weightEstimated = false;
      }
    }
    const lines = Array.from(lineMap.values()).sort((a, b) =>
      a.family.localeCompare(b.family, 'ar') || a.gsm - b.gsm || (a.weight ?? 0) - (b.weight ?? 0));
    const knownWeight = rows.some((r) => r.weight != null);
    out.push({
      key: bKey, kind: 'derived', permitId: null, status: 'imported',
      permitNo: first.permitNo || '',
      cls: (first.settlement === 'ض' || first.settlement === 'غ') ? first.settlement : '',
      customer: canonicalCustomer(first.customer), date: dates[dates.length - 1], notes: note,
      lines,
      totalRolls: round6(lines.reduce((s, l) => s + l.qty, 0)),
      totalWeightKg: knownWeight ? round6(rows.reduce((s, r) => s + (Number(r.weight) || 0), 0)) : null,
      weightEstimated: !knownWeight,
      minId: Math.min(...rows.map((r) => r.id || 0)),
      multiDate: dates.length > 1,
    });
  }

  /* --- customer-conflict detection (same permitNo + cls, different customers) --- */
  const byNo = new Map<string, Set<string>>();
  for (const v of out) {
    if (!v.permitNo || !v.cls) continue;
    const k = v.cls + '|' + v.permitNo;
    const set = byNo.get(k) || new Set<string>();
    set.add(canonicalCustomer(v.customer));
    byNo.set(k, set);
  }
  for (const v of out) {
    if (!v.permitNo || !v.cls) continue;
    const set = byNo.get(v.cls + '|' + v.permitNo);
    if (set && set.size > 1) {
      v.customerConflict = true;
      v.conflictCustomers = Array.from(set);
    }
  }
  return out;
}

/* --------------------------- reels & rolls --------------------------- */

export async function findAvailableReels(quality: string, gsm: number, size: number): Promise<Reel[]> {
  const reels = await repo.reels();
  return reels
    .filter((r) => r.status === 'available'
      && cleanStr(r.quality) === cleanStr(quality)
      && Number(r.gram) === Number(gsm)
      && Number(r.size) === Number(size))
    .sort((a, b) => a.rollNo - b.rollNo || a.reelNo - b.reelNo);
}

export async function nextRollNo(): Promise<number> {
  const rolls = await repo.rolls();
  let mx = 0;
  for (const r of rolls) if (Number(r.rollNo) > mx) mx = Number(r.rollNo);
  const seq = (await db.getSetting<number | null>('rollSeq', null)) || 1;
  return Math.max(mx + 1, seq);
}

export interface ReelInput { reelNo: number; size: number; weight: number; gram: number; quality: string }

export async function saveRollWithReels(
  input: { date: string; gram: number | null; notes: string; reels: ReelInput[] },
  actor?: string,
): Promise<{ rollNo: number; reels: number }> {
  const complete = input.reels.filter((r) =>
    r.reelNo > 0 && r.size > 0 && r.weight > 0 && r.gram > 0 && cleanStr(r.quality));
  if (complete.length === 0) throw new Error('أضف بكرة واحدة مكتملة على الأقل — الصفوف الناقصة لا تُحفظ');
  const seen = new Set<number>();
  for (const r of complete) {
    if (seen.has(r.reelNo)) throw new Error(`رقم البكرة ${r.reelNo} مكرر داخل الرول.`);
    seen.add(r.reelNo);
  }
  /* result is computed inside the tx's onsuccess chain and captured via the box
     below; db.atomic resolves only AFTER the transaction commits. */
  const box: { v?: { rollNo: number; reels: number } } = {};
  await db.atomic(
    ['rolls', 'reels', 'transactions', 'products', 'audit', 'settings'],
    (t) => {
      const rollsSt = t.objectStore('rolls');
      const reelsSt = t.objectStore('reels');
      const txSt = t.objectStore('transactions');
      const settingsSt = t.objectStore('settings');
      const allReq = rollsSt.getAll();
      const seqReq = settingsSt.get('rollSeq');
      seqReq.onsuccess = () => {
        const rolls = (allReq.result || []) as Roll[];
        let maxNo = 0;
        for (const r of rolls) if (Number(r.rollNo) > maxNo) maxNo = Number(r.rollNo);
        const seq = ((seqReq.result as { value?: number } | undefined)?.value) || 1;
        const rollNo = Math.max(maxNo + 1, seq);
        const now = new Date().toISOString();
        rollsSt.add({
          rollNo,
          gram: input.gram && input.gram > 0 ? input.gram : (complete.length === 1 ? complete[0].gram : null),
          date: input.date, notes: input.notes, source: 'reels',
          createdAt: now, updatedAt: null,
        } as unknown as Record<string, unknown>);
        for (const r of complete) {
          const id = uuid();
          const reel: Reel = {
            id, rollNo, reelNo: r.reelNo, size: r.size, weight: round6(r.weight),
            gram: r.gram, quality: cleanStr(r.quality), status: 'available',
            permitRef: null, source: 'reels', rollReel: `${rollNo}|${r.reelNo}`,
            createdAt: now, updatedAt: null,
          };
          reelsSt.add(reel as unknown as Record<string, unknown>);
          const mv: Transaction = {
            date: input.date, quality: cleanStr(r.quality), gsm: r.gram, size: r.size,
            customer: 'الإنتاج', permitNo: '', addQty: 1, outQty: 0,
            weight: round6(r.weight), settlement: '', notes: `رول ${rollNo} — بكرة ${r.reelNo}`,
            groupId: `R:roll-${rollNo}`, reelId: id, source: 'reels',
            fingerprint: `reel||${rollNo}||${r.reelNo}||${id}`,
            createdAt: now, updatedAt: null,
          };
          ensureProductInTx(t, mv.quality, mv.gsm, mv.size, 'reels');
          txSt.add(mv as unknown as Record<string, unknown>);
        }
        settingsSt.put({ key: 'rollSeq', value: rollNo + 1 });
        auditInTx(t, {
          entity: 'roll', action: 'add', entityId: String(rollNo),
          details: `تسجيل رول ${rollNo} — ${complete.length} بكرة — إنتاج تلقائي ${complete.length} حركة`,
          actor: actor || null,
        });
        box.v = { rollNo, reels: complete.length };
      };
      return undefined;
    },
  );
  if (!box.v) throw new Error('فشل حفظ الرول');
  return box.v;
}

export async function deleteRoll(rollNo: number, actor?: string): Promise<void> {
  const reels = (await repo.reels()).filter((r) => r.rollNo === rollNo);
  const blocked = reels.filter((r) => r.status === 'dispatched' || r.status === 'returned');
  if (blocked.length > 0) throw new Error(`لا يمكن حذف الرول ${rollNo}: ${blocked.length} بكرة مرتبطة بأذون صرف أو مرتجعات موردين`);
  const reelIds = new Set(reels.map((r) => r.id));
  const txRows = (await repo.transactions()).filter((t) => t.reelId && reelIds.has(t.reelId));
  await db.atomic(['rolls', 'reels', 'transactions', 'audit'], (t) => {
    const rollsSt = t.objectStore('rolls');
    const req = rollsSt.index('rollNo').get(rollNo);
    req.onsuccess = () => {
      const roll = req.result as Roll | undefined;
      if (roll && roll.id != null) rollsSt.delete(roll.id);
      const reelsSt = t.objectStore('reels');
      const txSt = t.objectStore('transactions');
      reels.forEach((r) => reelsSt.delete(r.id));
      txRows.forEach((r) => { if (r.id != null) txSt.delete(r.id); });
      auditInTx(t, {
        entity: 'roll', action: 'delete', entityId: String(rollNo),
        details: `حذف الرول ${rollNo} بكل بكره (${reels.length}) وحركات إنتاجه (${txRows.length})`,
        actor: actor || null,
      });
    };
    return true;
  });
}

export async function editReel(
  reel: Reel, patch: { reelNo: number; size: number; weight: number; gram: number; quality: string },
  actor?: string,
): Promise<void> {
  if (reel.status === 'dispatched' || reel.status === 'returned') {
    throw new Error('لا يمكن تعديل بكرة مصروفة — تعديلها يفسد بيانات الصرف. عدّل إذن الصرف أولًا.');
  }
  const affectsStock = reel.source === 'reels';
  const newRollReel = `${reel.rollNo}|${patch.reelNo}`;
  await db.atomic(['reels', 'transactions', 'products', 'audit'], (t, fail) => {
    const reelsSt = t.objectStore('reels');
    const dupReq = reelsSt.index('rollReel').get(newRollReel);
    dupReq.onsuccess = () => {
      const dup = dupReq.result as Reel | undefined;
      if (dup && dup.id !== reel.id) {
        fail(new Error(`رقم البكرة ${patch.reelNo} مكرر داخل الرول ${reel.rollNo}`));
        t.abort();
        return;
      }
      const now = new Date().toISOString();
      const updated: Reel = {
        ...reel,
        reelNo: patch.reelNo, size: patch.size, weight: round6(patch.weight),
        gram: patch.gram, quality: cleanStr(patch.quality),
        rollReel: newRollReel, updatedAt: now,
      };
      reelsSt.put(updated as unknown as Record<string, unknown>);
      if (affectsStock) {
        const txSt = t.objectStore('transactions');
        const req = txSt.index('reelId').get(reel.id);
        req.onsuccess = () => {
          const mv = req.result as Transaction | undefined;
          if (mv) {
            mv.size = patch.size; mv.gsm = patch.gram; mv.weight = round6(patch.weight);
            mv.quality = cleanStr(patch.quality);
            mv.fingerprint = `reel||${reel.rollNo}||${patch.reelNo}||${reel.id}`;
            mv.updatedAt = now;
            ensureProductInTx(t, mv.quality, mv.gsm, mv.size, 'reels');
            txSt.put(mv as unknown as Record<string, unknown>);
          }
        };
      }
      auditInTx(t, {
        entity: 'reel', action: 'edit', entityId: reel.id,
        details: `تعديل بكرة ${reel.rollNo}/${reel.reelNo} → ${patch.reelNo} (مقاس ${patch.size} — ${round6(patch.weight)} كجم — ${patch.gram} جرام — ${cleanStr(patch.quality)})${affectsStock ? '' : ' — لا يؤثر على الرصيد (بكرة مستوردة)'}`,
        actor: actor || null,
      });
    };
    return true;
  });
}

export async function deleteReel(reel: Reel, actor?: string): Promise<void> {
  if (reel.status === 'dispatched' || reel.status === 'returned') {
    throw new Error('لا يمكن حذف بكرة مصروفة أو مرجعة — عدّل إذن الصرف أولًا.');
  }
  const affectsStock = reel.source === 'reels';
  await db.atomic(['reels', 'transactions', 'audit'], (t) => {
    t.objectStore('reels').delete(reel.id);
    if (affectsStock) {
      const txSt = t.objectStore('transactions');
      const req = txSt.index('reelId').get(reel.id);
      req.onsuccess = () => {
        const mv = req.result as Transaction | undefined;
        if (mv && mv.id != null) txSt.delete(mv.id);
      };
    }
    auditInTx(t, {
      entity: 'reel', action: 'delete', entityId: reel.id,
      details: `حذف بكرة ${reel.rollNo}/${reel.reelNo}${affectsStock ? ' وحركة إنتاجها' : ' (تفاصيل مستوردة فقط)'}`,
      actor: actor || null,
    });
    return true;
  });
}

/* ------------------------------ permits ------------------------------ */

export function validatePermit(p: Partial<Permit>): string[] {
  const errors: string[] = [];
  if (!cleanStr(p.permitNo)) errors.push('رقم الإذن مطلوب');
  if (p.cls !== 'ض' && p.cls !== 'غ') errors.push('التصنيف مطلوب (ضريبي / غير ضريبي)');
  if (!cleanStr(p.customer)) errors.push('اسم العميل أو الجهة مطلوب');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanStr(p.date))) errors.push('التاريخ مطلوب وصيغته YYYY-MM-DD');
  const lines = p.lines || [];
  if (lines.length === 0) errors.push('أضف سطر صرف واحد على الأقل');
  const seen = new Set<string>();
  lines.forEach((l, i) => {
    const n = i + 1;
    if (!cleanStr(l.quality)) errors.push(`سطر ${n}: اسم الصنف مطلوب`);
    if (!(Number(l.gsm) > 0)) errors.push(`سطر ${n}: الجرام مطلوب`);
    if (!(Number(l.size) > 0)) errors.push(`سطر ${n}: المقاس مطلوب`);
    if (!(Number(l.qty) > 0)) errors.push(`سطر ${n}: العدد يجب أن يكون أكبر من صفر`);
    if (l.reelIds && l.reelIds.length > 0 && l.reelIds.length !== Number(l.qty)) {
      errors.push(`سطر ${n}: عدد البكر المحددة (${l.reelIds.length}) لا يطابق العدد (${l.qty})`);
    }
    const k = comboKey(l.quality, l.gsm, l.size);
    if (seen.has(k)) errors.push(`نفس المجموعة (الصنف/الجرام/المقاس ${l.size}) مكررة — اجمع العدد في سطر واحد`);
    seen.add(k);
  });
  return errors;
}

async function assertDocNoFree(cls: string, permitNo: string, excludePermitId?: string): Promise<void> {
  const key = `${cls}|${permitNo}`;
  const permits = await repo.permits();
  const clash = permits.find((p) => p.permitKey === key && p.id !== excludePermitId);
  if (clash) throw new Error(`رقم الإذن "${permitNo}" مستخدم مسبقًا في ${CLS_LABEL[cls]} — اختر رقمًا آخر`);
  const txRows = await repo.transactions();
  const txClash = txRows.some((r) => r.outQty > 0 && !r.void && r.settlement === cls
    && String(r.permitNo) === String(permitNo)
    && (excludePermitId ? r.groupId !== PERMIT_GROUP_PREFIX + excludePermitId : true));
  if (txClash) throw new Error(`رقم الإذن "${permitNo}" مستخدم مسبقًا في حركات مسجلة — اختر رقمًا آخر`);
}

export async function savePermitDraft(
  p: Omit<Permit, 'id' | 'status' | 'createdAt' | 'permitKey'>,
  actor?: string,
): Promise<string> {
  const errors = validatePermit(p);
  if (errors.length) throw new Error(errors[0]);
  await assertDocNoFree(p.cls as string, p.permitNo);
  const id = uuid();
  const permit: Permit = {
    ...(p as Permit), id, status: 'draft', source: 'permit',
    createdAt: new Date().toISOString(),
    permitKey: `${p.cls}|${p.permitNo}`,
  };
  await db.atomic(['permits', 'audit'], (t) => {
    t.objectStore('permits').add(permit as unknown as Record<string, unknown>);
    auditInTx(t, {
      entity: 'permit', action: 'add', entityId: id,
      details: `حفظ مسودة إذن ${p.permitNo} (${CLS_LABEL[p.cls]}) — ${p.customer} — ${round6(p.lines.reduce((s, l) => s + (Number(l.qty) || 0), 0))} بكرة`,
      actor: actor || null,
    });
    return id;
  });
  return id;
}

export async function updatePermitDraft(p: Permit, actor?: string): Promise<void> {
  const errors = validatePermit(p);
  if (errors.length) throw new Error(errors[0]);
  const old = await db.get<Permit>('permits', p.id);
  if (!old) throw new Error('الإذن غير موجود');
  if (old.status === 'approved') throw new Error('هذا الإذن معتمد — استخدم تعديل إذن معتمد (إعادة الاعتماد)');
  await assertDocNoFree(p.cls as string, p.permitNo, p.id);
  const updated: Permit = { ...p, permitKey: `${p.cls}|${p.permitNo}`, updatedAt: new Date().toISOString() };
  await db.atomic(['permits', 'audit'], (t) => {
    t.objectStore('permits').put(updated as unknown as Record<string, unknown>);
    auditInTx(t, {
      entity: 'permit', action: 'edit', entityId: p.id,
      details: `تعديل مسودة إذن ${p.permitNo} (${CLS_LABEL[p.cls]})`,
      actor: actor || null,
    });
    return true;
  });
}

/** The approval core — fully synchronous inside one atomic tx. */
function approveCoreSync(t: IDBTransaction, permit: Permit, fail: (e?: Error) => void, actor?: string): void {
  const now = new Date().toISOString();
  const permitsSt = t.objectStore('permits');
  const txSt = t.objectStore('transactions');
  const reelsSt = t.objectStore('reels');
  const settingsSt = t.objectStore('settings');
  const auditSt = t.objectStore('audit');

  /* queue ALL reads first (in order), then decide + write in the LAST
     onsuccess so every earlier read is guaranteed complete */
  const reqTx = txSt.getAll();
  const reqReels = reelsSt.getAll();
  const reqPermits = permitsSt.getAll();
  const reqUsed = settingsSt.get('usedDocNos');
  const reqSeq = settingsSt.get(SEQ_KEYS[permit.cls]);

  reqSeq.onsuccess = () => {
    const allReels = (reqReels.result || []) as Reel[];
    const txCache = (reqTx.result || []) as Transaction[];
    const allPermits = (reqPermits.result || []) as Permit[];
    const used = new Set<string>(((reqUsed.result as { value?: string[] } | undefined)?.value) || []);
    const curSeq = ((reqSeq.result as { value?: number } | undefined)?.value) || 1;

    /* duplicate doc-no gate against current DB state (inside the tx) */
    const key = `${permit.cls}|${permit.permitNo}`;
    if (allPermits.some((p) => p.permitKey === key && p.id !== permit.id && p.status === 'approved')) {
      fail(new Error(`رقم الإذن "${permit.permitNo}" معتمد مسبقًا في ${CLS_LABEL[permit.cls]} — اختر رقمًا آخر`));
      t.abort();
      return;
    }
    if (used.has(key) && !allPermits.some((p) => p.id === permit.id && p.status === 'approved')) {
      fail(new Error(`رقم الإذن "${permit.permitNo}" معتمد مسبقًا في ${CLS_LABEL[permit.cls]} — اختر رقمًا آخر`));
      t.abort();
      return;
    }
    const txClash = txCache.some((r) => r.outQty > 0 && !r.void && r.settlement === permit.cls
      && String(r.permitNo) === String(permit.permitNo)
      && r.groupId !== PERMIT_GROUP_PREFIX + permit.id);
    if (txClash) {
      fail(new Error(`رقم الإذن "${permit.permitNo}" مستخدم مسبقًا في حركات مسجلة — اختر رقمًا آخر`));
      t.abort();
      return;
    }

    /* reel gates — منع صرف بكرة مرتين */
    const selectedSet = new Set<string>();
    for (const l of permit.lines) (l.reelIds || []).forEach((r) => selectedSet.add(r));
    const selectedReels: Reel[] = [];
    for (const rid of selectedSet) {
      const reel = allReels.find((r) => r.id === rid);
      if (!reel) {
        fail(new Error('البكرة المحددة غير موجودة — أعد تحديد البكر'));
        t.abort();
        return;
      }
      if (reel.status === 'dispatched') {
        const same = reel.permitRef && reel.permitRef.permitId === permit.id;
        if (!same) {
          fail(new Error(`البكرة ${reel.rollNo}/${reel.reelNo} مصروفة بالفعل — لا يمكن صرفها مرتين`));
          t.abort();
          return;
        }
      } else if (reel.status === 'returned') {
        fail(new Error(`البكرة ${reel.rollNo}/${reel.reelNo} مرجعة للمورد — لا يمكن صرفها. ألغِ المرتجع أولًا`));
        t.abort();
        return;
      } else if (reel.status !== 'available' && !(reel.permitRef && reel.permitRef.permitId === permit.id)) {
        fail(new Error(`البكرة ${reel.rollNo}/${reel.reelNo} حالتها «غير محددة» (بكرة تاريخية مستوردة) — لا يمكن تتبع صرفها`));
        t.abort();
        return;
      }
      selectedReels.push(reel);
    }

    /* build movement rows (one per permit line) */
    const rows: Transaction[] = permit.lines.map((l) => {
      const lineReels = selectedReels.filter((r) => (l.reelIds || []).includes(r.id));
      const weight = lineReels.length > 0
        ? round6(lineReels.reduce((s, r) => s + (Number(r.weight) || 0), 0))
        : (l.weight && l.weight > 0 ? round6(Number(l.weight)) : null);
      return {
        date: permit.date, quality: cleanStr(l.quality), gsm: Number(l.gsm), size: Number(l.size),
        customer: permit.customer, permitNo: permit.permitNo,
        addQty: 0, outQty: Number(l.qty) || 0,
        weight, settlement: permit.cls, notes: permit.notes || '',
        groupId: PERMIT_GROUP_PREFIX + permit.id, permitId: permit.id, source: 'permit',
        fingerprint: `permit|${permit.id}|${l.quality}|${l.gsm}|${l.size}`,
        createdAt: now, updatedAt: null,
      };
    });

    /* 3-dim availability gate (excluding the permit's own old rows) */
    const ownKey = PERMIT_GROUP_PREFIX + permit.id;
    const bal = computeBalances(txCache.filter((r) => r.groupId !== ownKey));
    for (const r of rows) {
      const b = bal.get(comboKeyOf(r));
      const free = round6(b ? b.net : 0);
      const need = Number(r.outQty) || 0;
      if (free < need) {
        fail(new Error(`الرصيد لا يكفي: ${r.quality} / ${r.gsm} جرام / مقاس ${r.size} — المتاح ${round6(free)} والمطلوب ${round6(need)}`));
        t.abort();
        return;
      }
    }

    /* writes: rows + product top-up */
    for (const r of rows) {
      ensureProductInTx(t, r.quality, r.gsm, r.size, 'permit');
      txSt.add(r as unknown as Record<string, unknown>);
    }

    /* reels: free released ones, dispatch selected */
    const keepRef = { permitId: permit.id, permitNo: permit.permitNo, cls: permit.cls, customer: permit.customer, date: permit.date };
    for (const r of allReels) {
      const isMine = r.permitRef && r.permitRef.permitId === permit.id;
      if (isMine && !selectedSet.has(r.id)) {
        r.status = 'available'; r.permitRef = null; r.updatedAt = now;
        reelsSt.put(r as unknown as Record<string, unknown>);
      }
    }
    for (const reel of selectedReels) {
      reel.status = 'dispatched';
      reel.permitRef = keepRef;
      reel.updatedAt = now;
      reelsSt.put(reel as unknown as Record<string, unknown>);
    }

    /* sequences + used-numbers memory */
    if (/^\d+$/.test(String(permit.permitNo))) {
      const n = Number(permit.permitNo);
      if (n >= curSeq) settingsSt.put({ key: SEQ_KEYS[permit.cls], value: n + 1 });
      used.add(key);
      settingsSt.put({ key: 'usedDocNos', value: Array.from(used).slice(-5000) });
    }

    const approved: Permit = {
      ...permit,
      status: 'approved',
      groupId: ownKey,
      approvedAt: now,
      totals: {
        rolls: round6(rows.reduce((s, r) => s + (Number(r.outQty) || 0), 0)),
        weightKg: round6(rows.reduce((s, r) => s + (Number(r.weight) || 0), 0)),
        weightEstimated: rows.every((r) => r.weight == null),
      },
    };
    permitsSt.put(approved as unknown as Record<string, unknown>);
    auditSt.add({
      at: now, sid: uuid(), entity: 'permit', action: 'approve', entityId: permit.id,
      details: `اعتماد إذن صرف ${permit.permitNo} (${CLS_LABEL[permit.cls]}) — ${permit.customer} — ${approved.totals?.rolls} بكرة`,
      actor: actor || null,
    } as unknown as Record<string, unknown>);
  };
}

export async function approvePermit(permitId: string, actor?: string): Promise<Permit> {
  const permit = await db.get<Permit>('permits', permitId);
  if (!permit) throw new Error('الإذن غير موجود');
  if (permit.status === 'approved') throw new Error('الإذن معتمد بالفعل');
  await assertDocNoFree(permit.cls as string, permit.permitNo, permit.id);
  const used = (await db.getSetting<string[]>('usedDocNos', [])) || [];
  if (used.includes(`${permit.cls}|${permit.permitNo}`)) {
    throw new Error(`رقم الإذن "${permit.permitNo}" معتمد مسبقًا في ${CLS_LABEL[permit.cls]} — اختر رقمًا آخر`);
  }
  /* db.atomic resolves only after the transaction commits; if a gate fails
     the tx aborts and atomic rejects with the fail error. The approved
     permit is then read back from the DB. */
  await db.atomic(
    ['permits', 'transactions', 'products', 'reels', 'audit', 'settings'],
    (t, fail) => { approveCoreSync(t, permit, fail, actor); return undefined; },
  );
  const approved = await db.get<Permit>('permits', permitId);
  if (!approved || approved.status !== 'approved') throw new Error('فشل اعتماد الإذن');
  return approved;
}

export async function replacePermit(p: Permit, actor?: string): Promise<Permit> {
  const errors = validatePermit(p);
  if (errors.length) throw new Error(errors[0]);
  const old = await db.get<Permit>('permits', p.id);
  if (!old) throw new Error('الإذن غير موجود');
  if (old.permitNo !== p.permitNo || old.cls !== p.cls) {
    await assertDocNoFree(p.cls as string, p.permitNo, p.id);
    const used = (await db.getSetting<string[]>('usedDocNos', [])) || [];
    if (used.includes(`${p.cls}|${p.permitNo}`)) {
      throw new Error(`رقم الإذن "${p.permitNo}" معتمد مسبقًا في ${CLS_LABEL[p.cls]} — اختر رقمًا آخر`);
    }
  }
  const txRows = (await repo.transactions()).filter((r) => r.groupId === PERMIT_GROUP_PREFIX + p.id);
  const draft: Permit = {
    ...p, status: 'draft', groupId: null, approvedAt: null, totals: null,
    permitKey: `${p.cls}|${p.permitNo}`,
  };
  await db.atomic(
    ['permits', 'transactions', 'products', 'reels', 'audit', 'settings'],
    (t, fail) => {
      const txSt = t.objectStore('transactions');
      txRows.forEach((r) => { if (r.id != null) txSt.delete(r.id); });
      t.objectStore('permits').put(draft as unknown as Record<string, unknown>);
      // re-run approval core over the fresh DB state (old rows deleted inside this tx)
      const reqTx = t.objectStore('transactions').getAll();
      reqTx.onsuccess = () => {
        approveCoreSyncWithCache(t, draft, fail, (reqTx.result || []) as Transaction[], actor);
      };
      return undefined;
    },
  );
  const approved = await db.get<Permit>('permits', p.id);
  if (!approved || approved.status !== 'approved') throw new Error('فشل حفظ التعديل وإعادة الاعتماد');
  return approved;
}

function approveCoreSyncWithCache(t: IDBTransaction, permit: Permit, fail: (e?: Error) => void, txCache: Transaction[], actor?: string): void {
  /* variant of approveCoreSync that reuses a tx-internal transactions snapshot */
  const now = new Date().toISOString();
  const permitsSt = t.objectStore('permits');
  const txSt = t.objectStore('transactions');
  const reelsSt = t.objectStore('reels');
  const settingsSt = t.objectStore('settings');
  const auditSt = t.objectStore('audit');
  const reqReels = reelsSt.getAll();
  const reqUsed = settingsSt.get('usedDocNos');
  const reqSeq = settingsSt.get(SEQ_KEYS[permit.cls]);
  reqSeq.onsuccess = () => {
    const allReels = (reqReels.result || []) as Reel[];
    const used = new Set<string>(((reqUsed.result as { value?: string[] } | undefined)?.value) || []);
    const curSeq = ((reqSeq.result as { value?: number } | undefined)?.value) || 1;
    const selectedSet = new Set<string>();
    for (const l of permit.lines) (l.reelIds || []).forEach((r) => selectedSet.add(r));
    const selectedReels: Reel[] = [];
    for (const rid of selectedSet) {
      const reel = allReels.find((r) => r.id === rid);
      if (!reel) { fail(new Error('البكرة المحددة غير موجودة — أعد تحديد البكر')); t.abort(); return; }
      if (reel.status === 'dispatched' && !(reel.permitRef && reel.permitRef.permitId === permit.id)) {
        fail(new Error(`البكرة ${reel.rollNo}/${reel.reelNo} مصروفة بالفعل — لا يمكن صرفها مرتين`)); t.abort(); return;
      }
      if (reel.status === 'returned') {
        fail(new Error(`البكرة ${reel.rollNo}/${reel.reelNo} مرجعة للمورد — لا يمكن صرفها`)); t.abort(); return;
      }
      if (reel.status !== 'available' && reel.status !== 'dispatched'
        && !(reel.permitRef && reel.permitRef.permitId === permit.id)) {
        fail(new Error(`البكرة ${reel.rollNo}/${reel.reelNo} حالتها «غير محددة» — لا يمكن تتبع صرفها`)); t.abort(); return;
      }
      selectedReels.push(reel);
    }
    const rows: Transaction[] = permit.lines.map((l) => {
      const lineReels = selectedReels.filter((r) => (l.reelIds || []).includes(r.id));
      const weight = lineReels.length > 0
        ? round6(lineReels.reduce((s, r) => s + (Number(r.weight) || 0), 0))
        : (l.weight && l.weight > 0 ? round6(Number(l.weight)) : null);
      return {
        date: permit.date, quality: cleanStr(l.quality), gsm: Number(l.gsm), size: Number(l.size),
        customer: permit.customer, permitNo: permit.permitNo,
        addQty: 0, outQty: Number(l.qty) || 0,
        weight, settlement: permit.cls, notes: permit.notes || '',
        groupId: PERMIT_GROUP_PREFIX + permit.id, permitId: permit.id, source: 'permit',
        fingerprint: `permit|${permit.id}|${l.quality}|${l.gsm}|${l.size}`,
        createdAt: now, updatedAt: null,
      };
    });
    const bal = computeBalances(txCache.filter((r) => r.groupId !== PERMIT_GROUP_PREFIX + permit.id));
    for (const r of rows) {
      const b = bal.get(comboKeyOf(r));
      const free = round6(b ? b.net : 0);
      const need = Number(r.outQty) || 0;
      if (free < need) {
        fail(new Error(`الرصيد لا يكفي: ${r.quality} / ${r.gsm} جرام / مقاس ${r.size} — المتاح ${free} والمطلوب ${need}`));
        t.abort();
        return;
      }
    }
    for (const r of rows) {
      ensureProductInTx(t, r.quality, r.gsm, r.size, 'permit');
      txSt.add(r as unknown as Record<string, unknown>);
    }
    const keepRef = { permitId: permit.id, permitNo: permit.permitNo, cls: permit.cls, customer: permit.customer, date: permit.date };
    for (const r of allReels) {
      const isMine = r.permitRef && r.permitRef.permitId === permit.id;
      if (isMine && !selectedSet.has(r.id)) {
        r.status = 'available'; r.permitRef = null; r.updatedAt = now;
        reelsSt.put(r as unknown as Record<string, unknown>);
      }
    }
    for (const reel of selectedReels) {
      reel.status = 'dispatched';
      reel.permitRef = keepRef;
      reel.updatedAt = now;
      reelsSt.put(reel as unknown as Record<string, unknown>);
    }
    if (/^\d+$/.test(String(permit.permitNo))) {
      const n = Number(permit.permitNo);
      if (n >= curSeq) settingsSt.put({ key: SEQ_KEYS[permit.cls], value: n + 1 });
      used.add(`${permit.cls}|${permit.permitNo}`);
      settingsSt.put({ key: 'usedDocNos', value: Array.from(used).slice(-5000) });
    }
    const approved: Permit = {
      ...permit, status: 'approved',
      groupId: PERMIT_GROUP_PREFIX + permit.id, approvedAt: now,
      totals: {
        rolls: round6(rows.reduce((s, r) => s + (Number(r.outQty) || 0), 0)),
        weightKg: round6(rows.reduce((s, r) => s + (Number(r.weight) || 0), 0)),
        weightEstimated: rows.every((r) => r.weight == null),
      },
    };
    permitsSt.put(approved as unknown as Record<string, unknown>);
    auditSt.add({
      at: now, sid: uuid(), entity: 'permit', action: 'approve', entityId: permit.id,
      details: `تعديل إذن معتمد وإعادة اعتماد: ${permit.permitNo} (${CLS_LABEL[permit.cls]}) — ${permit.customer} — ${approved.totals?.rolls} بكرة`,
      actor: actor || null,
    } as unknown as Record<string, unknown>);
  };
}

export async function deletePermit(permitId: string, actor?: string): Promise<void> {
  const permit = await db.get<Permit>('permits', permitId);
  if (!permit) throw new Error('الإذن غير موجود');
  const txRows = (await repo.transactions()).filter((r) => r.groupId === PERMIT_GROUP_PREFIX + permitId);
  const reels = await repo.reels();
  const mine = reels.filter((r) => r.permitRef && r.permitRef.permitId === permitId);
  const wasDraft = permit.status === 'draft';
  await db.atomic(['permits', 'transactions', 'reels', 'audit'], (t) => {
    const now = new Date().toISOString();
    txRows.forEach((r) => { if (r.id != null) t.objectStore('transactions').delete(r.id); });
    mine.forEach((r) => {
      r.status = 'available'; r.permitRef = null; r.updatedAt = now;
      t.objectStore('reels').put(r as unknown as Record<string, unknown>);
    });
    t.objectStore('permits').delete(permitId);
    auditInTx(t, {
      entity: 'permit', action: 'delete', entityId: permitId,
      details: wasDraft
        ? `حذف مسودة إذن ${permit.permitNo} — لم يكن له أثر على الرصيد`
        : `حذف إذن صرف ${permit.permitNo} (${permit.customer}) — عودة الكميات والبكر للرصيد`,
      actor: actor || null,
    });
    return true;
  });
}

export async function importRolls(
  rolls: { rollNo: number; gram: number | null; date: string; notes: string; reels: { reelNo: number; size: number | null; weight: number | null; gram: number | null; quality: string | null }[] }[],
  actor?: string,
): Promise<{ rolls: number; reels: number; skipped: number }> {
  const errors: string[] = [];
  const seenRoll = new Set<number>();
  const seenReel = new Set<string>();
  for (const r of rolls) {
    if (!(Number(r.rollNo) > 0)) errors.push(`رقم رول غير صالح: ${r.rollNo}`);
    if (seenRoll.has(Number(r.rollNo))) errors.push(`رول مكرر داخل الملف: ${r.rollNo}`);
    seenRoll.add(Number(r.rollNo));
    for (const rl of r.reels) {
      const k = `${r.rollNo}|${rl.reelNo}`;
      if (seenReel.has(k)) errors.push(`بكرة مكررة داخل الملف: ${k}`);
      seenReel.add(k);
    }
  }
  if (errors.length) throw new Error(errors.slice(0, 5).join(' — '));
  const existingRolls = await repo.rolls();
  const existingReels = await repo.reels();
  const haveRoll = new Set(existingRolls.map((r) => Number(r.rollNo)));
  const haveReel = new Set(existingReels.map((r) => r.rollReel));
  let skipped = 0;
  const newRolls: Roll[] = [];
  const newReels: Reel[] = [];
  const now = new Date().toISOString();
  let maxNo = 0;
  for (const r of existingRolls) if (Number(r.rollNo) > maxNo) maxNo = Number(r.rollNo);
  for (const r of rolls) {
    if (haveRoll.has(Number(r.rollNo))) { skipped++; continue; }
    newRolls.push({
      rollNo: Number(r.rollNo), gram: r.gram ?? null, date: r.date || '', notes: r.notes || '',
      source: 'excel', createdAt: now, updatedAt: null,
    });
    for (const rl of r.reels) {
      const k = `${r.rollNo}|${rl.reelNo}`;
      if (haveReel.has(k)) continue;
      newReels.push({
        id: uuid(), rollNo: Number(r.rollNo), reelNo: Number(rl.reelNo) || 0,
        size: rl.size ?? null, weight: rl.weight ?? null, gram: rl.gram ?? null,
        quality: rl.quality ?? null, status: 'undefined', permitRef: null,
        source: 'excel', rollReel: k, createdAt: now, updatedAt: null,
      });
    }
    if (Number(r.rollNo) > maxNo) maxNo = Number(r.rollNo);
  }
  await db.bulkPut('rolls', newRolls as unknown as Record<string, unknown>[]);
  await db.bulkPut('reels', newReels as unknown as Record<string, unknown>[]);
  if (maxNo > 0) {
    const seq = (await db.getSetting<number | null>('rollSeq', null)) || 0;
    if (maxNo + 1 > seq) await db.setSetting('rollSeq', maxNo + 1);
  }
  await db.logAudit({
    entity: 'roll', action: 'import-warehouse', entityId: 'rolls',
    details: `استيراد تفاصيل الرولات: ${newRolls.length} رول و ${newReels.length} بكرة بحالة «غير محددة» — لا تدخل الرصيد (تخطي ${skipped})`,
    actor: actor || null,
  });
  return { rolls: newRolls.length, reels: newReels.length, skipped };
}

/* -------- one-time customers seeding from movement history -------- */

export async function seedCustomersIfNeeded(): Promise<void> {
  const flag = await db.getSetting<boolean>('customersSeeded', false);
  if (flag) return;
  const txRows = await repo.transactions();
  const names = new Set<string>();
  for (const r of txRows) {
    const c = canonicalCustomer(r.customer);
    if (!c || c === 'الإنتاج' || c === 'رصيد اول المدة') continue;
    names.add(c);
    if (names.size >= 2000) break;
  }
  const existing = await repo.customers();
  const have = new Set(existing.map((c) => c.name));
  const toAdd: { name: string; notes: string; source: string; createdAt: string }[] = [];
  names.forEach((n) => {
    if (!have.has(n)) toAdd.push({ name: n, notes: '', source: 'history', createdAt: new Date().toISOString() });
  });
  if (toAdd.length) await db.bulkPut('customers', toAdd as unknown as Record<string, unknown>[]);
  await db.setSetting('customersSeeded', true);
}

/* -------- one-time migration: legacy weight unit (tons → kg) -------- */

export async function migrateWeightsIfNeeded(): Promise<void> {
  const flag = await db.getSetting<boolean>('weightUnitMigrated', false);
  if (flag) return;
  const txRows = await repo.transactions();
  const toFix = txRows.filter((r) => r.source === 'excel' && r.weight != null
    && r.weight > 0 && r.weight < 100 && (r as Transaction & { weightUnit?: string }).weightUnit !== 'kg');
  if (toFix.length) {
    for (const r of toFix) {
      const rec = r as Transaction & { weightWasTons?: number; weightUnit?: string };
      rec.weightWasTons = rec.weight ?? 0;
      rec.weight = round6((rec.weight ?? 0) * 1000);
      rec.weightUnit = 'kg';
      if (r.id != null) await db.put('transactions', r);
    }
    await db.logAudit({
      entity: 'database', action: 'migrate-weights', entityId: 'transactions',
      details: `تصحيح وحدة الوزن للأطنان → كجم (${toFix.length} سطر مستورد) — لا أثر على أرصدة الكميات`,
      actor: null,
    });
  }
  await db.setSetting('weightUnitMigrated', true);
}

/* -------- one-time migration: reservations localStorage → IndexedDB -------- */

export async function migrateReservationsIfNeeded(): Promise<void> {
  const flag = await db.getSetting<boolean>('reservationsMigrated', false);
  if (flag) return;
  const read = (k: string): Record<string, unknown>[] => {
    try {
      const raw = localStorage.getItem(k);
      if (!raw) return [];
      const v = JSON.parse(raw);
      return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
    } catch { return []; }
  };
  const existing = await db.count('reservations');
  if (existing === 0) {
    const pairs: [string, string][] = [
      ['agrima_customer_reservations', 'reservations'],
      ['agrima_reservation_transfers', 'resvTransfers'],
      ['agrima_reservation_cancellations', 'resvCancellations'],
      ['agrima_reservation_delivery_links', 'resvLinks'],
      ['agrima_reservation_audit_log', 'resvAudit'],
    ];
    for (const [lsKey, store] of pairs) {
      const rows = read(lsKey);
      if (rows.length) await db.bulkPut(store, rows);
    }
  }
  await db.setSetting('reservationsMigrated', true);
}
