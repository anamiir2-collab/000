/* =========================================================================
   excel.ts — Excel import/export (SheetJS loaded locally from /vendor —
   no CDN, no Supabase, fully offline).
   ========================================================================= */

import { db, repo } from './db';
import { cleanStr, toNumberOrRaw, round6 } from './calc';
import { productFamily, downloadBlob, fileFingerprint, stamp } from './utils';
import { txFingerprint } from './tx';
import type { Product, Transaction } from './types';

declare global {
  interface Window { XLSX?: unknown }
}

type Cell = string | number | boolean | null | undefined;
type Row = Cell[];

interface XlsxLib {
  read: (data: ArrayBuffer) => { SheetNames: string[]; Sheets: Record<string, unknown> };
  write: (wb: unknown, opts: unknown) => ArrayBuffer;
  utils: {
    sheet_to_json: (sheet: unknown, opts?: unknown) => unknown[][];
    aoa_to_sheet: (aoa: unknown[][]) => unknown;
    book_append_sheet: (wb: unknown, ws: unknown, name: string) => void;
  };
}

function X(): XlsxLib {
  const x = (typeof window !== 'undefined' ? window.XLSX : null) as unknown as XlsxLib | null;
  if (!x) throw new Error('مكتبة Excel غير محمّلة — أعد تحميل الصفحة');
  return x;
}

function norm(s: unknown): string {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(/[\u064B-\u0652]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

function txWeightToKg(v: number): number {
  return Math.round(v * 1000 * 1000) / 1000; // tons → kg, 3dp
}

function excelDateToStr(v: unknown): string {
  if (v == null || v === '') return '';
  if (v instanceof Date) {
    const d = v;
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  if (typeof v === 'number' && v > 0) {
    const ms = Math.round((v - 25569) * 86400000);
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return s;
}

const SYN_TX: Record<string, string[]> = {
  date: ['p', 'date (p)', 'date', 'التاريخ', 'تاريخ'],
  weight: ['الوزن', 'وزن'],
  permitNo: ['رقم اذن الصرف', 'رقم إذن الصرف', 'رقم اذن', 'اذن الصرف', 'إذن الصرف'],
  quality: ['اسم الصنف', 'الصنف', 'quality'],
  customer: ['اسم العميل', 'العميل', 'customer'],
  gsm: ['الجرام', 'جرام', 'gsm'],
  size: ['المقاس', 'مقاس', 'size'],
  addQty: ['اضافه', 'إضافة', 'اضافة'],
  outQty: ['صرف', 'منصرف', 'الصرف'],
  settlement: ['تصفيه', 'تصفية'],
};

const SYN_PROD: Record<string, string[]> = {
  quality: ['quality', 'اسم الصنف', 'الصنف'],
  gsm: ['gsm', 'الجرام', 'جرام'],
  size: ['size', 'المقاس', 'مقاس'],
  balance: ['رصيد المخزن'],
  weight: ['الوزن'],
};

function findHeader(rows: Row[], syns: Record<string, string[]>, minMatches = 3): number {
  for (let i = 0; i < Math.min(rows.length, 26); i++) {
    const row = rows[i];
    if (!row || !Array.isArray(row)) continue;
    let matches = 0;
    const normCells = row.map((c) => norm(c));
    for (const field of Object.keys(syns)) {
      const list = syns[field].map(norm);
      if (normCells.some((c) => c && list.includes(c))) matches++;
    }
    if (matches >= minMatches) return i;
  }
  return -1;
}

function pick(row: Row, idx: Record<string, number>, field: string): Cell {
  const i = idx[field];
  return i >= 0 && i < row.length ? row[i] : null;
}

function num(v: Cell): number {
  if (v == null || v === '') return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function isVoidName(s: string): boolean {
  const n = norm(s);
  return n === 'لاغي' || n === 'لاغي'.replace('ي', 'ى') || n === 'laghy';
}

export interface ImportStats {
  sheets: string[];
  prodRows: number;
  txRows: number;
  skippedEmptyTx: number;
  voidTx: number;
  incompleteTx: number;
  balanceSheetFound: boolean;
  txSheetFound: boolean;
  newTx: number;
  dupTx: number;
  inFileDup: number;
  newProd: number;
  existingProd: number;
  warnings: string[];
  preview: Transaction[];
}

export interface ParsedWorkbook {
  products: Product[];
  transactions: Transaction[];
  stats: ImportStats;
}

export async function parseBalanceWorkbook(buf: ArrayBuffer): Promise<ParsedWorkbook> {
  const XLSX = X();
  const wb = XLSX.read(buf) as { SheetNames: string[]; Sheets: Record<string, { [k: string]: unknown }> };
  const sheetToJson = XLSX.utils.sheet_to_json as (s: unknown, o?: unknown) => Row[];
  const warnings: string[] = [];
  let balanceSheet: string | null = null;
  let txSheet: string | null = null;
  for (const name of wb.SheetNames) {
    const n = norm(name);
    if (!balanceSheet && (n.includes('الرصيد') || n.includes('رصيد') || n.includes('balance'))) balanceSheet = name;
    if (!txSheet && (n.includes('انتاج') || n.includes('مبيعات') || n.includes('production'))) txSheet = name;
  }
  const sheets = wb.SheetNames.slice();
  const products: Product[] = [];
  const transactions: Transaction[] = [];
  let skippedEmptyTx = 0, voidTx = 0, incompleteTx = 0;

  if (balanceSheet) {
    const rows = (sheetToJson(wb.Sheets[balanceSheet], { header: 1, raw: true }) ?? []) as Row[];
    const hIdx = findHeader(rows, SYN_PROD, 3);
    if (hIdx >= 0) {
      const headers = rows[hIdx];
      const idx: Record<string, number> = {};
      for (const [field, syns] of Object.entries(SYN_PROD)) {
        idx[field] = headers.findIndex((h) => syns.map(norm).includes(norm(h)));
      }
      for (let i = hIdx + 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r || !r.length) continue;
        const quality = cleanStr(pick(r, idx, 'quality'));
        const gsm = pick(r, idx, 'gsm');
        const size = pick(r, idx, 'size');
        if (!quality || toNumberOrRaw(gsm) === null || toNumberOrRaw(size) === null) continue;
        const combo = `${cleanStr(quality)}||${String(toNumberOrRaw(gsm))}||${String(toNumberOrRaw(size))}`;
        if (products.some((p) => p.combo === combo)) { warnings.push(`صنف مكرر في الملف: ${quality} / ${gsm} / ${size}`); continue; }
        products.push({
          quality: cleanStr(quality), gsm: toNumberOrRaw(gsm), size: toNumberOrRaw(size), combo,
          source: 'excel',
          refBalance: num(pick(r, idx, 'balance')) || null,
          refWeight: num(pick(r, idx, 'weight')) || null,
          createdAt: new Date().toISOString(),
        });
      }
    } else {
      warnings.push(`ورقة «${balanceSheet}»: لم يتم التعرف على رؤوس الأعمدة`);
    }
  } else {
    warnings.push('لم يتم العثور على ورقة الرصيد');
  }

  if (txSheet) {
    const rows = (sheetToJson(wb.Sheets[txSheet], { header: 1, raw: true }) ?? []) as Row[];
    const hIdx = findHeader(rows, SYN_TX, 4);
    if (hIdx >= 0) {
      const headers = rows[hIdx];
      const idx: Record<string, number> = {};
      for (const [field, syns] of Object.entries(SYN_TX)) {
        idx[field] = headers.findIndex((h) => syns.map(norm).includes(norm(h)));
      }
      for (let i = hIdx + 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r || !r.length) continue;
        const quality = cleanStr(pick(r, idx, 'quality'));
        const addQty = num(pick(r, idx, 'addQty'));
        const outQty = num(pick(r, idx, 'outQty'));
        const weightRaw = pick(r, idx, 'weight');
        const hasAny = quality || addQty || outQty || pick(r, idx, 'customer') || pick(r, idx, 'permitNo');
        if (!hasAny) { skippedEmptyTx++; continue; }
        const voidRow = isVoidName(quality);
        if (voidRow) voidTx++;
        const gsmRaw = voidRow ? null : pick(r, idx, 'gsm');
        const sizeRaw = voidRow ? null : pick(r, idx, 'size');
        if (!voidRow && (toNumberOrRaw(gsmRaw) === null || toNumberOrRaw(sizeRaw) === null)) incompleteTx++;
        const weightNum = typeof weightRaw === 'number' ? txWeightToKg(weightRaw) : null;
        const row: Partial<Transaction> = {
          date: excelDateToStr(pick(r, idx, 'date')),
          quality: voidRow ? quality : productFamily(quality),
          gsm: voidRow ? null : toNumberOrRaw(gsmRaw),
          size: voidRow ? null : toNumberOrRaw(sizeRaw),
          customer: voidRow ? '' : cleanStr(pick(r, idx, 'customer')),
          permitNo: cleanStr(pick(r, idx, 'permitNo')),
          addQty: addQty, outQty: outQty,
          weight: weightNum,
          settlement: cleanStr(pick(r, idx, 'settlement')),
          notes: '',
          source: 'excel',
          excelRow: i + 1,
          void: voidRow,
          weightUnit: weightNum != null ? 'kg' : undefined,
        };
        transactions.push({ ...row, fingerprint: txFingerprint(row as Omit<Transaction, 'fingerprint'>) } as Transaction);
      }
    } else {
      warnings.push(`ورقة «${txSheet}»: لم يتم التعرف على رؤوس الأعمدة`);
    }
  } else {
    warnings.push('لم يتم العثور على ورقة الحركات (انتاج و مبيعات)');
  }

  /* product discovery from tx sheet */
  const have = new Set(products.map((p) => p.combo));
  const seen = new Set<string>();
  for (const t of transactions) {
    if (t.void) continue;
    const q = cleanStr(t.quality); const g = toNumberOrRaw(t.gsm); const s = toNumberOrRaw(t.size);
    if (!q || g === null || s === null) continue;
    const combo = `${q}||${String(g)}||${String(s)}`;
    if (have.has(combo) || seen.has(combo)) continue;
    seen.add(combo);
    products.push({ quality: q, gsm: g, size: s, combo, source: 'discovered', createdAt: new Date().toISOString() });
  }

  return {
    products, transactions,
    stats: {
      sheets, prodRows: products.length, txRows: transactions.length,
      skippedEmptyTx, voidTx, incompleteTx,
      balanceSheetFound: !!balanceSheet, txSheetFound: !!txSheet,
      newTx: 0, dupTx: 0, inFileDup: 0, newProd: 0, existingProd: 0,
      warnings, preview: transactions.slice(0, 5),
    },
  };
}

export interface WarehouseRoll {
  rollNo: number; gram: number | null; date: string; notes: string;
  reels: { reelNo: number; size: number | null; weight: number | null; gram: number | null; quality: string | null }[];
}

export async function parseWarehouseWorkbook(buf: ArrayBuffer): Promise<{ rolls: WarehouseRoll[]; stats: Record<string, unknown>; warnings: string[] }> {
  const XLSX = X();
  const wb = XLSX.read(buf) as { SheetNames: string[]; Sheets: Record<string, { [k: string]: unknown }> };
  const sheetToJson = XLSX.utils.sheet_to_json as (s: unknown, o?: unknown) => Row[];
  const warnings: string[] = [];
  const rollMap = new Map<number, WarehouseRoll>();
  let reels = 0;
  let badCodes = 0;
  let totalWeight = 0;
  let minDate = '', maxDate = '';
  let noQuality = 0;
  const codeRe = /^(\d+)\s*\/\s*(\d+)$/;
  for (const name of wb.SheetNames) {
    const rows = (sheetToJson(wb.Sheets[name], { header: 1, raw: true }) ?? []) as Row[];
    for (const r of rows) {
      if (!r || !r.length) continue;
      const code = String(r[0] ?? '').trim();
      if (!code || code === '*') continue;
      if (norm(code).includes('الكود')) continue;
      const m = code.match(codeRe);
      if (!m) { if (badCodes < 10) warnings.push(`كود غير مفهوم: ${code}`); badCodes++; continue; }
      const rollNo = Number(m[1]);
      const reelNo = Number(m[2]);
      const size = num(r[2]) || null; // طول
      const gram = num(r[3]) || null; // جرام
      const weight = typeof r[4] === 'number' ? r[4] : (num(r[4]) || null); // وزن(طن) → kg as-is
      const date = excelDateToStr(r[5]);
      const quality = productFamily(String(r[6] ?? '').trim()) || null;
      if (!quality) noQuality++;
      if (!rollMap.has(rollNo)) rollMap.set(rollNo, { rollNo, gram: null, date, notes: '', reels: [] });
      const roll = rollMap.get(rollNo)!;
      roll.reels.push({ reelNo, size, weight, gram, quality });
      if (date && (!minDate || date < minDate)) minDate = date;
      if (date && (!maxDate || date > maxDate)) maxDate = date;
      if (weight) totalWeight += weight;
      reels++;
    }
  }
  const rolls = Array.from(rollMap.values());
  return {
    rolls,
    stats: { rolls: rolls.length, reels, maxRoll: Math.max(0, ...rolls.map((r) => r.rollNo)), totalWeight: round6(totalWeight), noQuality, period: minDate && maxDate ? `${minDate} → ${maxDate}` : '' },
    warnings,
  };
}

/* ------------------------------ classification ------------------------------ */

export async function classifyImport(parsed: ParsedWorkbook): Promise<ImportStats & { products: Product[]; transactions: Transaction[] }> {
  const dbTx = await repo.transactions();
  const dbProds = await repo.products();
  const fpSet = new Set(dbTx.filter((t) => !t.void).map((t) => t.fingerprint));
  const comboSet = new Set(dbProds.map((p) => p.combo));
  const inFileFp = new Set<string>();
  let newTx = 0, dupTx = 0, inFileDup = 0, newProd = 0, existingProd = 0;
  const keepTx: Transaction[] = [];
  for (const t of parsed.transactions) {
    if (fpSet.has(t.fingerprint) || inFileFp.has(t.fingerprint)) {
      if (inFileFp.has(t.fingerprint)) inFileDup++;
      dupTx++;
      continue;
    }
    inFileFp.add(t.fingerprint);
    keepTx.push(t);
    newTx++;
  }
  const keepProd: Product[] = [];
  for (const p of parsed.products) {
    if (comboSet.has(p.combo)) { existingProd++; continue; }
    comboSet.add(p.combo);
    keepProd.push(p);
    newProd++;
  }
  return {
    ...parsed.stats, newTx, dupTx, inFileDup, newProd, existingProd,
    products: keepProd, transactions: keepTx,
  };
}

export async function commitImport(cls: { products: Product[]; transactions: Transaction[] }, mode: 'merge' | 'replace', fileName: string, fp: string, actor?: string): Promise<void> {
  if (mode === 'replace') {
    await db.wipeBalanceScope();
  }
  // strip ids: imported rows are new
  const txRows = cls.transactions.map((t) => ({ ...t, id: undefined, createdAt: new Date().toISOString() }));
  const prodRows = cls.products.map((p) => ({ ...p, id: undefined }));
  if (prodRows.length) await db.bulkPut('products', prodRows as unknown as Record<string, unknown>[]);
  if (txRows.length) await db.bulkPut('transactions', txRows as unknown as Record<string, unknown>[]);
  await db.put('importlog', { key: fp, fileName, kind: 'balance', at: new Date().toISOString(), summary: { newTx: txRows.length, newProd: prodRows.length } });
  await db.setSetting('lastImport', {
    at: new Date().toISOString(), newTx: txRows.length, dupTx: 0, inFileDup: 0,
    newProd: prodRows.length, existingProd: 0,
  });
  await db.logAudit({
    entity: 'database', action: mode === 'replace' ? 'import-replace' : 'import', entityId: 'transactions',
    details: (mode === 'replace'
      ? `استيراد مع الاستبدال (نطاق الأصناف والحركات فقط): ${fileName} — `
      : `استيراد وإضافة: ${fileName} — `) + `${txRows.length} حركة، ${prodRows.length} صنف`,
    actor: actor || null,
  });
}

export async function commitWarehouseImport(rolls: WarehouseRoll[], fileName: string, fp: string, actor?: string): Promise<{ rolls: number; reels: number; skipped: number }> {
  const { importRolls } = await import('./tx');
  const res = await importRolls(rolls, actor);
  await db.put('importlog', { key: fp, fileName, kind: 'warehouse', at: new Date().toISOString(), summary: res });
  await db.setSetting('lastWarehouseImport', { at: new Date().toISOString(), rolls: res.rolls, reels: res.reels });
  return res;
}

export async function checkFileImported(fp: string): Promise<{ at: string; fileName: string } | null> {
  const rec = await db.get<{ key: string; fileName: string; at: string }>('importlog', fp);
  return rec ? { at: rec.at, fileName: rec.fileName } : null;
}

/* ------------------------------ exports ------------------------------ */

function writeWorkbook(wb: Record<string, unknown>, fileName: string): void {
  const XLSX = X();
  wb.Props = { Application: 'نظام إدارة رصيد المخزن' };
  (wb as { Views?: unknown }).Views = [{ RTL: true }];
  const wbopts = { bookType: 'xlsx', type: 'array' } as const;
  const out = XLSX.write(wb, wbopts) as ArrayBuffer;
  downloadBlob(new Blob([out], { type: 'application/octet-stream' }), fileName);
}

function newSheet(wb: Record<string, unknown>, name: string, aoa: unknown[][], widths?: number[]): void {
  const XLSX = X();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  if (widths) (ws as Record<string, unknown>)['!cols'] = widths.map((w) => ({ wch: w }));
  (ws as { '!views'?: unknown })['!views'] = [{ RTL: true }];
  XLSX.utils.book_append_sheet(wb, ws, name);
}

function baseName(): string {
  return stamp();
}

export function exportTransactions(rows: Transaction[]): void {
  const XLSX = X();
  const wb: Record<string, unknown> = { SheetNames: [], Sheets: {} };
  const aoa: Row[] = [
    ['التاريخ', 'الوزن', 'رقم اذن الصرف', 'اسم الصنف', 'اسم العميل', 'الجرام', 'المقاس', 'اضافه', 'صرف', 'تصفيه', 'ملاحظات'],
  ];
  for (const t of rows) {
    aoa.push([
      t.date ?? '', t.weight ?? '', t.permitNo ?? '', t.quality ?? '', t.customer ?? '',
      t.gsm ?? '', t.size ?? '', t.addQty || 0, t.outQty || 0, t.settlement ?? '', t.notes ?? '',
    ]);
  }
  newSheet(wb, 'انتاج و مبيعات', aoa, [12, 9, 12, 22, 18, 8, 8, 8, 8, 8, 24]);
  writeWorkbook(wb, `انتاج_و_مبيعات_${baseName()}.xlsx`);
}

export interface InvBucket { quality: string; gsm: number | string | null; size: number | string | null; add: number; out: number; net: number; estWeight?: number }

export function exportInventoryBuckets(rows: InvBucket[], addWeightCol = false): void {
  const XLSX = X();
  const wb: Record<string, unknown> = { SheetNames: [], Sheets: {} };
  const headers: Row = addWeightCol
    ? ['الصنف', 'الجرام (GSM)', 'وزن البكرة (كجم)', 'المقاس (Size)', 'الإضافات', 'الصرف', 'رصيد المخزن (بكر)', 'الوزن التقريبي (كجم)']
    : ['الصنف', 'الجرام (GSM)', 'المقاس (Size)', 'الإضافات', 'الصرف', 'رصيد المخزن (بكر)', 'الوزن التقريبي (كجم)'];
  const aoa: Row[] = [headers];
  let sAdd = 0, sOut = 0, sNet = 0, sW = 0;
  for (const r of rows) {
    sAdd += r.add; sOut += r.out; sNet += r.net; sW += r.estWeight || 0;
    aoa.push(addWeightCol
      ? [r.quality, r.gsm ?? '', (r as InvBucket & { weight?: number }).weight ?? '', r.size ?? '', r.add, r.out, r.net, r.estWeight ?? '']
      : [r.quality, r.gsm ?? '', r.size ?? '', r.add, r.out, r.net, r.estWeight ?? '']);
  }
  aoa.push(addWeightCol
    ? ['الإجمالي', '', '', '', round6(sAdd), round6(sOut), round6(sNet), round6(sW)]
    : ['الإجمالي', '', '', round6(sAdd), round6(sOut), round6(sNet), round6(sW)]);
  newSheet(wb, 'رصيد المخزن', aoa, [22, 10, 10, 10, 10, 12, 14]);
  writeWorkbook(wb, `رصيد_المخزن_${baseName()}.xlsx`);
}

export function exportReportAOA(title: string, headers: string[], rows: Row[], totalsRow: Row | null, fileName: string): void {
  const wb: Record<string, unknown> = { SheetNames: [], Sheets: {} };
  const dateStr = new Date().toLocaleDateString('ar-EG');
  const aoa: Row[] = [[title], [dateStr], [], headers];
  rows.forEach((r) => aoa.push(r));
  if (totalsRow) aoa.push(totalsRow);
  newSheet(wb, 'تقرير', aoa);
  writeWorkbook(wb, `${fileName.replace(/\s+/g, '_')}_${baseName()}.xlsx`);
}

export function exportRollsList(rows: { roll: { rollNo: number; date: string; gram: number | null; source?: string }; reel: { reelNo: number; size: number | null; weight: number | null; gram: number | null; quality: string | null; status: string } }[]): void {
  const wb: Record<string, unknown> = { SheetNames: [], Sheets: {} };
  const aoa: Row[] = [[
    'رقم الرول', 'تاريخ الرول', 'رقم البكرة', 'المقاس', 'الوزن (كجم)', 'الجرام', 'اسم الصنف', 'الحالة', 'المصدر',
  ]];
  for (const { roll, reel } of rows) {
    aoa.push([
      roll.rollNo, roll.date, reel.reelNo, reel.size ?? '', reel.weight ?? '', reel.gram ?? '',
      reel.quality ?? '', reel.status, roll.source === 'excel' ? 'مستورد' : 'تسجيل بكر',
    ]);
  }
  newSheet(wb, 'الرولات والبكر', aoa, [10, 12, 10, 10, 12, 8, 20, 14, 10]);
  writeWorkbook(wb, `الرولات_والبكر_${baseName()}.xlsx`);
}
