'use client';

/* Issuedocs — أذون الصرف: قائمة موحدة (أذون محفوظة + مستوردة) */

import { useMemo, useState } from 'react';
import { useAgrima } from '@/lib/agrima/store';
import { collectVouchers, approvePermit, deletePermit, CLS_LABEL } from '@/lib/agrima/tx';
import { inKeeperWindow, cairoToday, keeperWindowStart, can, isWarehouse } from '@/lib/agrima/permissions';
import { fmtNum, fmtDate } from '@/lib/agrima/utils';
import { round6 } from '@/lib/agrima/calc';
import { PageHead, EmptyRow, Pager, confirmAction } from '../ui-bits';
import { toast } from 'sonner';
import { Eye, Printer, Pencil, Check, Trash2, FilePlus2, Info } from 'lucide-react';
import { exportReportAOA } from '@/lib/agrima/excel';
import type { Voucher } from '@/lib/agrima/types';

const PAGE_SIZE = 60;

export default function Issuedocs() {
  const s = useAgrima();
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [clsF, setClsF] = useState('');
  const [statusF, setStatusF] = useState('');
  const [page, setPage] = useState(0);

  const keeper = isWarehouse();
  const winFrom = keeperWindowStart();
  const winTo = cairoToday();

  const vouchers = useMemo(() => collectVouchers(s.transactions, s.permits), [s.transactions, s.permits]);

  const filtered = useMemo(() => {
    let list = vouchers;
    if (keeper) {
      list = list.filter((v) => inKeeperWindow(v.date));
    } else {
      if (q) {
        const t = q.toLowerCase();
        list = list.filter((v) => v.permitNo.toLowerCase().includes(t) || v.customer.toLowerCase().includes(t));
      }
      if (from) list = list.filter((v) => v.date >= from);
      if (to) list = list.filter((v) => v.date <= to);
      if (clsF) list = list.filter((v) => v.cls === clsF);
      if (statusF) list = list.filter((v) => statusF === 'draft' ? v.status === 'draft' : statusF === 'approved' ? v.status === 'approved' : v.status === 'imported');
    }
    list = [...list].sort((a, b) => `${b.date}|${b.minId || 0}`.localeCompare(`${a.date}|${a.minId || 0}`));
    return list;
  }, [vouchers, q, from, to, clsF, statusF, keeper]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totRolls = round6(filtered.reduce((x, v) => x + v.totalRolls, 0));
  const totWeight = round6(filtered.reduce((x, v) => x + (v.totalWeightKg || 0), 0));

  const view = (v: Voucher) => {
    useAgrima.getState().setPendingDoc(v);
    useAgrima.getState().setAutoPrintDoc(false);
    useAgrima.getState().navigate('issuedoc' as never);
  };

  const print = (v: Voucher) => {
    useAgrima.getState().setPendingDoc(v);
    useAgrima.getState().setAutoPrintDoc(true);
    useAgrima.getState().navigate('issuedoc' as never);
  };

  const edit = (v: Voucher) => {
    if (!can('edit')) { toast.error('لا تملك صلاحية التعديل'); return; }
    if (v.kind === 'permit') {
      const p = s.permits.find((x) => x.id === v.permitId);
      if (p) {
        useAgrima.getState().setPendingEdit({ kind: 'permit', permit: p });
        useAgrima.getState().navigate('baker-issue' as never);
        return;
      }
    } else {
      useAgrima.getState().setPendingEdit({ kind: 'legacy', voucher: v });
      useAgrima.getState().navigate('baker-issue' as never);
    }
  };

  const approve = async (v: Voucher) => {
    if (!can('approve') || v.kind !== 'permit' || !v.permitId) return;
    const ok = await confirmAction({
      title: 'اعتماد الإذن',
      message: `اعتماد الإذن "${v.permitNo}" للعميل ${v.customer} (${fmtNum(v.totalRolls)} بكرة)؟ سيتم التحقق من الرصيد، وخصم الكميات، وتحديث حالة البكر المحددة إلى «مصروفة» — داخل عملية واحدة لا يمكن أن تنصف.`,
      yesLabel: 'اعتماد',
    });
    if (!ok) return;
    try {
      await approvePermit(v.permitId, s.profile?.email);
      await useAgrima.getState().refresh();
      toast.success(`تم اعتماد الإذن ${v.permitNo} وخصم ${fmtNum(v.totalRolls)} بكرة من الرصيد`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const del = async (v: Voucher) => {
    if (!can('delete')) { toast.error('لا تملك صلاحية الحذف'); return; }
    if (v.kind !== 'permit' || !v.permitId) {
      toast.error('الأذون المستوردة تُحذف من ملف الإكسل نفسه — لا يمكن حذفها من هنا');
      return;
    }
    const p = s.permits.find((x) => x.id === v.permitId);
    if (!p) return;
    const ok = await confirmAction({
      title: 'حذف الإذن',
      danger: true,
      message: p.status === 'approved'
        ? `سيتم حذف الإذن "${p.permitNo}" بكل أسطره (${fmtNum(v.totalRolls)} بكرة) نهائيًا، وستُعاد كمياته وحالة بكره إلى الرصيد تلقائيًا. العميل: ${p.customer} — التاريخ: ${fmtDate(p.date)}`
        : `حذف مسودة الإذن "${p.permitNo}"؟ المسودة لا تؤثر على الرصيد وستحذف نهائيًا.`,
      yesLabel: 'حذف نهائي',
    });
    if (!ok) return;
    try {
      await deletePermit(p.id, s.profile?.email);
      await useAgrima.getState().refresh();
      toast.success('تم الحذف وتحديث الرصيد');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const doExport = () => {
    const headers = ['رقم الإذن', 'العميل / الجهة', 'التاريخ', 'التصنيف', 'الحالة', 'اسم الصنف', 'الجرام', 'المقاس', 'الكمية المنصرفة', 'الوزن الإجمالي (كجم)'];
    const rows: (string | number)[][] = [];
    for (const v of filtered) {
      const status = v.status === 'draft' ? 'مسودة' : v.status === 'approved' ? 'معتمد' : 'مستورد';
      for (const l of v.lines) {
        rows.push([v.permitNo, v.customer, v.date, v.cls ? CLS_LABEL[v.cls] : '', status, l.family, l.gsm, l.size, l.qty, v.totalWeightKg ?? '']);
      }
    }
    exportReportAOA('أذون الصرف', headers, rows, null, 'اذون_الصرف');
    toast.success('تم تنزيل الملف');
  };

  return (
    <div>
      <PageHead title="أذون الصرف">
        {keeper ? null : (
          <>
            <button className="agr-btn agr-btn-ghost" onClick={doExport}>تصدير Excel</button>
            <button className="agr-btn agr-btn-primary" onClick={() => {
              useAgrima.getState().setPendingEdit(null);
              useAgrima.getState().navigate('baker-issue' as never);
            }}><FilePlus2 size={15} /> إذن صرف جديد</button>
          </>
        )}
      </PageHead>

      {keeper && (
        <div className="agr-card mb-3 text-xs flex items-start gap-2" style={{ borderInlineStart: '4px solid #0F766E' }}>
          <Info size={16} className="mt-0.5 text-teal-700 flex-shrink-0" />
          <div>
            <b>صلاحيات العرض والطباعة فقط</b>
            <div className="text-slate-500 mt-1">
              تعرض أذون اليوم {fmtDate(winTo)} والأمس {fmtDate(winFrom)} بتوقيت مصر — تُحدَّث النافذة تلقائيًا عند بداية يوم جديد.
              لا يمكنك إضافة أو تعديل أو حذف أو اعتماد أذون، ولا عرض الأذون الأقدم (محجوب من قاعدة البيانات نفسها).
            </div>
          </div>
        </div>
      )}

      {!keeper && (
        <div className="agr-card filters mb-3">
          <label className="agr-fl"><span>بحث</span>
            <input placeholder="بحث برقم الإذن أو اسم العميل…" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
          </label>
          <label className="agr-fl"><span>من تاريخ</span><input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(0); }} /></label>
          <label className="agr-fl"><span>إلى تاريخ</span><input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(0); }} /></label>
          <label className="agr-fl"><span>التصنيف</span>
            <select value={clsF} onChange={(e) => { setClsF(e.target.value); setPage(0); }}>
              <option value="">الكل</option><option value="ض">ضريبي</option><option value="غ">غير ضريبي</option>
            </select>
          </label>
          <label className="agr-fl"><span>الحالة</span>
            <select value={statusF} onChange={(e) => { setStatusF(e.target.value); setPage(0); }}>
              <option value="">الكل</option><option value="approved">معتمد</option><option value="draft">مسودة</option><option value="imported">مستورد</option>
            </select>
          </label>
          <button className="agr-btn agr-btn-ghost agr-btn-sm" onClick={() => { setQ(''); setFrom(''); setTo(''); setClsF(''); setStatusF(''); setPage(0); }}>مسح الفلاتر</button>
        </div>
      )}

      <div className="agr-table-wrap">
        <table className="agr-table">
          <thead>
            <tr>
              <th>رقم الإذن</th><th>العميل / الجهة</th><th>التاريخ</th><th>التصنيف</th><th>الحالة</th>
              <th>إجمالي البكر</th><th>الوزن الإجمالي (كجم)</th><th>إجراءات</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 && <EmptyRow colSpan={8} text="لا توجد أذون صرف مطابقة" />}
            {pageRows.map((v) => (
              <tr key={v.key}>
                <td>
                  <button className="agr-voucher-no" onClick={() => view(v)}>{v.permitNo || '—'}</button>
                  {v.multiDate && <span className="agr-badge agr-badge-multi mr-1">أحدث تاريخ</span>}
                </td>
                <td>
                  {v.customer}
                  {v.customerConflict && <span className="agr-badge agr-badge-warn mr-1" title="نفس الرقم مستخدم لعملاء آخرين — للمراجعة، لا دمج تلقائي">⚠ تعارض عميل</span>}
                </td>
                <td className="num">{fmtDate(v.date)}</td>
                <td>{v.cls ? <span className={`agr-badge ${v.cls === 'ض' ? 'agr-badge-tax' : 'agr-badge-nontax'}`}>{CLS_LABEL[v.cls]}</span> : '—'}</td>
                <td>
                  {v.status === 'draft' && <span className="agr-badge agr-badge-draft">مسودة — غير معتمدة</span>}
                  {v.status === 'approved' && <span className="agr-badge agr-badge-approved">معتمد</span>}
                  {v.status === 'imported' && <span className="agr-badge agr-badge-imported">مستورد</span>}
                </td>
                <td className="num font-bold">{fmtNum(v.totalRolls)}</td>
                <td className="num">
                  {v.totalWeightKg != null ? fmtNum(v.totalWeightKg, 3) : 'تقديري'}
                  {v.totalWeightKg != null && v.weightEstimated && <span className="text-slate-400"> (جزئي)</span>}
                </td>
                <td>
                  <div className="flex gap-1 justify-center">
                    <button className="agr-icon-btn" title="عرض" onClick={() => view(v)}><Eye size={14} /></button>
                    <button className="agr-icon-btn" title="طباعة الإذن" onClick={() => print(v)}><Printer size={14} /></button>
                    {!keeper && v.kind === 'permit' && (
                      <button className="agr-icon-btn" title="تعديل" onClick={() => edit(v)}><Pencil size={14} /></button>
                    )}
                    {!keeper && v.kind === 'permit' && v.status === 'draft' && (
                      <button className="agr-icon-btn" title="اعتماد" onClick={() => approve(v)}><Check size={14} /></button>
                    )}
                    {!keeper && v.kind === 'permit' && (
                      <button className="agr-icon-btn danger" title="حذف" onClick={() => del(v)}><Trash2 size={14} /></button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>الإجمالي ({fmtNum(filtered.length)} إذن)</td>
              <td></td><td></td><td></td><td></td>
              <td className="num">{fmtNum(totRolls)}</td>
              <td className="num">{fmtNum(totWeight, 3)}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <Pager page={page} pages={pages} onPage={setPage} />
    </div>
  );
}
