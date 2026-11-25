/* =========================================================================
   calc.ts — balance engine (exact port of the original Excel SUMIFS logic)
   -------------------------------------------------------------------------
   Balance(product) = Σ(اضافه − صرف) grouped by (اسم الصنف, الجرام, المقاس)
   — with an extra roll-weight dimension for issue availability.
   Weight = Size × Balance × 7.5 (factor configurable in settings).
   No opening-balance record type: opening balances are ordinary rows.
   ========================================================================= */

import type { BalanceRow, Transaction } from './types';

export const DEFAULT_WEIGHT_FACTOR = 7.5;

export function cleanStr(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

export function toNumberOrRaw(v: unknown): number | string | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!isNaN(n) && String(v).trim() !== '') return n;
  return cleanStr(v);
}

export function comboKey(quality: unknown, gsm: unknown, size: unknown): string {
  return cleanStr(quality) + '||' + String(toNumberOrRaw(gsm)) + '||' + String(toNumberOrRaw(size));
}
export function comboKeyOf(t: Pick<Transaction, 'quality' | 'gsm' | 'size'>): string {
  return comboKey(t.quality, t.gsm, t.size);
}
export function isComboComplete(quality: unknown, gsm: unknown, size: unknown): boolean {
  return cleanStr(quality) !== '' && toNumberOrRaw(gsm) !== null && toNumberOrRaw(size) !== null;
}

export function weightKey(weight: unknown): string {
  return weight === null || weight === undefined || weight === '' ? '—' : String(Number(weight));
}
export function comboKeyW(quality: unknown, gsm: unknown, weight: unknown, size: unknown): string {
  return comboKey(quality, gsm, size) + '||W:' + weightKey(weight);
}
export function comboKeyWOf(t: { quality: unknown; gsm: unknown; weight: unknown; size: unknown }): string {
  return comboKeyW(t.quality, t.gsm, t.weight, t.size);
}
/** GROUP key WITHOUT size: one issue group holds many sizes under the same (product, gsm, roll weight). */
export function comboGroupW(quality: unknown, gsm: unknown, weight: unknown): string {
  return cleanStr(quality) + '||' + String(toNumberOrRaw(gsm)) + '||W:' + weightKey(weight);
}
export function comboGroupWOf(t: { quality: unknown; gsm: unknown; weight: unknown }): string {
  return comboGroupW(t.quality, t.gsm, t.weight);
}

export function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export function productWeight(size: unknown, balance: unknown, factor?: number): number {
  const f = Number(factor) || DEFAULT_WEIGHT_FACTOR;
  const s = Number(size);
  if (!s || isNaN(s)) return 0;
  return round6(s * (Number(balance) || 0) * f);
}

/** Excel SUMIFS reproduction grouped by (quality||gsm||size). */
export function computeBalances(transactions: Transaction[]): Map<string, BalanceRow> {
  const map = new Map<string, BalanceRow>();
  for (const t of transactions) {
    if (t.void) continue;
    const key = comboKeyOf(t);
    let row = map.get(key);
    if (!row) {
      row = {
        key, quality: cleanStr(t.quality), gsm: toNumberOrRaw(t.gsm), size: toNumberOrRaw(t.size),
        add: 0, out: 0, net: 0,
      };
      map.set(key, row);
    }
    const a = Number(t.addQty) || 0;
    const o = Number(t.outQty) || 0;
    row.add += a; row.out += o; row.net += a - o;
  }
  for (const row of map.values()) {
    row.add = round6(row.add); row.out = round6(row.out); row.net = round6(row.net);
  }
  return map;
}

/** Same logic with the roll-weight dimension (quality||gsm||size||W:weight). */
export function computeBalancesByWeight(transactions: Transaction[]): Map<string, BalanceRow> {
  const map = new Map<string, BalanceRow>();
  for (const t of transactions) {
    if (t.void) continue;
    const key = comboKeyWOf(t);
    let row = map.get(key);
    if (!row) {
      row = {
        key, quality: cleanStr(t.quality), gsm: toNumberOrRaw(t.gsm), size: toNumberOrRaw(t.size),
        weight: t.weight == null ? null : Number(t.weight),
        add: 0, out: 0, net: 0,
      };
      map.set(key, row);
    }
    const a = Number(t.addQty) || 0;
    const o = Number(t.outQty) || 0;
    row.add += a; row.out += o; row.net += a - o;
  }
  for (const row of map.values()) {
    row.add = round6(row.add); row.out = round6(row.out); row.net = round6(row.net);
  }
  return map;
}

/** Opening balance before `fromDate` for a specific product combo. */
export function openingBalance(
  transactions: Transaction[], quality: string, gsm: number, size: number, fromDate?: string,
): number {
  let net = 0;
  for (const t of transactions) {
    if (t.void) continue;
    if (comboKeyOf(t) !== comboKey(quality, gsm, size)) continue;
    if (fromDate && String(t.date) >= String(fromDate)) continue;
    net += (Number(t.addQty) || 0) - (Number(t.outQty) || 0);
  }
  return round6(net);
}

export function sameCombo(t: Transaction, quality: string, gsm: number, size: number): boolean {
  return comboKeyOf(t) === comboKey(quality, gsm, size);
}

export function grandTotals(transactions: Transaction[]) {
  let add = 0, out = 0, nAdd = 0, nOut = 0, nIncomplete = 0;
  for (const t of transactions) {
    if (t.void) continue;
    const a = Number(t.addQty) || 0;
    const o = Number(t.outQty) || 0;
    add += a; out += o;
    if (a > 0) nAdd++;
    if (o > 0) nOut++;
    if (!isComboComplete(t.quality, t.gsm, t.size)) nIncomplete++;
  }
  return { add: round6(add), out: round6(out), net: round6(add - out), nAdd, nOut, nIncomplete };
}
