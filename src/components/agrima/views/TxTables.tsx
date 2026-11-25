'use client';

/* TxTables — سجل الإنتاج / سجل حركات الصرف / سجل الحركات الكامل
   One grouped table (120 groups/page) + filters + legacy group editor. */

import { useMemo, useState } from 'react';
import { useAgrima } from '@/lib/agrima/store';
import { buildGroups, deleteMovement, updateTransaction, addTransactionGroup } from '@/lib/agrima/tx';
import { fmtNum, fmtDate, productFamily, canonicalCustomer, sizesLabel } from '@/lib/agrima/utils';
import { round6 } from '@/lib/agrima/calc';
import { PageHead, EmptyRow, Pager, confirmAction } from '../ui-bits';
import { exportTransactions } from '@/lib/agrima/excel';
import { toast } from 'sonner';
import { can } from '@/lib/agrima/permissions';
import { Pencil, Trash2, Printer } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { usePrint, autoOrientation } from '../print/printStore';
import type { Transaction } from '@/lib/agrima/types';

const PAGE_SIZE = 120;

interface GroupView {
  key: string; rows: Transaction[]; date: string; quality: string; gsm: number | string | null;
  weight: number | null; customer: string; permitNo: string; settlement: string; notes: string;
  source: string; add: number; out: number; voidFlag: boolean; incomplete: boolean; multi: boolean;
}

export default function TxTables({ mode }: { mode: 'production' | 'outlog' | 'history' }) {
  const s = useAgrima();
  const [page, setPage] = useState(0);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState('');
  const [c, setC] = useState('');
  const [text, setText] = useState('');
  const [settle, setSettle] = useState('');
  const [editGroup, setEditGroup] = useState<GroupView | null>(null);

  const baseRows = useMemo(() => {
    if (mode === 'production') return s.transactions.filter((t) => Number(t.addQty) > 0);
    if (mode === 'outlog') return s.transactions.filter((t) => Number(t.outQty) > 0);
    return s.transactions;
  }, [s.transactions, mode]);

  const groups = useMemo(() => {
    const list: GroupView[] = buildGroups(baseRows.filter((t) => !t.void)).map((g) => {
      const weights = new Set(g.rows.map((r) => (r.weight == null ? null : Number(r.weight))));
      const w = weights.size === 1 ? Array.from(weights)[0] : null;
      return {
        key: g.key, rows: g.rows, date: g.date, quality: productFamily(g.quality), gsm: g.gsm,
        weight: w, customer: canonicalCustomer(g.customer), permitNo: g.permitNo,
        settlement: g.settlement, notes: g.notes, source: g.source,
        add: g.add, out: g.out,
        voidFlag: g.rows.every((r) => r.void),
        incomplete: g.rows.some((r) => r.gsm == null || r.size == null || r.quality === ''),
        multi: g.rows.length > 1,
      };
    });
    // void rows shown at their place via legacy single groups
    return list;
  }, [baseRows]);

  const customerOptions = useMemo(() => {
    const set = new Set<string>();
    for (const t of s.transactions) {
      const cc = canonicalCustomer(t.customer);
      if (cc && cc !== 'الإنتاج') set.add(cc);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'ar'));
  }, [s.transactions]);

  const familyOptions = useMemo(() => {
    const set = new Set<string>();
    for (const p of s.products) set.add(productFamily(p.quality));
    return Array.from(set);
  }, [s.products]);

  const filtered = useMemo(() => {
    let list = groups;
    if (mode !== 'production') {
      if (from) list = list.filter((g) => g.date >= from);
      if (to) list = list.filter((g) => g.date <= to);
      if (q) list = list.filter((g) => g.quality === q);
      if (c) list = list.filter((g) => g.customer === c);
      if (text) {
        const t = text.toLowerCase();
        list = list.filter((g) => (g.permitNo || '').toLowerCase().includes(t) || (g.notes || '').toLowerCase().includes(t));
      }
      if (settle) list = list.filter((g) => g.settlement === settle);
    }
    return list;
  }, [groups, mode, from, to, q, c, text, settle]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totAdd = round6(filtered.reduce((x, g) => x + g.add, 0));
  const totOut = round6(filtered.reduce((x, g) => x + g.out, 0));

  const title = mode === 'production'
    ? 'سجل الإنتاج (عرض ومراجعة — الإنتاج يُسجل من تسجيل البكر)'
    : mode === 'outlog' ? 'سجل حركات الصرف' : 'سجل الحركات الكامل';

  const doExport = () => {
    exportTransactions(baseRows);
    toast.success('تم تنزيل ملف الحركات');
  };

  const doPrint = () => {
    const headers = ['التاريخ', 'اسم الصنف', 'الجرام', 'وزن البكرة (كجم)', 'المقاسات والكميات', 'العميل / الجهة', 'رقم إذن الصرف', 'الكمية المضافة', 'الكمية المنصرفة', 'تصفيه'];
    const rows = filtered.map((g) => [
      fmtDate(g.date), g.quality + (g.multi ? ` (${g.rows.length} مقاس)` : ''), fmtNum(Number(g.gsm)) || '—',
      g.weight != null ? fmtNum(g.weight, 3) : '—',
      sizesLabel(g.rows.map((r) => ({ size: r.size, qty: r.addQty || r.outQty }))),
      g.customer, g.permitNo || '—', fmtNum(g.add), fmtNum(g.out), g.settlement || '—',
    ]);
    usePrint.getState().open({
      kind: 'table',
      company: s.settings.companyName || 'إدارة المخزن',
      title,
      headers,
      rows,
      totals: ['الإجمالي', `${fmtNum(filtered.length)} حركة — ${fmtNum(filtered.reduce((x, g) => x + g.rows.length, 0))} سطر`, '', '', '', '', '', fmtNum(totAdd), fmtNum(totOut), ''],
      signatures: ['أمين المخزن', 'المحاسب', 'مدير المخزن'],
      compact: true,
    }, autoOrientation(headers.length));
  };

  const openEdit = (g: GroupView) => {
    if (!can('edit')) { toast.error('لا تملك صلاحية التعديل'); return; }
    if (g.source === 'reels') {
      toast.info('حركة إنتاج من تسجيل البكر — التعديل من «إدارة الرولات والبكر» عبر تفاصيل الرول');
      useAgrima.getState().navigate('rolls' as never);
      return;
    }
    if ((g.rows[0].groupId || '').startsWith('P:')) {
      const pid = (g.rows[0].groupId || '').slice(2);
      const p = s.permits.find((x) => x.id === pid);
      if (p) {
        useAgrima.getState().setPendingEdit({ kind: 'permit', permit: p });
        useAgrima.getState().navigate('baker-issue' as never);
        return;
      }
    }
    setEditGroup(g);
  };

  const del = async (g: GroupView) => {
    if (!can('delete')) { toast.error('لا تملك صلاحية الحذف'); return; }
    if (g.source === 'reels') {
      toast.info('حركة إنتاج من تسجيل البكر — الحذف من «إدارة الرولات والبكر» عبر تفاصيل الرول');
      return;
    }
    if ((g.rows[0].groupId || '').startsWith('P:')) {
      toast.info('حركة إذن صرف — الحذف من قسم «أذون الصرف»');
      return;
    }
    const ok = await confirmAction({
      title: 'حذف الحركة',
      danger: true,
      message: g.rows.length > 1
        ? `سيتم حذف الحركة بكل مقاساتها (${g.rows.length} سطر) نهائيًا وتحديث الرصيد تلقائيًا.\n${g.quality} / ${g.gsm} — ${sizesLabel(g.rows.map((r) => ({ size: r.size, qty: r.addQty || r.outQty })))}`
        : `سيتم حذف الحركة نهائيًا وتحديث الرصيد تلقائيًا.\n${g.quality} / ${g.gsm} / مقاس ${g.rows[0].size}`,
      yesLabel: 'حذف نهائي',
    });
    if (!ok) return;
    try {
      await deleteMovement(g.rows, s.profile?.email);
      await useAgrima.getState().refresh();
      toast.success('تم الحذف وتحديث الرصيد');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <PageHead title={title}>
        <button className="agr-btn agr-btn-ghost" onClick={doExport}>تصدير Excel</button>
        <button className="agr-btn agr-btn-primary" onClick={doPrint}><Printer size={15} /> طباعة (A4)</button>
      </PageHead>

      {mode !== 'production' && (
        <div className="agr-card filters mb-3">
          <label className="agr-fl"><span>من تاريخ</span><input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(0); }} /></label>
          <label className="agr-fl"><span>إلى تاريخ</span><input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(0); }} /></label>
          <label className="agr-fl"><span>الصنف</span>
            <select value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }}>
              <option value="">الكل</option>
              {familyOptions.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </label>
          <label className="agr-fl"><span>العميل</span>
            <select value={c} onChange={(e) => { setC(e.target.value); setPage(0); }}>
              <option value="">الكل</option>
              {customerOptions.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </label>
          <label className="agr-fl"><span>بحث في إذن الصرف / ملاحظات</span>
            <input value={text} onChange={(e) => { setText(e.target.value); setPage(0); }} placeholder="بحث…" />
          </label>
          <label className="agr-fl"><span>تصفيه</span>
            <select value={settle} onChange={(e) => { setSettle(e.target.value); setPage(0); }}>
              <option value="">الكل</option>
              <option value="غ">غ</option>
              <option value="ض">ض</option>
            </select>
          </label>
          <button className="agr-btn agr-btn-ghost agr-btn-sm" onClick={() => { setFrom(''); setTo(''); setQ(''); setC(''); setText(''); setSettle(''); setPage(0); }}>مسح الفلاتر</button>
        </div>
      )}

      <div className="agr-table-wrap">
        <table className="agr-table">
          <thead>
            <tr>
              <th>التاريخ</th><th>اسم الصنف</th><th>الجرام</th><th>وزن البكرة (كجم)</th>
              <th>المقاسات والكميات</th><th>العميل / الجهة</th><th>رقم إذن الصرف</th>
              <th>الكمية المضافة</th><th>الكمية المنصرفة</th><th>تصفيه</th><th>إجراءات</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 && <EmptyRow colSpan={11} text="لا توجد حركات مطابقة" />}
            {pageRows.map((g) => (
              <tr key={g.key} className={g.add > 0 ? 'row-add' : 'row-out'}>
                <td className="num">{fmtDate(g.date)}</td>
                <td>
                  {g.quality}
                  {g.voidFlag && <span className="agr-badge agr-badge-void mr-1">ملغاة</span>}
                  {g.incomplete && <span className="agr-badge agr-badge-warn mr-1" title="ببيانات ناقصة — لا تدخل في حساب الرصيد">⚠</span>}
                  {g.multi && <span className="agr-badge agr-badge-multi mr-1">{g.rows.length} مقاس</span>}
                </td>
                <td className="num">{fmtNum(Number(g.gsm)) || '—'}</td>
                <td className="num">{g.weight != null ? fmtNum(g.weight, 3) : '—'}</td>
                <td>{sizesLabel(g.rows.map((r) => ({ size: r.size, qty: r.addQty || r.outQty })))}</td>
                <td>{g.customer}</td>
                <td className="num">{g.permitNo || '—'}</td>
                <td className="num pos">{g.add > 0 ? fmtNum(g.add) : ''}</td>
                <td className="num neg">{g.out > 0 ? fmtNum(g.out) : ''}</td>
                <td>{g.settlement || ''}</td>
                <td>
                  <div className="flex gap-1 justify-center">
                    <button className="agr-icon-btn" title="تعديل" onClick={() => openEdit(g)}><Pencil size={14} /></button>
                    <button className="agr-icon-btn danger" title="حذف" onClick={() => del(g)}><Trash2 size={14} /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={7}>الإجمالي ({fmtNum(filtered.length)} حركة — {fmtNum(filtered.reduce((x, g) => x + g.rows.length, 0))} سطر)</td>
              <td className="num">{fmtNum(totAdd)}</td>
              <td className="num">{fmtNum(totOut)}</td>
              <td></td><td></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <Pager page={page} pages={pages} onPage={setPage} />

      {editGroup && <GroupEditor group={editGroup} onClose={() => setEditGroup(null)} />}
    </div>
  );
}

/* ---------------- legacy group editor (header + size rows) ---------------- */

function GroupEditor({ group, onClose }: { group: GroupView; onClose: () => void }) {
  const s = useAgrima();
  const [date, setDate] = useState(group.date);
  const [quality, setQuality] = useState(group.quality);
  const [gsm, setGsm] = useState(String(group.gsm ?? ''));
  const [customer, setCustomer] = useState(group.customer);
  const [permitNo, setPermitNo] = useState(group.permitNo);
  const [weight, setWeight] = useState(group.weight != null ? String(group.weight) : '');
  const [settle, setSettle] = useState(group.settlement);
  const [notes, setNotes] = useState(group.notes);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [sizes, setSizes] = useState(group.rows.map((r) => ({
    size: String(r.size ?? ''), qty: String(r.addQty || r.outQty || 0),
    which: (r.addQty > 0 ? 'add' : 'out') as 'add' | 'out',
  })));
  const patchSize = (i: number, patch: Partial<{ size: string; qty: string; which: 'add' | 'out' }>) =>
    setSizes((xs) => xs.map((x, xi) => (xi === i ? { ...x, ...patch } : x)));

  const save = async () => {
    setErr('');
    setBusy(true);
    try {
      const newSizes = sizes
        .filter((x) => x.size !== '' && Number(x.qty) > 0)
        .map((x) => ({ size: Number(x.size), qty: Number(x.qty), which: x.which }));
      if (!newSizes.length) throw new Error('أدخل مقاسًا وكمية واحدة على الأقل');
      const header = {
        date, quality, gsm: Number(gsm), customer, permitNo,
        weight: weight ? Number(weight) : null, settlement: settle, notes,
      };
      if (group.rows.length === 1 && newSizes.length === 1) {
        const sz = newSizes[0];
        await updateTransaction(group.rows[0].id as number, {
          ...header, size: sz.size,
          addQty: sz.which === 'add' ? sz.qty : 0,
          outQty: sz.which === 'out' ? sz.qty : 0,
        }, s.profile?.email);
      } else {
        await deleteMovement(group.rows, s.profile?.email);
        await addTransactionGroup(header, newSizes, s.profile?.email);
      }
      await useAgrima.getState().refresh();
      toast.success('تم حفظ التعديل وتحديث الرصيد');
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle>تعديل حركة (التعديل مسجل في سجل التدقيق)</DialogTitle>
        </DialogHeader>
        <div className="agr-form-grid">
          <label className="agr-field"><span>التاريخ *</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label className="agr-field"><span>اسم الصنف *</span>
            <select value={quality} onChange={(e) => setQuality(e.target.value)}>
              {[...new Set(s.products.map((p) => productFamily(p.quality)))].map((f) => <option key={f} value={f}>{f}</option>)}
              <option value={quality}>{quality}</option>
            </select>
          </label>
          <label className="agr-field"><span>الجرام *</span><input type="number" value={gsm} onChange={(e) => setGsm(e.target.value)} /></label>
          <label className="agr-field"><span>العميل / الجهة *</span><input value={customer} onChange={(e) => setCustomer(e.target.value)} /></label>
          <label className="agr-field"><span>رقم إذن الصرف</span><input value={permitNo} onChange={(e) => setPermitNo(e.target.value)} /></label>
          <label className="agr-field"><span>وزن البكرة (كجم)</span><input type="number" step="0.001" value={weight} onChange={(e) => setWeight(e.target.value)} /></label>
          <label className="agr-field"><span>تصفيه</span>
            <select value={settle} onChange={(e) => setSettle(e.target.value)}>
              <option value="">—</option><option value="غ">غ</option><option value="ض">ض</option>
            </select>
          </label>
          <label className="agr-field"><span>ملاحظات</span><input value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
        </div>
        <div className="agr-table-wrap mt-2">
          <table className="agr-table">
            <thead><tr><th>المقاس</th><th>الكمية</th><th>نوع الحركة</th></tr></thead>
            <tbody>
              {sizes.map((row, i) => (
                <tr key={i}>
                  <td><input className="w-full border rounded px-2 py-1.5 text-sm" type="number" min={1} value={row.size} onChange={(e) => patchSize(i, { size: e.target.value })} /></td>
                  <td><input className="w-full border rounded px-2 py-1.5 text-sm" type="number" min={0} value={row.qty} onChange={(e) => patchSize(i, { qty: e.target.value })} /></td>
                  <td>
                    <select className="border rounded px-2 py-1.5 text-sm" value={row.which} onChange={(e) => patchSize(i, { which: e.target.value as 'add' | 'out' })}>
                      <option value="add">إضافة</option>
                      <option value="out">صرف</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {err && <div className="agr-form-error">{err}</div>}
        <DialogFooter>
          <button className="agr-btn agr-btn-primary" disabled={busy} onClick={save}>{busy ? 'جارٍ الحفظ…' : 'حفظ'}</button>
          <button className="agr-btn agr-btn-ghost" onClick={onClose}>إلغاء</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
