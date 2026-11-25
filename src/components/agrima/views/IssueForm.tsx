'use client';

/* IssueForm — إذن صرف مخزني: إنشاء / تعديل مسودة / تعديل معتمد (إعادة اعتماد)
   ترتيب الأعمدة المعتمد: العدد، المقاس، الجرام، الصنف */

import { useEffect, useMemo, useState } from 'react';
import { useAgrima } from '@/lib/agrima/store';
import {
  validatePermit, savePermitDraft, updatePermitDraft, approvePermit, replacePermit,
  findAvailableReels, nextDocNumbers, CLS_LABEL,
} from '@/lib/agrima/tx';
import { db } from '@/lib/agrima/db';
import { productWeight, round6 } from '@/lib/agrima/calc';
import { fmtNum, todayISO, productFamily, canonicalCustomer, CANON_FAMILIES } from '@/lib/agrima/utils';
import { PageHead } from '../ui-bits';
import { toast } from 'sonner';
import { can, isWarehouse } from '@/lib/agrima/permissions';
import { Plus, Trash2, Loader2 } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import type { Permit, PermitCls, PermitLine, Reel, Voucher } from '@/lib/agrima/types';

interface LineUI {
  quality: string;
  gsm: string;
  size: string;
  qty: string;
  weight: string;
  reelIds: string[];
  reelWeightKg: number | null;
}

export default function IssueForm() {
  const s = useAgrima();
  const keeper = isWarehouse();

  const editing = s.pendingEdit; // null | {kind:'permit',permit} | {kind:'legacy',voucher}
  const [date, setDate] = useState(todayISO());
  const [customer, setCustomer] = useState('');
  const [cls, setCls] = useState<PermitCls>('ض');
  const [docNo, setDocNo] = useState('');
  const [docNoDirty, setDocNoDirty] = useState(false);
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineUI[]>([{ quality: '', gsm: '', size: '', qty: '', weight: '', reelIds: [], reelWeightKg: null }]);
  const [seqInfo, setSeqInfo] = useState<{ tax: number; nontax: number } | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [picker, setPicker] = useState<number | null>(null);
  const [availableReels, setAvailableReels] = useState<Reel[]>([]);
  const [pickCount, setPickCount] = useState('');

  useEffect(() => {
    if (keeper) return;
    nextDocNumbers().then((n) => setSeqInfo(n));
  }, [keeper]);

  /* hydrate from pendingEdit */
  useEffect(() => {
    if (!editing) return;
    if (editing.kind === 'permit' && editing.permit) {
      const p = editing.permit;
      setDate(p.date);
      setCustomer(p.customer);
      setCls(p.cls as PermitCls);
      setDocNo(p.permitNo);
      setDocNoDirty(true);
      setNotes(p.notes || '');
      setLines(p.lines.map((l: PermitLine) => ({
        quality: l.quality, gsm: String(l.gsm), size: String(l.size), qty: String(l.qty),
        weight: l.weight != null ? String(l.weight) : '',
        reelIds: l.reelIds || [],
        reelWeightKg: l.weightKg ?? null,
      })));
    } else if (editing.kind === 'legacy' && editing.voucher) {
      const v = editing.voucher;
      setDate(v.date);
      setCustomer(v.customer);
      setCls((v.cls || 'ض') as PermitCls);
      setDocNo(v.permitNo || '');
      setDocNoDirty(true);
      setNotes(v.notes || '');
      setLines(v.lines.map((l) => ({
        quality: l.quality, gsm: String(l.gsm), size: String(l.size), qty: String(l.qty),
        weight: l.weight != null ? String(l.weight) : '',
        reelIds: [], reelWeightKg: null,
      })));
    }
  }, [editing]);

  /* doc number suggestion */
  useEffect(() => {
    if (!seqInfo || docNoDirty) return;
    setDocNo(String(cls === 'ض' ? seqInfo.tax : seqInfo.nontax));
  }, [cls, seqInfo, docNoDirty]);

  const customerOptions = useMemo(() => {
    const set = new Set<string>();
    for (const t of s.transactions) {
      const cc = canonicalCustomer(t.customer);
      if (cc && cc !== 'الإنتاج') set.add(cc);
    }
    for (const p of s.permits) if (p.customer) set.add(canonicalCustomer(p.customer));
    for (const c of s.customers) if (c.name) set.add(c.name);
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'ar'));
  }, [s.transactions, s.permits, s.customers]);

  const familyOptions = useMemo(() => {
    const set = new Set<string>();
    for (const p of s.products) set.add(productFamily(p.quality));
    return [...CANON_FAMILIES.filter((f) => set.has(f)), ...Array.from(set).filter((f) => !CANON_FAMILIES.includes(f as never))];
  }, [s.products]);

  const knownGsms = useMemo(() => {
    const set = new Set<string>();
    for (const p of s.products) if (p.gsm != null) set.add(String(p.gsm));
    return Array.from(set).sort((a, b) => Number(a) - Number(b));
  }, [s.products]);

  const patchLine = (i: number, p: Partial<LineUI>) => setLines((xs) => xs.map((x, xi) => (xi === i ? { ...x, ...p } : x)));

  const addLine = () => setLines((xs) => [...xs, { quality: '', gsm: '', size: '', qty: '', weight: '', reelIds: [], reelWeightKg: null }]);

  const removeLine = (i: number) => {
    setLines((xs) => {
      if (xs.length === 1) return [{ quality: '', gsm: '', size: '', qty: '', weight: '', reelIds: [], reelWeightKg: null }];
      return xs.filter((_, xi) => xi !== i);
    });
  };

  const balanceOfCombo = (quality: string, gsm: string, size: string) => {
    if (!quality || !gsm || !size) return null;
    for (const b of s.balances.values()) {
      if (b.quality === quality && String(b.gsm) === String(Number(gsm)) && String(b.size) === String(Number(size))) return b;
    }
    return null;
  };

  /* totals hint */
  const totals = useMemo(() => {
    let actualW = 0, recordedW = 0, estLines = 0, rolls = 0;
    for (const l of lines) {
      const qty = Number(l.qty) || 0;
      rolls += qty;
      if (l.reelIds.length > 0 && l.reelWeightKg != null) actualW += l.reelWeightKg;
      else if (Number(l.weight) > 0) recordedW += Number(l.weight) * qty;
      else estLines += qty;
    }
    const estW = Math.round(estLines * 7.5 * 1000) / 1000;
    return { actualW: round6(actualW), recordedW: round6(recordedW), estW: round6(estW), estLines, rolls };
  }, [lines]);

  /* ---- reel picker ---- */
  const openPicker = async (i: number) => {
    const l = lines[i];
    if (!l.quality || !(Number(l.gsm) > 0) || !(Number(l.size) > 0)) {
      toast.error('أكمل الصنف والجرام والمقاس أولًا لعرض البكر المتاحة');
      return;
    }
    const reels = await findAvailableReels(l.quality, Number(l.gsm), Number(l.size));
    setAvailableReels(reels);
    setPickCount('');
    setPicker(i);
  };

  const applyPick = () => {
    if (picker == null) return;
    const n = Number(pickCount) || 0;
    const chosen = availableReels.slice(0, n);
    const w = round6(chosen.reduce((sm, r) => sm + (Number(r.weight) || 0), 0));
    patchLine(picker, { reelIds: chosen.map((r) => r.id), reelWeightKg: chosen.length ? w : null, qty: chosen.length ? String(chosen.length) : '' });
    setPicker(null);
  };

  /* ---- save / approve ---- */
  const buildPermit = (permitId?: string): Omit<Permit, 'id' | 'status' | 'createdAt' | 'permitKey'> | Permit => {
    const plines: PermitLine[] = lines
      .filter((l) => l.quality && Number(l.gsm) > 0 && Number(l.size) > 0 && Number(l.qty) > 0)
      .map((l) => ({
        quality: l.quality, gsm: Number(l.gsm), size: Number(l.size), qty: Number(l.qty),
        weight: Number(l.weight) > 0 ? Number(l.weight) : null,
        reelIds: l.reelIds,
        weightKg: l.reelIds.length > 0 ? l.reelWeightKg : null,
      }));
    const base = {
      permitNo: docNo.trim(), cls, customer: customer.trim(), date, notes,
      lines: plines, source: 'permit' as const,
      groupId: editing?.kind === 'permit' ? 'P:' + editing.permit!.id : null,
      approvedAt: null,
      totals: null,
    };
    if (permitId) return { ...(editing!.permit as Permit), ...base, id: permitId } as Permit;
    return base;
  };

  const validate = (): string[] => {
    const p = buildPermit() as Permit;
    return validatePermit(p);
  };

  const doApprove = async () => {
    setErr('');
    if (!can('add') && !can('approve')) { toast.error('لا تملك صلاحية إنشاء أو اعتماد أذون الصرف'); return; }
    const errs = validate();
    if (errs.length) { setErr(errs[0]); return; }
    setBusy('approve');
    try {
      let permitId: string;
      if (editing?.kind === 'permit' && editing.permit) {
        const updated = buildPermit(editing.permit.id) as Permit;
        if (updated.status === 'approved' && editing.permit.status === 'approved') {
          const res = await replacePermit(updated, s.profile?.email);
          permitId = res.id;
        } else {
          await updatePermitDraft({ ...updated, status: 'draft' }, s.profile?.email);
          const res = await approvePermit(updated.id, s.profile?.email);
          permitId = res.id;
        }
      } else {
        permitId = await savePermitDraft(buildPermit() as Omit<Permit, 'id' | 'status' | 'createdAt' | 'permitKey'>, s.profile?.email);
        try {
          await approvePermit(permitId, s.profile?.email);
        } catch (e) {
          /* the draft is already saved — switch the form to edit-draft mode so
             a retry updates it instead of creating a duplicate-number draft */
          const draft = await db.get<Permit>('permits', permitId);
          if (draft) useAgrima.getState().setPendingEdit({ kind: 'permit', permit: draft });
          throw e;
        }
      }
      await useAgrima.getState().refresh();
      toast.success(`تم اعتماد الإذن ${docNo} وخصم ${fmtNum(totals.rolls)} بكرة من الرصيد`);
      useAgrima.getState().setPendingEdit(null);
      useAgrima.getState().navigate('issuedocs' as never);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const doDraft = async () => {
    setErr('');
    if (editing?.kind === 'legacy') {
      setErr('الأذون المستوردة تُحفظ مباشرة (كالوضع القديم) — استخدم زر الاعتماد/الحفظ.');
      return;
    }
    const errs = validate();
    if (errs.length) { setErr(errs[0]); return; }
    setBusy('draft');
    try {
      if (editing?.kind === 'permit' && editing.permit) {
        const updated = buildPermit(editing.permit.id) as Permit;
        if (editing.permit.status === 'approved') {
          await replacePermit(updated, s.profile?.email);
        } else {
          await updatePermitDraft({ ...updated, status: 'draft' }, s.profile?.email);
        }
      } else {
        await savePermitDraft(buildPermit() as Omit<Permit, 'id' | 'status' | 'createdAt' | 'permitKey'>, s.profile?.email);
      }
      await useAgrima.getState().refresh();
      toast.success('تم حفظ المسودة (بدون خصم من الرصيد)');
      useAgrima.getState().setPendingEdit(null);
      useAgrima.getState().navigate('issuedocs' as never);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  if (keeper) {
    return (
      <div>
        <PageHead title="إذن صرف مخزني" />
        <div className="agr-card text-sm font-bold text-red-700" style={{ borderInlineStart: '4px solid #DC2626' }}>
          لا تملك صلاحية إنشاء أو تعديل أذون الصرف — صلاحياتك للعرض والطباعة فقط. انتقل إلى «أذون الصرف» لعرض أذون اليوم والأمس وطباعتها.
        </div>
      </div>
    );
  }

  const isLegacy = editing?.kind === 'legacy';
  const approvedPermit = editing?.kind === 'permit' && editing.permit?.status === 'approved';

  return (
    <div>
      <PageHead title={approvedPermit ? 'تعديل إذن معتمد (سيُعاد الاعتماد)' : isLegacy ? 'تحويل إذن مستورد إلى إذن نظام' : editing?.kind === 'permit' ? 'تعديل مسودة إذن' : 'إذن صرف جديد'} />

      <div className="agr-card mb-3">
        <div className="agr-form-grid">
          <label className="agr-field"><span>التاريخ *</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label className="agr-field"><span>العميل / الجهة *</span>
            <input list="cust-list" value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="اختر أو اكتب اسم العميل" />
            <datalist id="cust-list">{customerOptions.map((c) => <option key={c} value={c} />)}</datalist>
          </label>
          <label className="agr-field"><span>التصنيف *</span>
            <div className="agr-seg">
              <button type="button" className={cls === 'ض' ? 'active' : ''} onClick={() => { setCls('ض'); setDocNoDirty(false); }}>ضريبي</button>
              <button type="button" className={cls === 'غ' ? 'active' : ''} onClick={() => { setCls('غ'); setDocNoDirty(false); }}>غير ضريبي</button>
            </div>
          </label>
          <label className="agr-field"><span>رقم الإذن * (يُقترح تلقائيًا — يمكن تعديله)</span>
            <input dir="ltr" value={docNo} onChange={(e) => { setDocNo(e.target.value); setDocNoDirty(true); }} />
          </label>
          <label className="agr-field"><span>ملاحظات</span><input value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
        </div>
      </div>

      <div className="agr-card">
        <div className="flex items-center mb-2 flex-wrap gap-2">
          <h3 className="font-extrabold text-sm">تفاصيل الصرف — ترتيب الأعمدة: العدد، المقاس، الجرام، الصنف</h3>
          <button className="agr-btn agr-btn-ghost agr-btn-sm mr-auto" onClick={addLine}><Plus size={14} /> إضافة سطر</button>
        </div>

        <div className="flex flex-col gap-3">
          {lines.map((l, i) => {
            const bal = balanceOfCombo(l.quality, l.gsm, l.size);
            const over = bal && Number(l.qty) > bal.net && l.reelIds.length === 0;
            return (
              <div key={i} className="border rounded-lg p-3 bg-slate-50/60">
                <div className="agr-form-grid">
                  <label className="agr-field"><span>العدد (عدد البكر) *</span>
                    <input type="number" min={1} value={l.reelIds.length > 0 ? String(l.reelIds.length) : l.qty}
                      readOnly={l.reelIds.length > 0}
                      onChange={(e) => patchLine(i, { qty: e.target.value })} />
                  </label>
                  <label className="agr-field"><span>المقاس *</span>
                    <input type="number" min={1} value={l.size} onChange={(e) => patchLine(i, { size: e.target.value, reelIds: [], reelWeightKg: null })} />
                  </label>
                  <label className="agr-field"><span>الجرام *</span>
                    <input type="number" min={1} list="gsm-list2" value={l.gsm} onChange={(e) => patchLine(i, { gsm: e.target.value, reelIds: [], reelWeightKg: null })} />
                  </label>
                  <label className="agr-field"><span>اسم الصنف *</span>
                    <select value={l.quality} onChange={(e) => patchLine(i, { quality: e.target.value, reelIds: [], reelWeightKg: null })}>
                      <option value="">—</option>
                      {familyOptions.map((f) => <option key={f} value={f}>{f}</option>)}
                    </select>
                  </label>
                  <label className="agr-field"><span>وزن بكرة (اختياري — يُستخدم إن لم تحدد بكر)</span>
                    <input type="number" step="0.001" min={0} value={l.weight} onChange={(e) => patchLine(i, { weight: e.target.value })} />
                  </label>
                </div>
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  <button className="agr-btn agr-btn-ghost agr-btn-sm" onClick={() => openPicker(i)}>تحديد البكر من المخزون</button>
                  <button className="agr-btn agr-btn-ghost agr-btn-sm" onClick={() => removeLine(i)}><Trash2 size={13} /> حذف السطر</button>
                  <span className="text-[11px] font-bold text-slate-500">
                    {l.reelIds.length > 0 && l.reelWeightKg != null
                      ? `بكر محددة: ${l.reelIds.length} — الوزن الفعلي: ${fmtNum(l.reelWeightKg, 3)} كجم`
                      : bal
                        ? <>المتاح: {fmtNum(bal.net)}{over && <b className="text-red-600"> — الكمية أكبر من المتاح</b>}</>
                        : null}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="text-xs font-bold text-slate-600 mt-3 bg-teal-50 border border-teal-100 rounded-lg p-2">
          إجمالي البكر: {fmtNum(totals.rolls)} بكرة • الوزن الإجمالي: {fmtNum(round6(totals.actualW + totals.recordedW), 3)} كجم
          {totals.estLines > 0 && <> + تقديري {fmtNum(totals.estW, 3)} كجم لـ {fmtNum(totals.estLines)} بكرة بلا وزن مسجل</>}
        </div>
        {err && <div className="agr-form-error">{err}</div>}

        <div className="flex gap-2 mt-3 flex-wrap">
          <button className="agr-btn agr-btn-primary" disabled={!!busy} onClick={doApprove}>
            {busy === 'approve' ? <Loader2 size={15} className="animate-spin" /> : null}
            {approvedPermit ? 'حفظ التعديل وإعادة الاعتماد' : 'اعتماد الإذن وخصم الكميات'}
          </button>
          {!approvedPermit && (
            <button className="agr-btn agr-btn-ghost" disabled={!!busy} onClick={doDraft}>
              {busy === 'draft' ? 'جارٍ الحفظ…' : 'حفظ كمسودة (بدون خصم)'}
            </button>
          )}
          <button className="agr-btn agr-btn-ghost" onClick={() => { useAgrima.getState().setPendingEdit(null); useAgrima.getState().navigate('issuedocs' as never); }}>
            إلغاء
          </button>
        </div>
      </div>

      <datalist id="gsm-list2">{knownGsms.map((g) => <option key={g} value={g} />)}</datalist>

      {/* reel picker dialog */}
      <Dialog open={picker != null} onOpenChange={(o) => !o && setPicker(null)}>
        <DialogContent className="max-w-md" dir="rtl">
          <DialogHeader><DialogTitle>البكر المتاحة ({fmtNum(availableReels.length)})</DialogTitle></DialogHeader>
          <p className="text-xs text-slate-500">حدد البكر لصرفها بأوزانها الفعلية — العدد يُحسب تلقائيًا.</p>
          <div className="max-h-64 overflow-y-auto flex flex-col gap-1.5">
            {availableReels.length === 0 && (
              <div className="text-xs text-slate-500 py-3">
                لا توجد بكر متاحة (متتبعة) لهذا الصنف/الجرام/المقاس — يمكنك الصرف كحركة كمية بدون تحديد بكر.
              </div>
            )}
            {availableReels.map((r) => (
              <label key={r.id} className="flex items-center gap-2 text-xs border rounded p-1.5 bg-white">
                <input
                  type="checkbox"
                  className="w-4 h-4"
                  checked={(lines[picker || 0]?.reelIds || []).includes(r.id)}
                  onChange={(e) => {
                    const cur = lines[picker || 0]?.reelIds || [];
                    const next = e.target.checked ? [...cur, r.id] : cur.filter((x) => x !== r.id);
                    const chosen = availableReels.filter((x) => next.includes(x.id));
                    const w = round6(chosen.reduce((sm, x) => sm + (Number(x.weight) || 0), 0));
                    patchLine(picker || 0, { reelIds: next, reelWeightKg: chosen.length ? w : null, qty: chosen.length ? String(chosen.length) : '' });
                  }}
                />
                <span dir="ltr" className="font-bold">{r.rollNo}/{r.reelNo}</span>
                <span className="text-slate-500">مقاس {r.size} — {fmtNum(r.weight, 3)} كجم — {r.gram} جرام</span>
              </label>
            ))}
          </div>
          <DialogFooter className="flex-row gap-2">
            <label className="agr-field flex-1"><span>عدد البكر المطلوبة</span>
              <input type="number" min={1} max={availableReels.length} value={pickCount} onChange={(e) => setPickCount(e.target.value)} />
            </label>
            <button className="agr-btn agr-btn-primary agr-btn-sm self-end" onClick={applyPick} disabled={availableReels.length === 0}>تحديد أول</button>
            <button className="agr-btn agr-btn-ghost agr-btn-sm self-end" onClick={() => { if (picker != null) patchLine(picker, { reelIds: [], reelWeightKg: null }); setPicker(null); }}>إلغاء التحديد</button>
            <button className="agr-btn agr-btn-ghost agr-btn-sm self-end" onClick={() => setPicker(null)}>إغلاق</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
