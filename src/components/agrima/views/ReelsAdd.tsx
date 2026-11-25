'use client';

/* ReelsAdd — تسجيل البكر (مصدر الإنتاج الجديد) */

import { useEffect, useMemo, useState } from 'react';
import { useAgrima } from '@/lib/agrima/store';
import { nextRollNo, saveRollWithReels, type ReelInput } from '@/lib/agrima/tx';
import { round6 } from '@/lib/agrima/calc';
import { fmtNum, todayISO, CANON_FAMILIES } from '@/lib/agrima/utils';
import { PageHead } from '../ui-bits';
import { toast } from 'sonner';
import { can } from '@/lib/agrima/permissions';
import { Plus, X } from 'lucide-react';

interface ReelRow { reelNo: string; size: string; weight: string; gram: string; quality: string }

export default function ReelsAdd() {
  const s = useAgrima();
  const [rollNo, setRollNo] = useState('…');
  const [date, setDate] = useState(todayISO());
  const [gram, setGram] = useState('');
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState<ReelRow[]>([{ reelNo: '1', size: '', weight: '', gram: '', quality: '' }]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    nextRollNo().then((n) => setRollNo(String(n)));
  }, []);

  const knownGsms = useMemo(() => {
    const set = new Set<string>();
    for (const p of s.products) if (p.gsm != null) set.add(String(p.gsm));
    return Array.from(set).sort((a, b) => Number(a) - Number(b));
  }, [s.products]);

  const patch = (i: number, p: Partial<ReelRow>) => setRows((xs) => xs.map((x, xi) => (xi === i ? { ...x, ...p } : x)));

  const addRow = () => {
    const next = Math.max(0, ...rows.map((r) => Number(r.reelNo) || 0)) + 1;
    setRows((xs) => [...xs, { reelNo: String(next), size: '', weight: '', gram: gram || '', quality: gram ? '' : '' }]);
  };

  const complete = rows.filter((r) => Number(r.reelNo) > 0 && Number(r.size) > 0 && Number(r.weight) > 0 && Number(r.gram) > 0 && r.quality);
  const totalWeight = round6(complete.reduce((sm, r) => sm + Number(r.weight), 0));

  const save = async () => {
    setErr('');
    if (!can('add')) { toast.error('لا تملك صلاحية الإضافة'); return; }
    if (!date) { setErr('أكمل التاريخ'); return; }
    if (complete.length === 0) {
      setErr('أضف بكرة واحدة مكتملة على الأقل — الصفوف الناقصة لا تُحفظ (رقم، مقاس، وزن، جرام، صنف)');
      return;
    }
    const seen = new Set<number>();
    for (const r of complete) {
      if (seen.has(Number(r.reelNo))) { setErr(`رقم البكرة ${r.reelNo} مكرر داخل الرول.`); return; }
      seen.add(Number(r.reelNo));
    }
    setBusy(true);
    try {
      const reels: ReelInput[] = complete.map((r) => ({
        reelNo: Number(r.reelNo), size: Number(r.size), weight: Number(r.weight),
        gram: Number(r.gram), quality: r.quality,
      }));
      const res = await saveRollWithReels({ date, gram: gram ? Number(gram) : null, notes, reels }, s.profile?.email);
      await useAgrima.getState().refresh();
      toast.success(`تم تسجيل الرول ${res.rollNo} — ${res.reels} بكرة — أُنشئت حركات إنتاج وأضيفت للرصيد`);
      // reset form
      setRows([{ reelNo: '1', size: '', weight: '', gram: '', quality: '' }]);
      setGram(''); setNotes('');
      nextRollNo().then((n) => setRollNo(String(n)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHead title="تسجيل البكر — إضافة رول جديد" />
      <div className="agr-card mb-3 text-xs text-slate-600">
        تسجيل البكر هو مصدر الإنتاج الجديد: عند الحفظ تُنشأ حركة إنتاج تلقائية لكل بكرة وتضاف إلى الرصيد مباشرة —
        لا حاجة لأي شاشة إنتاج أخرى. رقم الرول تلقائي وغير قابل للتعديل.
      </div>

      <div className="agr-card mb-3">
        <div className="agr-form-grid">
          <label className="agr-field"><span>رقم الرول (تلقائي)</span>
            <input dir="ltr" value={rollNo} readOnly disabled />
          </label>
          <label className="agr-field"><span>التاريخ *</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="agr-field"><span>الجرام — جرام الرول (يُقترح لكل البكر)</span>
            <input type="number" min={1} list="gsm-list" placeholder="125" value={gram} onChange={(e) => setGram(e.target.value)} />
            <datalist id="gsm-list">{knownGsms.map((g) => <option key={g} value={g} />)}</datalist>
          </label>
          <label className="agr-field"><span>ملاحظات</span>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
        </div>
      </div>

      <div className="agr-card">
        <div className="flex items-center mb-2">
          <h3 className="font-extrabold text-sm">بكر الرول</h3>
          <button className="agr-btn agr-btn-ghost agr-btn-sm mr-auto" onClick={addRow}><Plus size={14} /> إضافة بكرة</button>
        </div>
        <div className="hidden md:grid agr-reel-grid font-bold text-xs text-slate-500 pb-1">
          <span>رقم البكرة</span><span>المقاس</span><span>الوزن (كجم)</span><span>الجرام</span><span>الصنف</span><span></span>
        </div>
        <div className="flex flex-col gap-2">
          {rows.map((r, i) => (
            <div key={i} className="grid md:agr-reel-grid grid-cols-2 gap-2 items-center">
              <input type="number" min={1} step={1} placeholder="1" value={r.reelNo} onChange={(e) => patch(i, { reelNo: e.target.value })} aria-label="رقم البكرة" />
              <input type="number" min={1} placeholder="100" value={r.size} onChange={(e) => patch(i, { size: e.target.value })} aria-label="المقاس" />
              <input type="number" min={0.001} step={0.001} placeholder="7.99" value={r.weight} onChange={(e) => patch(i, { weight: e.target.value })} aria-label="الوزن" />
              <input type="number" min={1} placeholder={gram || '125'} value={r.gram} onChange={(e) => patch(i, { gram: e.target.value })} aria-label="الجرام" />
              <select value={r.quality} onChange={(e) => patch(i, { quality: e.target.value })} aria-label="الصنف">
                <option value="">—</option>
                {CANON_FAMILIES.map((f) => <option key={f} value={f}>{f}</option>)}
                {!CANON_FAMILIES.includes(r.quality as never) && r.quality && <option value={r.quality}>{r.quality}</option>}
              </select>
              <button className="agr-icon-btn danger justify-self-center" title="إزالة السطر" onClick={() => setRows((xs) => xs.filter((_, xi) => xi !== i))}>
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
        <div className="text-xs font-bold text-slate-600 mt-3">
          عدد البكرات (تلقائي): {fmtNum(complete.length)} • إجمالي الوزن: {fmtNum(totalWeight, 3)} كجم
        </div>
        {err && <div className="agr-form-error">{err}</div>}
        <div className="mt-3">
          <button className="agr-btn agr-btn-primary" disabled={busy} onClick={save}>{busy ? 'جارٍ الحفظ…' : 'حفظ الرول والبكر'}</button>
        </div>
      </div>
    </div>
  );
}
