'use client';

/* =========================================================================
   PrintRoot.tsx — the single print pipeline (screen preview == paper print)
   -------------------------------------------------------------------------
   Improvements over the legacy system:
   • Pages flow naturally (height:auto) — no forced blank areas, no trailing
     empty page; small documents produce compact sheets.
   • Rows are chunked conservatively so page numbering stays correct.
   • thead repeats on every page (each chunk carries its own header).
   • Totals row + signatures render once, at the end of the last page.
   • @page orientation (portrait/landscape) is injected dynamically, with a
     manual toggle in the preview bar.
   • App chrome (sidebar/topbar/nav/dialogs) never reaches the paper.
   ========================================================================= */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { usePrint, type PrintSpec, type PrintPermitSpec, type PrintTableSpec } from './printStore';
import { fmtNum } from '@/lib/agrima/utils';
import { Button } from '@/components/ui/button';
import { Printer, X, RotateCcw, RotateCw } from 'lucide-react';

interface ChunkedTablePage {
  rows: string[][];
  pageNo: number;
  totalPages: number;
  withTotals: boolean;
}

function chunkRows(rows: string[][], capacity: number): string[][][] {
  if (rows.length <= capacity) return [rows];
  const chunks: string[][][] = [];
  for (let i = 0; i < rows.length; i += capacity) chunks.push(rows.slice(i, i + capacity));
  return chunks;
}

function blankZero(v: string): string {
  if (v == null || v === '') return '';
  const s = String(v).replace(/,/g, '').trim();
  if (/^[-+]?0+(\.0+)?$/.test(s)) return '';
  return v;
}

function PageHead({ spec, pageNo, total, first }: { spec: PrintSpec; pageNo: number; total: number; first: boolean }) {
  const today = new Date().toLocaleDateString('en-GB');
  const subtitle = spec.kind === 'table' ? spec.subtitle : undefined;
  const ob = spec.kind === 'table' ? spec.obLine : undefined;
  const title = spec.kind === 'table' ? spec.title : 'إذن صرف مخزني';
  return (
    <div className="rp-head">
      <div className="rp-co">{spec.company}</div>
      <div className="rp-title">{title}</div>
      {(subtitle || []).map((s, i) => (
        <div className="rp-sub" key={i}>{s}</div>
      ))}
      {first && ob && ob.length > 0 && <div className="rp-ob">{ob.join('  —  ')}</div>}
      <div className="rp-meta">
        <span>صفحة {pageNo} / {total}</span>
        <span>تاريخ الطباعة: {today}</span>
      </div>
    </div>
  );
}

function TablePage({ spec, page, orientation }: { spec: PrintTableSpec; page: ChunkedTablePage; orientation: string }) {
  const signatures = spec.signatures ?? ['أمين المخزن', 'المحاسب', 'مدير المخزن'];
  return (
    <div className={`agr-print-page ${orientation === 'landscape' ? 'landscape' : ''}`}>
      <PageHead spec={spec} pageNo={page.pageNo} total={page.totalPages} first={page.pageNo === 1} />
      {page.pageNo === 1 && spec.summary && spec.summary.length > 0 && (
        <div className="rp-ob">{spec.summary.join('  —  ')}</div>
      )}
      <table className={`rp-table ${spec.compact ? 'compact' : ''}`}>
        <thead>
          <tr>
            {spec.headers.map((h, i) => <th key={i}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {page.rows.length === 0 ? (
            <tr><td colSpan={spec.headers.length}>لا توجد بيانات</td></tr>
          ) : page.rows.map((r, ri) => (
            <tr key={ri}>
              {r.map((c, ci) => <td key={ci} className="rp-num">{blankZero(c)}</td>)}
            </tr>
          ))}
        </tbody>
        {page.withTotals && spec.totals && (
          <tfoot>
            <tr>
              {spec.totals.map((c, ci) => <td key={ci}>{blankZero(c)}</td>)}
            </tr>
          </tfoot>
        )}
      </table>
      {page.withTotals && (
        <div className="rp-foot">
          {spec.footerNote && <div className="rp-sub" style={{ textAlign: 'start' }}>{spec.footerNote}</div>}
          <div className="sig-row">
            {signatures.map((s, i) => (
              <div className="sig" key={i}><span>{s}</span><i /></div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PermitPage({ spec, landscape }: { spec: PrintPermitSpec; landscape: boolean }) {
  const merged: { quality: string; gsm: number | string; size: number | string; qty: number }[] = [];
  for (const l of spec.lines) {
    const k = `${l.quality}|${l.gsm}|${l.size}`;
    const found = merged.find((m) => `${m.quality}|${m.gsm}|${m.size}` === k);
    if (found) found.qty += l.qty;
    else merged.push({ quality: l.quality, gsm: l.gsm, size: l.size, qty: l.qty });
  }
  merged.sort((a, b) =>
    a.quality.localeCompare(b.quality, 'ar') || Number(a.gsm) - Number(b.gsm) || Number(a.size) - Number(b.size));
  return (
    <div className={`agr-print-page ${landscape ? 'landscape' : ''}`} style={{ gap: 8 }}>
      <div className="rp-head">
        <div className="rp-co">{spec.company}</div>
        <div className="rp-title">إذن صرف مخزني</div>
        <div className="rp-sub">رقم الإذن: {spec.permitNo} — التصنيف: {spec.clsLabel} — الحالة: {spec.status}</div>
        <div className="rp-meta"><span aria-hidden="true">{''}</span><span>تاريخ الطباعة: {new Date().toLocaleDateString('en-GB')}</span></div>
      </div>
      {spec.draft && <div className="draft-watermark">مسودة — غير معتمدة</div>}
      <table className="doc-meta">
        <tbody>
          <tr>
            <th>العميل / الجهة</th>
            <td>
              {spec.customer}
              {spec.conflictNote && <div className="doc-note-est" style={{ color: '#DC2626', fontWeight: 700 }}>{spec.conflictNote}</div>}
            </td>
            <th>التاريخ</th>
            <td>{spec.date}{spec.multiDate ? ' (أحدث تاريخ)' : ''}</td>
          </tr>
        </tbody>
      </table>
      <table className="rp-table">
        <thead>
          <tr><th>العدد</th><th>المقاس</th><th>الجرام</th><th>الصنف</th></tr>
        </thead>
        <tbody>
          {merged.map((l, i) => (
            <tr key={i}>
              <td className="rp-num">{fmtNum(l.qty)}</td>
              <td className="rp-num">{String(l.size)}</td>
              <td className="rp-num">{String(l.gsm)}</td>
              <td>{l.quality}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {spec.gsmTotals.length > 0 && (
        <table className="rp-table" style={{ marginTop: 6 }}>
          <thead>
            <tr><th>الجرام</th><th>إجمالي عدد البكر</th><th>إجمالي الوزن (طن)</th></tr>
          </thead>
          <tbody>
            {spec.gsmTotals.map((g, i) => (
              <tr key={i}>
                <td className="rp-num">{String(g.gsm)}</td>
                <td className="rp-num">{fmtNum(g.rolls)}</td>
                <td className="rp-num">{g.tons}{g.est ? ' *' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <table className="rp-table doc-total">
        <tbody>
          <tr>
            <td className="doc-total-label">إجمالي البكر</td>
            <td className="doc-total-num">{fmtNum(spec.totalRolls)} بكرة</td>
          </tr>
          <tr>
            <td className="doc-total-label">إجمالي الوزن (طن)</td>
            <td className="doc-total-num">{spec.totalTons}{spec.totalEst ? ' *' : ''}</td>
          </tr>
        </tbody>
      </table>
      {spec.notes && <div className="doc-notes">ملاحظات: {spec.notes}</div>}
      {spec.estNote && (
        <div className="doc-note-est">* جزء من الوزن تقديري (المقاس × 7.5) لبكر بلا وزن مسجل — لم يُستبدل أي وزن فعلي.</div>
      )}
      <div className="rp-foot">
        <div className="sig-row">
          {spec.signatures.map((s, i) => (
            <div className="sig" key={i}><span>{s}</span><i /></div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function PrintRoot() {
  const { spec, preview, orientation, setOrientation, close } = usePrint();
  const printed = useRef(false);

  /* inject/replace the @page rule (orientation is data-driven) */
  useEffect(() => {
    if (!spec) return;
    const style = document.createElement('style');
    style.id = 'agr-print-page-rule';
    style.textContent = `@media print { @page { size: A4 ${orientation}; margin: 7mm 8mm; } }`;
    document.head.appendChild(style);
    return () => { style.remove(); };
  }, [spec, orientation]);

  const doPrint = useCallback(() => {
    printed.current = true;
    usePrint.getState().setPreview(false);
    setTimeout(() => window.print(), 150);
  }, []);

  useEffect(() => {
    const handler = () => {
      if (printed.current) {
        printed.current = false;
        usePrint.getState().close();
      }
    };
    window.addEventListener('afterprint', handler);
    return () => window.removeEventListener('afterprint', handler);
  }, []);

  const tablePages = useMemo<ChunkedTablePage[] | null>(() => {
    if (!spec || spec.kind !== 'table') return null;
    const cap = orientation === 'landscape' ? 20 : 32;
    const chunks = chunkRows(spec.rows, cap);
    return chunks.map((rows, i) => ({
      rows, pageNo: i + 1, totalPages: chunks.length, withTotals: i === chunks.length - 1,
    }));
  }, [spec, orientation]);

  if (!spec) return null;

  const pages = (
    <>
      {spec.kind === 'table' && tablePages && tablePages.map((p) => (
        <TablePage spec={spec} page={p} orientation={orientation} key={p.pageNo} />
      ))}
      {spec.kind === 'permit' && <PermitPage spec={spec} landscape={orientation === 'landscape'} />}
    </>
  );

  if (preview) {
    return (
      <div className="fixed inset-0 z-[90] flex flex-col bg-slate-500/70" dir="rtl">
        <div className="bg-white border-b border-slate-200 px-4 py-2 flex items-center gap-2 shadow flex-wrap">
          <span className="font-bold text-sm">معاينة الطباعة — مقاس A4</span>
          <div className="inline-flex rounded-lg border border-slate-300 overflow-hidden">
            <button
              className={`px-3 py-1.5 text-xs font-bold flex items-center gap-1 ${orientation === 'portrait' ? 'bg-teal-700 text-white' : 'bg-white text-slate-600'}`}
              onClick={() => setOrientation('portrait')}
            >
              <RotateCcw size={14} /> طولي
            </button>
            <button
              className={`px-3 py-1.5 text-xs font-bold flex items-center gap-1 ${orientation === 'landscape' ? 'bg-teal-700 text-white' : 'bg-white text-slate-600'}`}
              onClick={() => setOrientation('landscape')}
            >
              <RotateCw size={14} /> عرضي
            </button>
          </div>
          <span className="text-xs text-slate-500">حدد «الخلفيات والرسومات» في نافذة الطباعة لطباعة ألوان الجداول</span>
          <div className="mr-auto flex items-center gap-2">
            <Button size="sm" className="bg-teal-700 hover:bg-teal-800" onClick={doPrint}>
              <Printer size={15} /> طباعة
            </Button>
            <Button size="sm" variant="outline" onClick={close}>
              <X size={15} /> إغلاق
            </Button>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-4">
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
            {pages}
          </div>
        </div>
      </div>
    );
  }

  return <div id="print-root">{pages}</div>;
}
