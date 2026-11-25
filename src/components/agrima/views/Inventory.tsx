'use client';

/* Inventory view — الرصيد الحالي + إدارة الأصناف */

import { useMemo, useState } from 'react';
import { useAgrima } from '@/lib/agrima/store';
import { productWeight, round6, comboKey } from '@/lib/agrima/calc';
import { db, repo, uuid } from '@/lib/agrima/db';
import { fmtNum, productFamily, CANON_FAMILIES } from '@/lib/agrima/utils';
import { PageHead, EmptyRow, confirmAction } from '../ui-bits';
import { exportInventoryBuckets } from '@/lib/agrima/excel';
import { toast } from 'sonner';
import { can } from '@/lib/agrima/permissions';
import { Search, Trash2, Pencil, Plus, Printer } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { usePrint, autoOrientation } from '../print/printStore';
import type { BalanceRow } from '@/lib/agrima/types';

export default function Inventory({ mode }: { mode: 'inventory' | 'products' }) {
  return mode === 'inventory' ? <CurrentBalance /> : <ProductsAdmin />;
}

function CurrentBalance() {
  const s = useAgrima();
  const [q, setQ] = useState('');
  const [family, setFamily] = useState('');
  const [gsmF, setGsmF] = useState('');
  const [sizeF, setSizeF] = useState('');
  const [onlyReels, setOnlyReels] = useState(false);
  const [sort, setSort] = useState('family');
  const [details, setDetails] = useState<(BalanceRow & { family: string; estWeight: number }) | null>(null);

  const rowsBase = useMemo(() => {
    const list: (BalanceRow & { family: string; estWeight: number })[] = [];
    for (const b of s.balances.values()) {
      if (!(Number(b.net) > 0)) continue; // zero/negative always hidden
      list.push({ ...b, family: productFamily(b.quality), estWeight: productWeight(b.size, b.net, s.settings.weightFactor) });
    }
    return list;
  }, [s.balances, s.settings.weightFactor]);

  const familyOptions = useMemo(() => {
    const set = new Set(rowsBase.map((r) => r.family));
    return CANON_FAMILIES.filter((f) => set.has(f));
  }, [rowsBase]);
  const gsmOptions = useMemo(() => Array.from(new Set(rowsBase.map((r) => String(r.gsm)))).sort((a, b) => Number(a) - Number(b)), [rowsBase]);
  const sizeOptions = useMemo(() => Array.from(new Set(rowsBase.map((r) => String(r.size)))).sort((a, b) => Number(a) - Number(b)), [rowsBase]);

  const rows = useMemo(() => {
    let list = rowsBase;
    if (q) list = list.filter((r) => r.quality.includes(q) || r.family.includes(q));
    if (family) list = list.filter((r) => r.family === family);
    if (gsmF) list = list.filter((r) => String(r.gsm) === gsmF);
    if (sizeF) list = list.filter((r) => String(r.size) === sizeF);
    if (onlyReels) {
      list = list.filter((r) => s.reels.some((re) => re.status === 'available'
        && comboKey(re.quality, re.gram, re.size) === comboKey(r.quality, r.gsm, r.size)));
    }
    if (sort === 'bal-desc') list = [...list].sort((a, b) => b.net - a.net);
    else if (sort === 'bal-asc') list = [...list].sort((a, b) => a.net - b.net);
    else if (sort === 'weight-desc') list = [...list].sort((a, b) => b.estWeight - a.estWeight);
    else {
      list = [...list].sort((a, b) => {
        const ia = CANON_FAMILIES.indexOf(a.family as never);
        const ib = CANON_FAMILIES.indexOf(b.family as never);
        if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        return a.family.localeCompare(b.family, 'ar') || Number(a.gsm) - Number(b.gsm) || Number(a.size) - Number(b.size);
      });
    }
    return list;
  }, [rowsBase, q, family, gsmF, sizeF, onlyReels, sort, s.reels]);

  const totalQty = round6(rows.reduce((sm, r) => sm + r.net, 0));
  const totalWeight = round6(rows.reduce((sm, r) => sm + r.estWeight, 0));

  const availReels = useMemo(() => {
    if (!details) return [];
    return s.reels
      .filter((r) => r.status === 'available'
        && comboKey(r.quality, r.gram, r.size) === comboKey(details.quality, details.gsm, details.size))
      .sort((a, b) => a.rollNo - b.rollNo || a.reelNo - b.reelNo);
  }, [details, s.reels]);

  const doExport = () => {
    exportInventoryBuckets(rowsBase.map((r) => ({ quality: r.quality, gsm: r.gsm, size: r.size, add: r.add, out: r.out, net: r.net, estWeight: r.estWeight })));
    toast.success('تم تنزيل ملف رصيد المخزن');
  };

  const doPrint = () => {
    const headers = ['اسم الصنف', 'الجرام', 'المقاس', 'الكمية المضافة', 'الكمية المنصرفة', 'رصيد المخزن', 'الوزن التقريبي (كجم)'];
    usePrint.getState().open({
      kind: 'table',
      company: s.settings.companyName || 'إدارة المخزن',
      title: 'تقرير الرصيد الحالي',
      subtitle: ['الأصناف ذات الرصيد الموجب فقط — الأصناف المنتهية أو السالبة لا تظهر'],
      headers,
      rows: rows.map((r) => [r.family, String(r.gsm), String(r.size), fmtNum(r.add), fmtNum(r.out), fmtNum(r.net), fmtNum(r.estWeight, 2)]),
      totals: ['الإجمالي', `${fmtNum(rows.length)} مقاس`, '', fmtNum(round6(rows.reduce((x, r) => x + r.add, 0))), fmtNum(round6(rows.reduce((x, r) => x + r.out, 0))), fmtNum(totalQty), fmtNum(totalWeight, 2)],
      signatures: ['أمين المخزن', 'المحاسب', 'مدير المخزن'],
    }, autoOrientation(headers.length));
  };

  return (
    <div>
      <PageHead title="الرصيد الحالي">
        {can('importExport') && (
          <>
            <button className="agr-btn agr-btn-ghost" onClick={doExport}>تصدير Excel</button>
            <button className="agr-btn agr-btn-primary" onClick={doPrint}><Printer size={15} /> طباعة (A4)</button>
          </>
        )}
      </PageHead>

      <div className="agr-card filters mb-3">
        <label className="agr-fl"><span>بحث</span>
          <div className="relative">
            <Search size={14} className="absolute top-1/2 -translate-y-1/2 start-2 text-slate-400" />
            <input className="ps-7" placeholder="بحث باسم الصنف…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </label>
        <label className="agr-fl"><span>الصنف</span>
          <select value={family} onChange={(e) => setFamily(e.target.value)}>
            <option value="">الكل</option>
            {familyOptions.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </label>
        <label className="agr-fl"><span>الجرام</span>
          <select value={gsmF} onChange={(e) => setGsmF(e.target.value)}>
            <option value="">الكل</option>
            {gsmOptions.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        </label>
        <label className="agr-fl"><span>المقاس</span>
          <select value={sizeF} onChange={(e) => setSizeF(e.target.value)}>
            <option value="">الكل</option>
            {sizeOptions.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        </label>
        <label className="agr-fl"><span>ترتيب</span>
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="family">الصنف</option>
            <option value="bal-desc">الرصيد (تنازلي)</option>
            <option value="bal-asc">الرصيد (تصاعدي)</option>
            <option value="weight-desc">الوزن التقريبي (تنازلي)</option>
          </select>
        </label>
        <label className="agr-fl flex-row items-center gap-2 !flex">
          <input type="checkbox" className="w-4 h-4" checked={onlyReels} onChange={(e) => setOnlyReels(e.target.checked)} />
          <span>البكر المتاحة في المخزن فقط</span>
        </label>
        <button className="agr-btn agr-btn-ghost agr-btn-sm" onClick={() => { setQ(''); setFamily(''); setGsmF(''); setSizeF(''); setOnlyReels(false); setSort('family'); }}>مسح الفلاتر</button>
      </div>

      <div className="agr-table-wrap">
        <table className="agr-table">
          <thead>
            <tr>
              <th>اسم الصنف</th><th>الجرام</th><th>المقاس</th><th>الكمية المضافة</th>
              <th>الكمية المنصرفة</th><th>رصيد المخزن</th><th>الوزن التقريبي (كجم)</th><th>إجراءات</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <EmptyRow colSpan={8} text="لا توجد أصناف برصيد مطابقة للبحث" />}
            {rows.map((r, i) => (
              <tr key={r.key} className={i === 0 || rows[i - 1].family !== r.family ? '' : ''}>
                <td>{r.family}</td>
                <td className="num">{fmtNum(Number(r.gsm))}</td>
                <td className="num">{String(r.size)}</td>
                <td className="num pos">{fmtNum(r.add)}</td>
                <td className="num neg">{fmtNum(r.out)}</td>
                <td className="num pos">{fmtNum(r.net)}</td>
                <td className="num">{fmtNum(r.estWeight, 2)}</td>
                <td><button className="agr-voucher-no" onClick={() => setDetails(r)}>تفاصيل</button></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>الإجمالي ({fmtNum(rows.length)} مقاس)</td>
              <td></td><td></td>
              <td className="num">{fmtNum(round6(rows.reduce((x, r) => x + r.add, 0)))}</td>
              <td className="num">{fmtNum(round6(rows.reduce((x, r) => x + r.out, 0)))}</td>
              <td className="num">{fmtNum(totalQty)}</td>
              <td className="num">{fmtNum(totalWeight, 2)}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>

      <Dialog open={!!details} onOpenChange={(o) => !o && setDetails(null)}>
        <DialogContent className="max-w-lg" dir="rtl">
          <DialogHeader>
            <DialogTitle>تفاصيل المقاس وأكواد البكر</DialogTitle>
          </DialogHeader>
          {details && (
            <>
              <div className="flex gap-2 flex-wrap text-xs">
                <span className="agr-badge agr-badge-st-avail">الرصيد: {fmtNum(details.net)}</span>
                <span className="agr-badge agr-badge-imported">الوزن التقريبي: {fmtNum(details.estWeight, 2)} كجم</span>
                <span className="agr-badge agr-badge-multi">عدد الأكواد المسجلة: {fmtNum(availReels.length)}</span>
              </div>
              <div className="agr-table-wrap max-h-72 overflow-y-auto">
                <table className="agr-table">
                  <thead>
                    <tr><th>كود الرول</th><th>كود البكرة</th><th>المقاس</th><th>وزن البكرة (كجم)</th><th>الحالة</th></tr>
                  </thead>
                  <tbody>
                    {availReels.length === 0 && <EmptyRow colSpan={5} text="لا توجد أكواد بكر مسجلة كمتاحة لهذا المقاس" />}
                    {availReels.map((r) => (
                      <tr key={r.id}>
                        <td className="num">{r.rollNo}</td>
                        <td className="num">{r.reelNo}</td>
                        <td className="num">{r.size ?? '—'}</td>
                        <td className="num">{fmtNum(r.weight, 3)}</td>
                        <td><span className="agr-badge agr-badge-st-avail">متاحة</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ProductsAdmin() {
  const s = useAgrima();
  const [showAll, setShowAll] = useState(false);
  const [edit, setEdit] = useState<{ id?: number; quality: string; gsm: string; size: string } | null>(null);
  const [err, setErr] = useState('');

  const rows = useMemo(() => {
    const list = [...s.products].sort((a, b) =>
      (a.quality || '').localeCompare(b.quality || '', 'ar') || Number(a.gsm) - Number(b.gsm) || Number(a.size) - Number(b.size));
    if (showAll) return list;
    return list.filter((p) => (s.balances.get(p.combo)?.net ?? 0) > 0);
  }, [s.products, s.balances, showAll]);

  const openNew = () => setEdit({ quality: CANON_FAMILIES[0], gsm: '', size: '' });

  const save = async () => {
    if (!edit) return;
    setErr('');
    const quality = edit.quality.trim();
    const gsm = Number(edit.gsm);
    const size = Number(edit.size);
    if (!quality || !gsm || !size) { setErr('أكمل جميع الحقول'); return; }
    const combo = comboKey(quality, gsm, size);
    const clash = s.products.find((p) => p.combo === combo && p.id !== edit.id);
    if (clash) { setErr('يوجد صنف بنفس الموصفات'); return; }
    if (edit.id != null) {
      const old = await db.get<{ combo: string; source?: string }>('products', edit.id);
      await db.put('products', { quality, gsm, size, combo, source: old?.source || 'manual' });
      await db.logAudit({ entity: 'product', action: 'edit', entityId: String(edit.id), details: `تعديل صنف: ${quality} / ${gsm} / ${size}`, actor: s.profile?.email });
    } else {
      await db.add('products', { quality, gsm, size, combo, source: 'manual', createdAt: new Date().toISOString() });
      await db.logAudit({ entity: 'product', action: 'add', entityId: combo, details: `إضافة صنف: ${quality} / ${gsm} / ${size}`, actor: s.profile?.email });
    }
    setEdit(null);
    await useAgrima.getState().refresh();
    toast.success('تم الحفظ');
  };

  const del = async (p: { id?: number; quality: string; gsm: unknown; size: unknown; combo?: string }) => {
    const hasTx = s.transactions.some((t) => comboKey(t.quality, t.gsm, t.size) === (p.combo || comboKey(p.quality, p.gsm, p.size)));
    const ok = await confirmAction({
      title: 'حذف الصنف',
      danger: true,
      message: hasTx
        ? `هذا الصنف له حركات مسجلة. حذف الصنف لن يحذف الحركات التاريخية ولن يغير الأرصدة المحسوبة — سيزيل تعريف الصنف فقط. متابعة؟`
        : `حذف الصنف ${p.quality} / ${p.gsm} / ${p.size}؟`,
      yesLabel: 'حذف',
    });
    if (!ok || p.id == null) return;
    await db.del('products', p.id);
    await db.logAudit({ entity: 'product', action: 'delete', entityId: String(p.id), details: `حذف صنف: ${p.quality} / ${p.gsm} / ${p.size}`, actor: s.profile?.email });
    await useAgrima.getState().refresh();
    toast.success('تم الحذف');
  };

  const families = useMemo(() => {
    const set = new Set(s.products.map((p) => p.quality));
    const canon = CANON_FAMILIES.filter((f) => set.has(f));
    const extra = Array.from(set).filter((f) => !CANON_FAMILIES.includes(f as never));
    return [...canon, ...extra];
  }, [s.products]);

  return (
    <div>
      <PageHead title="إدارة الأصناف">
        <button className="agr-btn agr-btn-primary" onClick={openNew}><Plus size={15} /> مقاس جديد</button>
      </PageHead>
      <div className="agr-card mb-3 text-xs text-slate-600 flex items-center justify-between flex-wrap gap-2">
        <span>المنتجان المعتمدان فقط: «تست لينر معالج» و«توب لاينر» — لا يُسمح بأسماء جديدة لمنع التكرار.</span>
        <label className="flex items-center gap-2 font-bold">
          <input type="checkbox" className="w-4 h-4" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          إظهار كل المقاسات (حتى الرصيد الصفر)
        </label>
      </div>
      <div className="agr-table-wrap">
        <table className="agr-table">
          <thead>
            <tr><th>اسم الصنف</th><th>الجرام</th><th>المقاس</th><th>رصيد المخزن</th><th>المصدر</th><th>إجراءات</th></tr>
          </thead>
          <tbody>
            {rows.length === 0 && <EmptyRow colSpan={6} text="لا توجد أصناف" />}
            {rows.map((p, i) => {
              const bal = s.balances.get(p.combo);
              const srcLabel = p.source === 'excel' ? 'مستورد' : p.source === 'discovered' ? 'مكتشف من الحركات' : 'يدوي';
              return (
                <tr key={p.id}>
                  <td className="text-start font-bold">{i === 0 || rows[i - 1].quality !== p.quality ? p.quality : ''}</td>
                  <td className="num">{fmtNum(Number(p.gsm))}</td>
                  <td className="num">{String(p.size)}</td>
                  <td className={`num ${bal && bal.net > 0 ? 'pos' : ''}`}>{bal ? fmtNum(bal.net) : ''}</td>
                  <td><span className="agr-badge agr-badge-imported">{srcLabel}</span></td>
                  <td>
                    <div className="flex gap-1 justify-center">
                      <button className="agr-icon-btn" title="تعديل" onClick={() => setEdit({ id: p.id, quality: p.quality, gsm: String(p.gsm), size: String(p.size) })}><Pencil size={14} /></button>
                      <button className="agr-icon-btn danger" title="حذف" onClick={() => del(p)}><Trash2 size={14} /></button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
        <DialogContent className="max-w-sm" dir="rtl">
          <DialogHeader>
            <DialogTitle>{edit?.id ? 'تعديل صنف' : 'مقاس جديد'}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <label className="agr-field"><span>اسم الصنف</span>
              <select value={edit?.quality || ''} onChange={(e) => setEdit((x) => x && { ...x, quality: e.target.value })}>
                {[...families].map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </label>
            <label className="agr-field"><span>الجرام</span>
              <input type="number" min={1} value={edit?.gsm || ''} onChange={(e) => setEdit((x) => x && { ...x, gsm: e.target.value })} />
            </label>
            <label className="agr-field"><span>المقاس</span>
              <input type="number" min={1} value={edit?.size || ''} onChange={(e) => setEdit((x) => x && { ...x, size: e.target.value })} />
            </label>
            {err && <div className="agr-form-error">{err}</div>}
          </div>
          <DialogFooter>
            <button className="agr-btn agr-btn-primary" onClick={save}>حفظ</button>
            <button className="agr-btn agr-btn-ghost" onClick={() => setEdit(null)}>إلغاء</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
