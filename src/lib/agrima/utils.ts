/* =========================================================================
   utils.ts — shared formatting / canonicalization helpers (port of ui.js)
   Numbers always western digits; dates stored ISO YYYY-MM-DD, shown DD/MM/YYYY.
   ========================================================================= */

export const CANON_FAMILIES = ['تست لينر معالج', 'توب لاينر'] as const;
export const PRODUCTION_CUSTOMER = 'الإنتاج';

export function fmtNum(n: number | null | undefined, decimals?: number): string {
  if (n === null || n === undefined || isNaN(Number(n))) return '';
  const d = decimals ?? (Number.isInteger(n) ? 0 : 3);
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: d });
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const s = String(iso);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return s;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

export function todayISO(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function nowStr(): string {
  return new Date().toISOString();
}

/** Normalizes any messy product name into the two canonical families. */
export function productFamily(name: unknown): string {
  const s = String(name ?? '').trim();
  if (!s) return '';
  const noDiac = s.normalize('NFKC').replace(/[\u064B-\u0652]/g, '');
  const has = (...ws: string[]) => ws.every((w) => noDiac.includes(w));
  if (has('تست', 'لينر', 'معالج') || has('تست', 'لينر', 'معالج'.replace('ا', 'ا'))) return CANON_FAMILIES[0];
  if (noDiac.includes('تست') && noDiac.includes('لينر')) return CANON_FAMILIES[0];
  if (has('توب', 'لاينر')) return CANON_FAMILIES[1];
  if (noDiac.includes('توب') && noDiac.includes('لاينر')) return CANON_FAMILIES[1];
  return s;
}

export function isProductionCustomer(name: unknown): boolean {
  const s = String(name ?? '').trim().normalize('NFKC').replace(/[\u064B-\u0652]/g, '');
  return /انتاج|إنتاج|إنتاج/.test(s) || s === 'انتاج' || s === 'الانتاج' || s === 'إنتاج' || s === 'الإنتاج';
}

export function canonicalCustomer(name: unknown): string {
  const s = String(name ?? '').trim();
  return isProductionCustomer(s) ? PRODUCTION_CUSTOMER : s;
}

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** deterministic comparable key for (customer | product | gsm | size) filters */
export function sval(v: unknown): string {
  return String(v ?? '').trim();
}

export function cmpAr(a: string, b: string): number {
  return a.localeCompare(b, 'ar');
}

/* ---------------- Africa/Cairo helpers (keeper 2-day window) ---------------- */

export function cairoToday(now?: number): string {
  const d = now ? new Date(now) : new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d).reduce((m, p) => { m[p.type] = p.value; return m; }, {} as Record<string, string>);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function keeperWindowStart(now?: number): string {
  const t = cairoToday(now);
  const [y, m, d] = t.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) - 24 * 3600 * 1000);
  return dt.toISOString().slice(0, 10);
}

export function inKeeperWindow(dateISO: string | undefined, now?: number): boolean {
  if (!dateISO) return false;
  const d = String(dateISO).slice(0, 10);
  return d >= keeperWindowStart(now) && d <= cairoToday(now);
}

/* ---------------- misc ---------------- */

export function sizesLabel(pairs: { size: unknown; qty: number }[]): string {
  return [...pairs]
    .sort((a, b) => Number(a.size) - Number(b.size))
    .map((p) => `${String(p.size)}×${fmtNum(p.qty)}`)
    .join('، ');
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 400);
}

export function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

export function fileFingerprint(buf: ArrayBuffer): Promise<string> {
  try {
    if (crypto?.subtle) {
      return crypto.subtle.digest('SHA-256', buf).then((h) => {
        const arr = new Uint8Array(h);
        return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
      });
    }
  } catch { /* fall through */ }
  // FNV-1a 64 fallback
  let h1 = 0xcbf29ce4, h2 = 0x84222325;
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) {
    h1 = (h1 ^ bytes[i]); h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  return Promise.resolve('fnv-' + (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16));
}
