'use client';

/* Rolls — إدارة الرولات والبكر (قائمة + تفاصيل + تعديل بكر + طباعة + تصدير) */

import { useMemo, useState } from 'react';
import { useAgrima } from '@/lib/agrima/store';
import { REEL_STATUS, deleteRoll, editReel, deleteReel } from '@/lib/agrima/tx';
import { round6 } from '@/lib/agrima/calc';
import { fmtNum, fmtDate, productFamily, CANON_FAMILIES } from '@/lib/agrima/utils';
import { PageHead, EmptyRow, Pager, confirmAction } from '../ui-bits';
import { exportRollsList } from '@/lib/agrima/excel';
import { toast } from 'sonner';
import { can } from '@/lib/agrima/permissions';
import { Search, Eye, Printer, Trash2, Pencil, X } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { usePrint } from '../print/printStore';
import type { Reel, Roll } from '@/lib/agrima/types';

const PAGE_SIZE = 40;

export default function Rolls() {
  const s = useAgrima();
  const [q, setQ] = useState('');
  const [srcF, setSrcF] = useState('');
  const [stF, setStF] = useState('');
  const [page, setPage] = useState(0);
  const [detailsRoll, setDetailsRoll] = useState<Roll | null>(null);

  const reelsByRoll = useMemo(() => {
    const map = new Map<number, Reel[]>();
    for (const r of s.reels) {
      const arr = map.get(r.rollNo) || [];
      arr.push(r);
      map.set(r.rollNo, arr);
    }
    for (const arr of map.values()) arr.sort((a, b) => a.reelNo - b.reelNo);
    return map;
  }, [s.reels]);

  const rows = useMemo(() => {
    let list = [...s.rolls].sort((a, b) => Number(b.rollNo) - Number(a.rollNo));
    if (q) list = list.filter((r) => String(r.rollNo).includes(q));
    if (srcF) list = list.filter((r) => (r.source || 'reels') === srcF);
    if (stF) {
      list = list.filter((r) => {
        const reels = reelsByRoll.get(Number(r.rollNo)) || [];
        if (stF === 'undefined') return reels.length > 0 && reels.every((x) => x.status === 'undefined');
        return reels.some((x) => x.status === stF);
      });
    }
    return list;
  }, [s.rolls, q, srcF, stF, reelsByRoll]);

  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice(page * PAGE_SIZE, (page * PAGE_SIZE) + PAGE_SIZE);

  const totReels = rows.reduce((sm, r) => sm + (reelsByRoll.get(Number(r.rollNo)) || []).length, 0);
  const totWeight = round6(rows.reduce((sm, r) => sm + (reelsByRoll.get(Number(r.rollNo)) || []).reduce((x, rl) => x + (Number(rl.weight) || 0), 0), 0));

  const del = async (roll: Roll) => {
    if (!can('delete')) { toast.error('لا تملك صلاحية الحذف'); return; }
    const reels = reelsByRoll.get(Number(roll.rollNo)) || [];
    const ok = await confirmAction({
      title: 'حذف الرول',
      danger: true,
      message: `سيتم حذف الرول ${roll.rollNo} بكل بكره (${reels.length}) وحركات إنتاجه من التطبيق نهائيًا. الرولات المستوردة تُحذف من التفاصيل فقط. متابعة؟`,
      yesLabel: 'حذف نهائي',
    });
    if (!ok) return;
    try {
      await deleteRoll(Number(roll.rollNo), s.profile?.email);
      await useAgrima.getState().refresh();
      toast.success('تم حذف الرول وحركاته وتحديث الرصيد');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const doExport = () => {
    const list: Parameters<typeof exportRollsList>[0] = [];
    for (const roll of rows) {
      for (const reel of reelsByRoll.get(Number(roll.rollNo)) || []) {
        list.push({ roll, reel });
      }
    }
    exportRollsList(list);
    toast.success('تم تنزيل ملف الرولات والبكر');
  };

  return (
    <div>
      <PageHead title="إدارة الرولات والبكر">
        <button className="agr-btn agr-btn-ghost" onClick={doExport}>تصدير Excel</button>
        <button className="agr-btn agr-btn-primary" onClick={() => useAgrima.getState().navigate('reels-add' as never)}>+ تسجيل بكر</button>
      </PageHead>

      <div className="agr-card filters mb-3">
        <label className="agr-fl"><span>بحث</span>
          <div className="relative">
            <Search size={14} className="absolute top-1/2 -translate-y-1/2 start-2 text-slate-400" />
            <input className="ps-7" placeholder="بحث برقم الرول…" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
          </div>
        </label>
        <label className="agr-fl"><span>المصدر</span>
          <select value={srcF} onChange={(e) => { setSrcF(e.target.value); setPage(0); }}>
            <option value="">الكل</option>
            <option value="reels">تسجيل البكر</option>
            <option value="excel">مستورد (اجمالي المخزن)</option>
          </select>
        </label>
        <label className="agr-fl"><span>حالة البكر</span>
          <select value={stF} onChange={(e) => { setStF(e.target.value); setPage(0); }}>
            <option value="">الكل</option>
            <option value="available">فيها بكر متاحة</option>
            <option value="dispatched">فيها بكر مصروفة</option>
            <option value="returned">فيها بكر مرجعة للمورد</option>
            <option value="undefined">غير محددة (مستوردة)</option>
          </select>
        </label>
        <button className="agr-btn agr-btn-ghost agr-btn-sm" onClick={() => { setQ(''); setSrcF(''); setStF(''); setPage(0); }}>مسح الفلاتر</button>
      </div>

      <div className="agr-table-wrap">
        <table className="agr-table">
          <thead>
            <tr>
              <th>رقم الرول</th><th>التاريخ</th><th>الجرام</th><th>عدد البكر</th>
              <th>إجمالي الوزن (كجم)</th><th>الحالات</th><th>المصدر</th><th>إجراءات</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 && <EmptyRow colSpan={8} text="لا توجد رولات" />}
            {pageRows.map((roll) => {
              const reels = reelsByRoll.get(Number(roll.rollNo)) || [];
              const cnt = (st: string) => reels.filter((r) => r.status === st).length;
              const w = round6(reels.reduce((x, rl) => x + (Number(rl.weight) || 0), 0));
              return (
                <tr key={roll.id}>
                  <td><button className="agr-voucher-no" onClick={() => setDetailsRoll(roll)}>{roll.rollNo}</button></td>
                  <td className="num">{fmtDate(roll.date)}</td>
                  <td className="num">{roll.gram ? fmtNum(roll.gram) : '—'}</td>
                  <td className="num">{fmtNum(reels.length)}</td>
                  <td className="num">{fmtNum(w, 3)}</td>
                  <td>
                    <span className="agr-badge agr-badge-st-avail mr-1">{fmtNum(cnt('available'))} متاحة</span>
                    <span className="agr-badge agr-badge-st-disp mr-1">{fmtNum(cnt('dispatched'))} مصروفة</span>
                    <span className="agr-badge agr-badge-st-undef">{fmtNum(cnt('undefined'))} غير محددة</span>
                  </td>
                  <td><span className="agr-badge agr-badge-imported">{roll.source === 'excel' ? 'مستورد' : 'تسجيل بكر'}</span></td>
                  <td>
                    <div className="flex gap-1 justify-center">
                      <button className="agr-icon-btn" title="تفاصيل" onClick={() => setDetailsRoll(roll)}><Eye size={14} /></button>
                      <button className="agr-icon-btn" title="حذف" onClick={() => del(roll)}><Trash2 size={14} /></button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td>الإجمالي ({fmtNum(rows.length)} رول)</td>
              <td></td><td></td>
              <td className="num">{fmtNum(totReels)}</td>
              <td className="num">{fmtNum(totWeight, 3)}</td>
              <td></td><td></td><td></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <Pager page={page} pages={pages} onPage={setPage} />

      {detailsRoll && <RollDetails roll={detailsRoll} onClose={() => setDetailsRoll(null)} reels={reelsByRoll.get(Number(detailsRoll.rollNo)) || []} />}
    </div>
  );
}

function RollDetails({ roll, reels, onClose }: { roll: Roll; reels: Reel[]; onClose: () => void }) {
  const s = useAgrima();
  const [editReelRow, setEditReelRow] = useState<Reel | null>(null);
  const cnt = (st: string) => reels.filter((r) => r.status === st).length;
  const totalW = round6(reels.reduce((x, r) => x + (Number(r.weight) || 0), 0));
  const isImported = roll.source === 'excel';

  const doPrint = () => {
    usePrint.getState().open({
      kind: 'table',
      company: s.settings.companyName || 'إدارة المخزن',
      title: `تفاصيل رول ${roll.rollNo}`,
      subtitle: [`رقم الرول: ${roll.rollNo}`, `التاريخ: ${fmtDate(roll.date)}`, `الجرام: ${roll.gram ?? '—'}`],
      headers: ['رقم البكرة', 'المقاس', 'الوزن (كجم)', 'الجرام', 'الصنف', 'الحالة'],
      rows: reels.map((r) => [String(r.reelNo), String(r.size ?? '—'), fmtNum(r.weight, 3), String(r.gram ?? '—'), productFamily(r.quality || '') || '—', REEL_STATUS[r.status]]),
      totals: ['الإجمالي', `${fmtNum(reels.length)} بكرة`, fmtNum(totalW, 3), '', '', ''],
      signatures: ['أمين المخزن', 'المحاسب'],
    }, 'portrait');
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[88vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle>تفاصيل الرول {roll.rollNo}</DialogTitle>
        </DialogHeader>

        <div className="flex gap-2 flex-wrap text-[11px]">
          <span className="agr-badge agr-badge-multi">عدد البكر: {fmtNum(reels.length)}</span>
          <span className="agr-badge agr-badge-imported">إجمالي الوزن (كجم): {fmtNum(totalW, 3)}</span>
          <span className="agr-badge agr-badge-st-avail">متاحة: {fmtNum(cnt('available'))}</span>
          <span className="agr-badge agr-badge-st-disp">مصروفة: {fmtNum(cnt('dispatched'))}</span>
          <span className="agr-badge agr-badge-st-returned">مرجعة للمورد: {fmtNum(cnt('returned'))}</span>
          <span className="agr-badge agr-badge-st-undef">غير محددة: {fmtNum(cnt('undefined'))}</span>
        </div>

        {isImported && (
          <div className="text-[11px] bg-amber-50 border border-amber-200 text-amber-800 rounded p-2">
            بكر هذا الرول مستوردة من ملف «اجمالي المخزن 2025» — حالتها «غير محددة» ولا تدخل في حساب الرصيد
            (قاعدة منع مضاعفة المخزون). يمكن تصرفها كحركة كمية فقط.
          </div>
        )}

        <div className="agr-table-wrap">
          <table className="agr-table">
            <thead>
              <tr><th>رقم البكرة</th><th>المقاس</th><th>الوزن (كجم)</th><th>الجرام</th><th>الصنف</th><th>الحالة</th><th>إجراءات</th></tr>
            </thead>
            <tbody>
              {reels.length === 0 && <EmptyRow colSpan={7} text="لا توجد بكر في هذا الرول" />}
              {reels.map((r) => (
                <tr key={r.id}>
                  <td className="num">{r.reelNo}</td>
                  <td className="num">{r.size ?? '—'}</td>
                  <td className="num">{fmtNum(r.weight, 3)}</td>
                  <td className="num">{r.gram ? fmtNum(r.gram) : '—'}</td>
                  <td>{r.quality ? productFamily(r.quality) : '—'}</td>
                  <td>
                    <span className={`agr-badge agr-badge-st-${r.status === 'available' ? 'avail' : r.status === 'dispatched' ? 'disp' : r.status === 'returned' ? 'returned' : 'undef'}`}>
                      {REEL_STATUS[r.status]}
                    </span>
                    {r.status === 'dispatched' && r.permitRef && <div className="text-[10px] text-slate-400 mt-0.5">({r.permitRef.permitNo})</div>}
                  </td>
                  <td>
                    <div className="flex gap-1 justify-center">
                      <button
                        className="agr-icon-btn" title="تعديل"
                        disabled={r.status === 'dispatched' || r.status === 'returned'}
                        onClick={() => setEditReelRow(r)}
                      ><Pencil size={14} /></button>
                      <button
                        className="agr-icon-btn danger" title="حذف"
                        disabled={r.status === 'dispatched' || r.status === 'returned'}
                        onClick={async () => {
                          const ok = await confirmAction({
                            title: 'حذف بكرة', danger: true,
                            message: r.source === 'reels'
                              ? `سيتم حذف البكرة ${r.rollNo}/${r.reelNo} وحركة إنتاجها نهائيًا وتحديث الرصيد. متابعة؟`
                              : `سيتم حذف تفاصيل البكرة ${r.rollNo}/${r.reelNo} (لا يؤثر على الرصيد). متابعة؟`,
                            yesLabel: 'حذف',
                          });
                          if (!ok) return;
                          try {
                            await deleteReel(r, s.profile?.email);
                            await useAgrima.getState().refresh();
                            toast.success('تم الحذف');
                            onClose();
                          } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
                        }}
                      ><Trash2 size={14} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <DialogFooter className="flex-row gap-2">
          <button className="agr-btn agr-btn-primary" onClick={doPrint}><Printer size={14} /> طباعة تفاصيل الرول</button>
          <button className="agr-btn agr-btn-ghost" onClick={onClose}><X size={14} /> إغلاق</button>
        </DialogFooter>
      </DialogContent>

      {editReelRow && (
        <EditReelDialog
          reel={editReelRow}
          onClose={() => setEditReelRow(null)}
          onSaved={async () => { setEditReelRow(null); await useAgrima.getState().refresh(); toast.success('تم تعديل البكرة'); }}
        />
      )}
    </Dialog>
  );
}

function EditReelDialog({ reel, onClose, onSaved }: { reel: Reel; onClose: () => void; onSaved: () => void }) {
  const s = useAgrima();
  const [reelNo, setReelNo] = useState(String(reel.reelNo));
  const [size, setSize] = useState(String(reel.size ?? ''));
  const [weight, setWeight] = useState(String(reel.weight ?? ''));
  const [gram, setGram] = useState(String(reel.gram ?? ''));
  const [quality, setQuality] = useState(reel.quality || '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const families = useMemo(() => {
    const set = new Set(s.products.map((p) => p.quality));
    return Array.from(set);
  }, [s.products]);

  const save = async () => {
    setErr('');
    if (!reelNo || !size || !weight || !gram || !quality) { setErr('أكمل جميع الحقول'); return; }
    setBusy(true);
    try {
      await editReel(reel, {
        reelNo: Number(reelNo), size: Number(size), weight: Number(weight),
        gram: Number(gram), quality,
      }, s.profile?.email);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm" dir="rtl">
        <DialogHeader><DialogTitle>تعديل بكرة {reel.rollNo}/{reel.reelNo}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="agr-field"><span>رقم البكرة *</span><input type="number" min={1} value={reelNo} onChange={(e) => setReelNo(e.target.value)} /></label>
          <label className="agr-field"><span>المقاس *</span><input type="number" min={1} value={size} onChange={(e) => setSize(e.target.value)} /></label>
          <label className="agr-field"><span>الوزن (كجم) *</span><input type="number" min={0.001} step={0.001} value={weight} onChange={(e) => setWeight(e.target.value)} /></label>
          <label className="agr-field"><span>الجرام *</span><input type="number" min={1} value={gram} onChange={(e) => setGram(e.target.value)} /></label>
          <label className="agr-field"><span>الصنف *</span>
            <select value={quality} onChange={(e) => setQuality(e.target.value)}>
              {CANON_FAMILIES.map((f) => <option key={f} value={f}>{f}</option>)}
              {families.filter((f) => !CANON_FAMILIES.includes(f as never)).map((f) => <option key={f} value={f}>{f}</option>)}
              {quality && !families.includes(quality) && !CANON_FAMILIES.includes(quality as never) && <option value={quality}>{quality}</option>}
            </select>
          </label>
          {reel.source !== 'reels' && <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">التعديل لا يؤثر على الرصيد (بكرة مستوردة — تفاصيل فقط).</div>}
          {err && <div className="agr-form-error">{err}</div>}
        </div>
        <DialogFooter>
          <button className="agr-btn agr-btn-primary" disabled={busy} onClick={save}>{busy ? 'جارٍ الحفظ…' : 'حفظ'}</button>
          <button className="agr-btn agr-btn-ghost" onClick={onClose}>إلغاء</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
