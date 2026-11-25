'use client';

/* Reservations — حجوزات العملاء: تتبع وتنظيم مستقل فقط (لا يمس المخزون) */

import { useEffect, useMemo, useState } from 'react';
import { useAgrima } from '@/lib/agrima/store';
import {
  computeAll, createReservation, updateReservation, addTransfer, cancelTransfer,
  cancelReservationQty, addLink, removeLink, loadResvStores, RESV_STATUS, ITEM_STATUS,
  type ReportRow, type ResvState, type ComputedAll,
} from '@/lib/agrima/resv';
import { collectVouchers } from '@/lib/agrima/tx';
import { round6 } from '@/lib/agrima/calc';
import { fmtNum, fmtDate, todayISO, productFamily, canonicalCustomer, CANON_FAMILIES } from '@/lib/agrima/utils';
import { PageHead, EmptyRow, Pager, confirmAction, Badge } from '../ui-bits';
import { toast } from 'sonner';
import { can } from '@/lib/agrima/permissions';
import { repo, db } from '@/lib/agrima/db';
import {
  Plus, Printer, ArrowLeftRight, Ban, Eye, Pencil, Link2, X, Search, FilePlus2, Trash2,
} from 'lucide-react';
import { ArrowRight } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { usePrint } from '../print/printStore';
import type { Reservation, ResvTransfer, ResvCancellation, ResvLink, Permit } from '@/lib/agrima/types';

const PAGE_SIZE = 100;

export default function Reservations() {
  const route = useAgrima((x) => x.route);
  if (route === 'reservation-form') return <ResvForm />;
  if (route === 'reservation-details') return <ResvDetails />;
  return <ResvList />;
}

/* ================================ LIST ================================ */

function ResvList() {
  const s = useAgrima();
  const [data, setData] = useState<ComputedAll | null>(null);
  const [q, setQ] = useState('');
  const [statusF, setStatusF] = useState('');
  const [page, setPage] = useState(0);
  const [picker, setPicker] = useState(false);
  const [pickerKeys, setPickerKeys] = useState<Set<string>>(new Set());

  const reload = async () => {
    const d = await computeAll(s.transactions, s.permits, s.balances, s.settings.weightFactor);
    setData(d);
  };

  useEffect(() => { reload();   }, [
    s.transactions, s.permits, s.balances, s.reservationsVersion,
  ]);

  const rows = useMemo(() => {
    if (!data) return [];
    let list = data.reportRows;
    if (q) {
      const t = q.toLowerCase();
      list = list.filter((r) =>
        r.customer.toLowerCase().includes(t)
        || r.quality.includes(q)
        || String(r.size) === q || String(r.gsm) === q
        || r.voucherNos.some((v) => v.toLowerCase().includes(t)));
    }
    if (statusF) {
      list = list.filter((r) => {
        const st = r.state.status;
        if (statusF === 'open') return st !== 'loaded' && st !== 'transferred';
        if (statusF === 'loaded') return st === 'loaded';
        if (statusF === 'transferred') return st === 'transferred';
        return true;
      });
    }
    return list;
  }, [data, q, statusF]);

  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const tQty = round6(rows.reduce((x, r) => x + r.qty, 0));
  const tAvail = round6(rows.reduce((x, r) => x + r.available, 0));
  const tLoaded = round6(rows.reduce((x, r) => x + r.loaded, 0));

  const goDetails = (reservationId: string) => {
    useAgrima.getState().setPendingReservationId(reservationId);
    useAgrima.getState().navigate('reservation-details' as never);
  };

  const editResv = async (reservationId: string) => {
    if (!can('edit')) { toast.error('لا تملك صلاحية التعديل'); return; }
    const { reservations } = await loadResvStores();
    const r = reservations.find((x) => x.id === reservationId);
    if (!r) return;
    useAgrima.getState().setPendingReservationId(reservationId);
    useAgrima.getState().navigate('reservation-form' as never);
  };

  const openTransfer = (r: ReportRow) => {
    if (!can('edit')) { toast.error('لا تملك صلاحية التعديل'); return; }
    setTransferModal({ itemId: r.itemId, reservationId: r.reservationId, suggestion: r });
  };

  const openCancel = (r: ReportRow) => {
    if (!can('edit')) { toast.error('لا تملك صلاحية التعديل'); return; }
    setCancelModal({ reservationId: r.reservationId, itemId: r.itemId, maxQty: r.qty, customer: r.customer });
  };

  const openLink = (r: ReportRow) => {
    if (!can('edit')) { toast.error('لا تملك صلاحية التعديل'); return; }
    setLinkModal({ itemId: r.itemId, reservationId: r.reservationId, matched: { quality: r.quality, gsm: r.gsm, size: r.size } });
  };

  /* print unified table */
  const printRows = (keys: string[] | null, title: string) => {
    const list = keys === null ? data?.reportRows || [] : (data?.reportRows || []).filter((r) => keys.includes(r.customer));
    const headers = ['اسم العميل', 'النوع', 'الجرام', 'المقاس', 'عدد البكر', 'المتاح', 'المحمّل'];
    const rowsA = list.map((r) => [r.customer, r.quality, String(r.gsm), String(r.size), fmtNum(r.qty), fmtNum(r.available), fmtNum(r.loaded)]);
    usePrint.getState().open({
      kind: 'table',
      company: 'شركة اجريماسترز للاستثمار والتنمية الزراعية',
      title,
      subtitle: ['كشف متابعة حجوزات البكر للعملاء', 'الحجوزات الملغاة بالكامل مستبعدة — الأرقام من أذون الصرف المعتمدة والمستوردة'],
      headers,
      rows: rowsA,
      totals: ['الإجمالي', `${fmtNum(list.length)} بند`, '', '', fmtNum(round6(list.reduce((x, r) => x + r.qty, 0))), fmtNum(round6(list.reduce((x, r) => x + r.available, 0))), fmtNum(round6(list.reduce((x, r) => x + r.loaded, 0)))],
      signatures: ['توقيع المسؤول', 'توقيع أمين المخزن'],
    }, 'portrait');
  };

  const customersForPicker = useMemo(() => {
    if (!data) return [];
    const map = new Map<string, { n: number; m: number }>();
    for (const r of data.reportRows) {
      const e = map.get(r.customer) || { n: 0, m: 0 };
      e.n++; e.m++;
      map.set(r.customer, e);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0], 'ar'));
  }, [data]);

  const [transferModal, setTransferModal] = useState<{ reservationId: string; itemId: string; suggestion?: ReportRow } | null>(null);
  const [cancelModal, setCancelModal] = useState<{ reservationId: string; itemId?: string; maxQty: number; customer: string } | null>(null);
  const [linkModal, setLinkModal] = useState<{ reservationId: string; itemId: string; matched?: { quality: string; gsm: number; size: number } } | null>(null);
  const [logModal, setLogModal] = useState<'transfers' | 'cancellations' | null>(null);

  return (
    <div>
      <PageHead title="حجوزات العملاء">
        <button className="agr-btn agr-btn-primary" onClick={() => { useAgrima.getState().setPendingReservationId(null); useAgrima.getState().navigate('reservation-form' as never); }}>
          <Plus size={15} /> حجز جديد
        </button>
        <button className="agr-btn agr-btn-ghost" onClick={() => setPicker(true)}><Printer size={15} /> طباعة كشف مجمّع</button>
        <button className="agr-btn agr-btn-ghost" onClick={() => printRows(null, 'كشف متابعة حجوزات البكر للعملاء')}><Printer size={15} /> طباعة</button>
        <button className="agr-btn agr-btn-ghost" onClick={() => setLogModal('transfers')}>سجل التحويلات</button>
        <button className="agr-btn agr-btn-ghost" onClick={() => setLogModal('cancellations')}>سجل الإلغاءات</button>
      </PageHead>

      <div className="agr-card mb-3 text-xs" style={{ borderInlineStart: '4px solid #0F766E' }}>
        <b>قسم حجوزات العملاء — نظام تتبع وتنظيم مستقل فقط.</b>
        <div className="text-slate-500 mt-1">
          لا يخصم أو يضيف من المخزون، ولا يعدل الإنتاج، ولا ينشئ أو يعدل أذون الصرف — الروابط مع أذون الصرف مرجعية للعرض فقط.
        </div>
      </div>

      {data && (
        <div className="agr-stats" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
          <MiniStat label="إجمالي الحجوزات" num={fmtNum(data.totals.reservations)} />
          <MiniStat label="البكر المطلوبة" num={fmtNum(data.totals.requested)} />
          <MiniStat label="متاح في المخزون" num={fmtNum(data.totals.available)} />
          <MiniStat label="بانتظار الإنتاج" num={fmtNum(data.totals.awaiting)} />
          <MiniStat label="محمّلة للعملاء" num={fmtNum(data.totals.loaded)} />
          <MiniStat label="محوّلة بين العملاء" num={fmtNum(data.totals.transferred)} />
          <MiniStat label="ملغاة" num={fmtNum(data.totals.cancelled)} />
        </div>
      )}

      <div className="agr-card filters mb-3">
        <label className="agr-fl"><span>بحث</span>
          <div className="relative">
            <Search size={14} className="absolute top-1/2 -translate-y-1/2 start-2 text-slate-400" />
            <input className="ps-7" placeholder="بحث: اسم العميل / المقاس / رقم إذن الصرف…" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
          </div>
        </label>
        <label className="agr-fl"><span>الحالة</span>
          <select value={statusF} onChange={(e) => { setStatusF(e.target.value); setPage(0); }}>
            <option value="">الكل</option>
            <option value="open">مفتوحة</option>
            <option value="loaded">مكتملة التحميل</option>
            <option value="transferred">محوّلة بالكامل</option>
          </select>
        </label>
        <button className="agr-btn agr-btn-ghost agr-btn-sm" onClick={() => { setQ(''); setStatusF(''); setPage(0); }}>مسح الفلاتر</button>
      </div>

      <div className="agr-table-wrap">
        <table className="agr-table resv-unified-table">
          <thead>
            <tr>
              <th>اسم العميل</th><th>النوع</th><th>الجرام</th><th>المقاس</th>
              <th>عدد البكر</th><th>المتاح</th><th>المحمّل</th><th>إجراءات</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 && <EmptyRow colSpan={8} text="لا توجد بنود حجوزات — ابدأ بـ«حجز جديد»" />}
            {pageRows.map((r) => (
              <tr key={r.itemId}>
                <td className="text-start">
                  <button className="agr-voucher-no" onClick={() => goDetails(r.reservationId)}>{r.customer}</button>
                  {r.voucherNos.length > 0 && <div className="text-[10px] text-slate-400" dir="ltr">أذون: {r.voucherNos.join('، ')}</div>}
                </td>
                <td>{r.quality}</td>
                <td className="num">{r.gsm}</td>
                <td className="num">{r.size}</td>
                <td className="num font-bold">{fmtNum(r.qty)}</td>
                <td className="num pos">{fmtNum(r.available)}</td>
                <td className="num neg">{fmtNum(r.loaded)}</td>
                <td>
                  <div className="flex gap-1 justify-center actions-cell">
                    <button className="agr-icon-btn" title="تفاصيل" onClick={() => goDetails(r.reservationId)}><Eye size={14} /></button>
                    <button className="agr-icon-btn" title="تحويل كمية لعميل آخر" onClick={() => openTransfer(r)}><ArrowLeftRight size={14} /></button>
                    <button className="agr-icon-btn danger" title="إلغاء كمية/حجز" onClick={() => openCancel(r)}><Ban size={14} /></button>
                    <button className="agr-icon-btn" title="تعديل" onClick={() => editResv(r.reservationId)}><Pencil size={14} /></button>
                    <button className="agr-icon-btn" title="ربط إذن صرف قائم (مرجعي فقط)" onClick={() => openLink(r)}><Link2 size={14} /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>الإجمالي ({fmtNum(rows.length)} بند)</td>
              <td></td><td></td><td></td>
              <td className="num">{fmtNum(tQty)}</td>
              <td className="num">{fmtNum(tAvail)}</td>
              <td className="num">{fmtNum(tLoaded)}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <Pager page={page} pages={pages} onPage={setPage} />

      {/* combined print picker */}
      <Dialog open={picker} onOpenChange={(o) => !o && setPicker(false)}>
        <DialogContent className="max-w-md" dir="rtl">
          <DialogHeader>
            <DialogTitle>اختيار العملاء للطباعة</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-slate-500">يُطبع الكشف المجمّع لجميع بنود حجوزات العملاء المحددين — الحجوزات الملغاة بالكامل مستبعدة.</p>
          <div className="flex gap-2">
            <button className="agr-btn agr-btn-ghost agr-btn-sm" onClick={() => setPickerKeys(new Set(customersForPicker.map(([c]) => c)))}>تحديد الكل</button>
            <button className="agr-btn agr-btn-ghost agr-btn-sm" onClick={() => setPickerKeys(new Set())}>إلغاء التحديد</button>
          </div>
          <div className="max-h-64 overflow-y-auto flex flex-col gap-1.5 py-2">
            {customersForPicker.map(([c, v]) => (
              <label key={c} className="flex items-center gap-2 text-xs border rounded p-1.5 bg-white">
                <input type="checkbox" className="w-4 h-4" checked={pickerKeys.has(c)}
                  onChange={(e) => {
                    const next = new Set(pickerKeys);
                    if (e.target.checked) next.add(c); else next.delete(c);
                    setPickerKeys(next);
                  }} />
                <span className="font-bold">{c}</span>
                <span className="text-slate-400 mr-auto">{v.n} بند</span>
              </label>
            ))}
            {customersForPicker.length === 0 && <div className="text-xs text-slate-500 py-2">لا توجد حجوزات نشطة متاحة للطباعة.</div>}
          </div>
          <DialogFooter>
            <button className="agr-btn agr-btn-primary" disabled={pickerKeys.size === 0}
              onClick={() => { setPicker(false); printRows(Array.from(pickerKeys), 'كشف متابعة حجوزات البكر للعملاء'); }}>
              طباعة المحدد
            </button>
            <button className="agr-btn agr-btn-ghost" onClick={() => setPicker(false)}>إلغاء</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {transferModal && <TransferModal spec={transferModal} onClose={() => setTransferModal(null)} onDone={reload} />}
      {cancelModal && <CancelModal spec={cancelModal} onClose={() => setCancelModal(null)} onDone={reload} />}
      {linkModal && <LinkModal spec={linkModal} onClose={() => setLinkModal(null)} onDone={reload} />}
      {logModal && <LogModal kind={logModal} onClose={() => setLogModal(null)} />}
    </div>
  );
}

function MiniStat({ label, num }: { label: string; num: string }) {
  return (
    <div className="agr-stat" style={{ padding: '9px 12px' }}>
      <div>
        <div className="agr-stat-num" style={{ fontSize: 16 }}>{num}</div>
        <div className="agr-stat-lbl">{label}</div>
      </div>
    </div>
  );
}

/* ================================ FORM ================================ */

function ResvForm() {
  const s = useAgrima();
  const editId = s.pendingReservationId;
  const [customer, setCustomer] = useState('');
  const [date, setDate] = useState(todayISO());
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<{ quality: string; gsm: string; size: string; qty: string }[]>([{ quality: '', gsm: '', size: '', qty: '' }]);
  const [locked, setLocked] = useState<Set<number>>(new Set());
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      if (!editId) { setLoaded(true); return; }
      const { reservations } = await loadResvStores();
      const r = reservations.find((x) => x.id === editId);
      if (r) {
        setCustomer(r.customer);
        setDate(r.date);
        setNotes(r.notes || '');
        setItems((r.items || []).map((i) => ({ quality: i.quality, gsm: String(i.gsm), size: String(i.size), qty: String(i.qtyRequired) })));
      }
      setLoaded(true);
    })();
  }, [editId]);

  const customerOptions = useMemo(() => {
    const set = new Set<string>();
    for (const t of s.transactions) {
      const cc = canonicalCustomer(t.customer);
      if (cc && cc !== 'الإنتاج') set.add(cc);
    }
    for (const c of s.customers) if (c.name) set.add(c.name);
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'ar'));
  }, [s.transactions, s.customers]);

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

  const save = async () => {
    setErr('');
    if (!can('add')) { toast.error('لا تملك صلاحية الإضافة'); return; }
    if (!customer.trim()) { setErr('اسم العميل مطلوب'); return; }
    if (!date) { setErr('تاريخ الحجز مطلوب'); return; }
    const parsed = items.map((i) => ({ quality: i.quality, gsm: Number(i.gsm), size: Number(i.size), qtyRequired: Number(i.qty) }));
    if (!parsed.some((i) => i.quality && i.gsm > 0 && i.size > 0 && i.qtyRequired > 0)) {
      setErr('أضف بندًا واحدًا مكتملًا على الأقل (صنف، جرام، مقاس، كمية)');
      return;
    }
    const seen = new Set<string>();
    for (const i of parsed) {
      if (!(i.quality && i.gsm > 0 && i.size > 0 && i.qtyRequired > 0)) continue;
      const k = `${i.quality}|${i.gsm}|${i.size}`;
      if (seen.has(k)) { setErr('نفس البند (صنف/جرام/مقاس) مكرر — يمكن تكرار المقاس بجرام أو صنف مختلف فقط'); return; }
      seen.add(k);
    }
    setBusy(true);
    try {
      if (editId) {
        const { reservations } = await loadResvStores();
        const r = reservations.find((x) => x.id === editId);
        if (!r) throw new Error('الحجز غير موجود');
        r.customer = customer.trim();
        r.date = date;
        r.notes = notes;
        r.items = parsed.filter((i) => i.quality && i.gsm > 0 && i.size > 0 && i.qtyRequired > 0)
          .map((i, idx) => ({ id: r.items?.[idx]?.id || 'itm_' + Math.random().toString(36).slice(2), quality: i.quality, gsm: i.gsm, size: i.size, qtyRequired: i.qtyRequired }));
        await updateReservation(r, s.profile?.email);
        toast.success('تم حفظ تعديلات الحجز');
        useAgrima.getState().setPendingReservationId(r.id);
        useAgrima.getState().navigate('reservation-details' as never);
      } else {
        const r = await createReservation({ customer, date, notes, items: parsed.filter((i) => i.quality && i.gsm > 0 && i.size > 0 && i.qtyRequired > 0) }, s.profile?.email);
        toast.success(`تم إنشاء الحجز ${r.seq} للعميل ${r.customer}`);
        useAgrima.getState().setPendingReservationId(r.id);
        useAgrima.getState().navigate('reservation-details' as never);
      }
      useAgrima.getState().bumpReservations();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!loaded) return <div className="agr-card">جارٍ التحميل…</div>;

  return (
    <div>
      <PageHead title={editId ? 'تعديل حجز' : 'حجز جديد'}>
        <button className="agr-btn agr-btn-ghost" onClick={() => useAgrima.getState().navigate('reservations' as never)}><ArrowRight size={15} /> رجوع</button>
      </PageHead>
      <div className="agr-card mb-3">
        <div className="agr-form-grid">
          <label className="agr-field"><span>اسم العميل *</span>
            <input list="resv-cust" value={customer} onChange={(e) => setCustomer(e.target.value)} />
            <datalist id="resv-cust">{customerOptions.map((c) => <option key={c} value={c} />)}</datalist>
          </label>
          <label className="agr-field"><span>تاريخ الحجز *</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="agr-field"><span>ملاحظات</span>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
        </div>
      </div>
      <div className="agr-card">
        <div className="flex items-center mb-2">
          <h3 className="font-extrabold text-sm">بنود الحجز — يمكن تكرار المقاس بجرام أو صنف مختلف</h3>
          <button className="agr-btn agr-btn-ghost agr-btn-sm mr-auto" onClick={() => setItems((xs) => [...xs, { quality: '', gsm: '', size: '', qty: '' }])}>
            <FilePlus2 size={14} /> إضافة بند
          </button>
        </div>
        <div className="flex flex-col gap-2">
          {items.map((it, i) => {
            const est = Number(it.size) > 0 && Number(it.qty) > 0
              ? (Number(it.size) * Number(it.qty) * (s.settings.weightFactor || 7.5)) : 0;
            return (
              <div key={i} className="grid grid-cols-2 md:grid-cols-5 gap-2 items-end border-b pb-2">
                <label className="agr-field"><span>الصنف *</span>
                  <select value={it.quality} onChange={(e) => setItems((xs) => xs.map((x, xi) => xi === i ? { ...x, quality: e.target.value } : x))}>
                    <option value="">—</option>
                    {familyOptions.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                </label>
                <label className="agr-field"><span>الجرام *</span>
                  <input type="number" min={1} list="resv-gsm" value={it.gsm} onChange={(e) => setItems((xs) => xs.map((x, xi) => xi === i ? { ...x, gsm: e.target.value } : x))} />
                </label>
                <label className="agr-field"><span>المقاس *</span>
                  <input type="number" min={1} value={it.size} onChange={(e) => setItems((xs) => xs.map((x, xi) => xi === i ? { ...x, size: e.target.value } : x))} />
                </label>
                <label className="agr-field"><span>الكمية المطلوبة (بكر) *</span>
                  <input type="number" min={1} value={it.qty} onChange={(e) => setItems((xs) => xs.map((x, xi) => xi === i ? { ...x, qty: e.target.value } : x))} />
                </label>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-slate-500">≈ {fmtNum(est, 2)} كجم تقديري</span>
                  {locked.has(i) && <Badge tone="agr-badge-multi">مثبّت</Badge>}
                  <button className="agr-icon-btn danger" title="إزالة البند"
                    onClick={() => setItems((xs) => xs.length > 1 ? xs.filter((_, xi) => xi !== i) : xs)}>
                    <X size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <datalist id="resv-gsm">{knownGsms.map((g) => <option key={g} value={g} />)}</datalist>
        {err && <div className="agr-form-error">{err}</div>}
        <div className="mt-3 flex gap-2">
          <button className="agr-btn agr-btn-primary" disabled={busy} onClick={save}>{busy ? 'جارٍ الحفظ…' : 'حفظ الحجز'}</button>
          <button className="agr-btn agr-btn-ghost" onClick={() => useAgrima.getState().navigate('reservations' as never)}>إلغاء</button>
        </div>
      </div>
    </div>
  );
}

/* ============================== DETAILS ============================== */

function ResvDetails() {
  const s = useAgrima();
  const id = s.pendingReservationId;
  const [data, setData] = useState<ComputedAll | null>(null);
  const [state, setState] = useState<ResvState | null>(null);
  const [links, setLinks] = useState<ResvLink[]>([]);
  const [cancellations, setCancellations] = useState<ResvCancellation[]>([]);
  const [transferModal, setTransferModal] = useState<{ itemId: string } | null>(null);
  const [cancelModal, setCancelModal] = useState<{ itemId?: string; maxQty: number } | null>(null);
  const [linkModal, setLinkModal] = useState<{ itemId: string } | null>(null);

  const reload = async () => {
    const d = await computeAll(s.transactions, s.permits, s.balances, s.settings.weightFactor);
    setData(d);
    const st = d.states.find((x) => x.reservation.id === id) || null;
    setState(st);
    const stores = await loadResvStores();
    setLinks(stores.links.filter((l) => l.reservationId === id));
    setCancellations(stores.cancellations.filter((c) => c.reservationId === id));
  };

  useEffect(() => { reload();   }, [s.transactions, s.permits, s.balances, s.reservationsVersion, id]);

  if (!state) return <div className="agr-card">جارٍ التحميل…</div>;
  const r = state.reservation;

  return (
    <div>
      <PageHead title={`تفاصيل الحجز ${r.seq} — ${r.customer}`}>
        <button className="agr-btn agr-btn-ghost" onClick={() => useAgrima.getState().navigate('reservations' as never)}>رجوع للحجوزات</button>
        <button className="agr-btn agr-btn-primary" onClick={() => { useAgrima.getState().setPendingReservationId(r.id); useAgrima.getState().navigate('reservation-form' as never); }}>
          <Pencil size={15} /> تعديل الحجز
        </button>
      </PageHead>

      <div className="agr-grid-2 mb-3">
        <div className="agr-card text-xs"><b>العميل:</b> {r.customer}</div>
        <div className="agr-card text-xs"><b>تاريخ الحجز:</b> {fmtDate(r.date)} — <b>الحالة:</b> <Badge tone={state.status === 'open' ? 'agr-badge-warn' : state.status === 'cancelled' ? 'agr-badge-void' : 'agr-badge-approved'}>{RESV_STATUS[state.status]}</Badge> {r.notes && <>— <b>ملاحظات:</b> {r.notes}</>}</div>
      </div>

      <div className="agr-stats" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
        <MiniStat label="المطلوبة أصلًا" num={fmtNum(state.requested)} />
        <MiniStat label="متاح في المخزون" num={fmtNum(state.available)} />
        <MiniStat label="بانتظار" num={fmtNum(state.awaiting)} />
        <MiniStat label="محمّلة (من أذون مرتبطة)" num={fmtNum(state.loaded)} />
        <MiniStat label="تحميل محوّل لعملاء آخرين" num={fmtNum(state.loadedTransferred)} />
        <MiniStat label="محوّلة لعملاء آخرين" num={fmtNum(state.transferred)} />
        <MiniStat label="ملغاة" num={fmtNum(state.cancelled)} />
        <MiniStat label="المتبقية للعميل" num={fmtNum(state.remaining)} />
        <MiniStat label="الوزن التقديري (كجم)" num={fmtNum(state.items.reduce((x, i) => x + i.estWeightTotal, 0), 2)} />
      </div>

      {state.receivedViaTransfers > 0 && (
        <div className="agr-card mb-3 text-xs text-slate-600">
          مستلم عبر تحويلات من حجوزات عملاء آخرين (عرض مستقل — لا يُدمج مع المطلوب): <b>{fmtNum(state.receivedViaTransfers)} بكرة</b>
        </div>
      )}

      <div className="agr-table-wrap">
        <table className="agr-table">
          <thead>
            <tr>
              <th>الصنف</th><th>الجرام</th><th>المقاس</th><th>المطلوبة</th><th>متاح الآن</th>
              <th>بانتظار</th><th>محمّلة</th><th>تحميل المحوّل</th><th>محوّلة</th><th>ملغاة</th>
              <th>المتبقي</th><th>الوزن التقديري</th><th>الحالة</th><th>إجراءات</th>
            </tr>
          </thead>
          <tbody>
            {state.items.map((it) => (
              <tr key={it.item.id}>
                <td>{it.item.quality}</td>
                <td className="num">{it.item.gsm}</td>
                <td className="num">{it.item.size}</td>
                <td className="num font-bold">{fmtNum(it.required)}</td>
                <td className="num pos">{fmtNum(it.available)}</td>
                <td className="num">{fmtNum(it.awaiting)}</td>
                <td className="num neg">{fmtNum(it.loaded)}</td>
                <td className="num">{fmtNum(it.loadedTransferred)}</td>
                <td className="num">{fmtNum(it.transferred)}</td>
                <td className="num">{fmtNum(it.cancelled)}</td>
                <td className="num font-bold">{fmtNum(it.remaining)}</td>
                <td className="num">{fmtNum(it.estWeightTotal, 2)} كجم</td>
                <td>
                  <Badge tone={it.status === 'received' || it.status === 'available' ? 'agr-badge-approved' : it.status === 'loaded' ? 'agr-badge-st-disp' : 'agr-badge-warn'}>
                    {ITEM_STATUS[it.status]}{it.partial ? ' (جزئيًا)' : ''}
                  </Badge>
                </td>
                <td>
                  <div className="flex gap-1 justify-center">
                    {it.remaining > 0 && !r.cancelled && (
                      <>
                        <button className="agr-icon-btn" title="تحويل كمية لعميل آخر" onClick={() => setTransferModal({ itemId: it.item.id })}><ArrowLeftRight size={14} /></button>
                        <button className="agr-icon-btn" title="ربط إذن صرف قائم (مرجعي فقط)" onClick={() => setLinkModal({ itemId: it.item.id })}><Link2 size={14} /></button>
                        <button className="agr-icon-btn danger" title="إلغاء كمية" onClick={() => setCancelModal({ itemId: it.item.id, maxQty: it.remaining })}><Ban size={14} /></button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="agr-grid-2 mt-3">
        <div>
          <h3 className="font-extrabold text-sm mb-2">التحويلات</h3>
          <TransfersInOut reservationId={r.id} onReload={reload} />
        </div>
        <div>
          <h3 className="font-extrabold text-sm mb-2">أذون الصرف المرتبطة (مرجعية)</h3>
          <LinksTable links={links} onReload={reload} />
        </div>
      </div>

      <div className="mt-3">
        <h3 className="font-extrabold text-sm mb-2">الإلغاءات</h3>
        <div className="agr-table-wrap">
          <table className="agr-table">
            <thead><tr><th>التاريخ</th><th>الصنف</th><th>الجرام</th><th>المقاس</th><th>الكمية الملغاة</th><th>النطاق</th><th>السبب</th></tr></thead>
            <tbody>
              {cancellations.length === 0 && <EmptyRow colSpan={7} text="لا توجد إلغاءات" />}
              {cancellations.map((c) => (
                <tr key={c.id}>
                  <td className="num">{fmtDate(c.date)}</td>
                  <td>{c.quality}</td>
                  <td className="num">{c.gsm}</td>
                  <td className="num">{c.size}</td>
                  <td className="num">{fmtNum(c.qty)}</td>
                  <td>{c.level === 'reservation' ? 'حجز كامل' : c.level === 'item' ? 'بند كامل' : 'جزء من بند'}</td>
                  <td>{c.reason || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {transferModal && <TransferModal spec={{ reservationId: r.id, itemId: transferModal.itemId }} onClose={() => setTransferModal(null)} onDone={reload} />}
      {cancelModal && <CancelModal spec={{ reservationId: r.id, itemId: cancelModal.itemId, maxQty: cancelModal.maxQty, customer: r.customer }} onClose={() => setCancelModal(null)} onDone={reload} />}
      {linkModal && <LinkModal spec={{ reservationId: r.id, itemId: linkModal.itemId }} onClose={() => setLinkModal(null)} onDone={reload} />}
    </div>
  );
}

function TransfersInOut({ reservationId, onReload }: { reservationId: string; onReload: () => void }) {
  const [rows, setRows] = useState<ResvTransfer[]>([]);
  useEffect(() => {
    loadResvStores().then(({ transfers }) => {
      setRows(transfers.filter((t) => t.fromReservationId === reservationId || t.toCustomer));
    });
  }, [reservationId]);
  const s = useAgrima();
  const list = rows.filter((t) => t.fromReservationId === reservationId);
  const inbound = rows.filter((t) => t.toCustomer && t.fromReservationId !== reservationId && false);
  void inbound;
  const all = [...list];
  return (
    <div className="agr-table-wrap">
      <table className="agr-table">
        <thead><tr><th>التاريخ</th><th>الاتجاه</th><th>الطرف الآخر</th><th>الصنف</th><th>الجرام</th><th>المقاس</th><th>الكمية</th><th>الحالة</th><th></th></tr></thead>
        <tbody>
          {all.length === 0 && <EmptyRow colSpan={9} text="لا توجد تحويلات" />}
          {all.map((t) => (
            <tr key={t.id}>
              <td className="num">{fmtDate(t.date)}</td>
              <td>محوّل إلى</td>
              <td>{t.toCustomer}</td>
              <td>{t.quality}</td>
              <td className="num">{t.gsm}</td>
              <td className="num">{t.size}</td>
              <td className="num">{fmtNum(t.qty)}</td>
              <td>{t.status === 'active' ? <Badge tone="agr-badge-approved">ساري</Badge> : <Badge tone="agr-badge-void">ملغي</Badge>}</td>
              <td>
                {t.status === 'active' && (
                  <button className="agr-icon-btn danger" title="إلغاء التحويل" onClick={async () => {
                    const ok = await confirmAction({ title: 'إلغاء التحويل', danger: true, message: `إلغاء تحويل ${t.qty} بكرة إلى ${t.toCustomer}؟ (سجل التحويل يبقى محفوظًا)`, yesLabel: 'إلغاء التحويل' });
                    if (!ok) return;
                    await cancelTransfer(t.id, s.profile?.email);
                    toast.success('تم إلغاء التحويل');
                    onReload();
                  }}><Ban size={14} /></button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LinksTable({ links, onReload }: { links: ResvLink[]; onReload: () => void }) {
  const s = useAgrima();
  const permits = s.permits;
  return (
    <div className="agr-table-wrap">
      <table className="agr-table">
        <thead><tr><th>رقم الإذن</th><th>تاريخه</th><th>العميل المسجل في الإذن</th><th>المقاس / الجرام المحمّل</th><th>كمية الإذن</th><th>المحسوب على الحجز</th><th>نوع الربط</th><th>الحالة</th><th></th></tr></thead>
        <tbody>
          {links.length === 0 && <EmptyRow colSpan={9} text="لا توجد روابط" />}
          {links.map((l) => {
            const exists = l.voucherKind === 'permit' ? permits.some((p: Permit) => p.id === l.voucherPermitId) : true;
            return (
              <tr key={l.id}>
                <td className="num" dir="ltr">{l.voucherNo}</td>
                <td className="num">{fmtDate(l.voucherDate)}</td>
                <td>{l.voucherCustomer}</td>
                <td className="num">{l.matched.size} / {l.matched.gsm}</td>
                <td className="num">{fmtNum(l.lineQty)}</td>
                <td className="num font-bold">{fmtNum(l.loadedQty)}</td>
                <td>{l.covers === 'transfer' ? 'تحميل كمية محوّلة' : 'تغطية متبقي البند'}</td>
                <td>{exists ? <Badge tone="agr-badge-approved">ساري</Badge> : <Badge tone="agr-badge-void">الإذن لم يعد موجودًا — خرج من الإجماليات</Badge>}</td>
                <td>
                  <button className="agr-icon-btn danger" title="إلغاء الربط (الإذن نفسه لن يُعدل ولا يُحذف)" onClick={async () => {
                    await removeLink(l.id, s.profile?.email);
                    toast.success('تم إلغاء الربط — الإذن نفسه لم يُعدل');
                    onReload();
                  }}><X size={14} /></button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ============================== MODALS ============================== */

function TransferModal({ spec, onClose, onDone }: { spec: { reservationId: string; itemId: string; suggestion?: ReportRow }; onClose: () => void; onDone: () => void }) {
  const s = useAgrima();
  const [data, setData] = useState<ComputedAll | null>(null);
  const [toCustomer, setToCustomer] = useState('');
  const [qty, setQty] = useState('');
  const [date, setDate] = useState(todayISO());
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    computeAll(s.transactions, s.permits, s.balances, s.settings.weightFactor).then(setData);
     
  }, []);

  const st = data?.states.find((x) => x.reservation.id === spec.reservationId);
  const item = st?.items.find((i) => i.item.id === spec.itemId);
  const customerOptions = useMemo(() => {
    const set = new Set<string>();
    for (const t of s.transactions) {
      const cc = canonicalCustomer(t.customer);
      if (cc && cc !== 'الإنتاج') set.add(cc);
    }
    for (const c of s.customers) if (c.name) set.add(c.name);
    if (st) set.add(st.reservation.customer);
    return Array.from(set);
  }, [s.transactions, s.customers, st]);

  const save = async () => {
    setErr('');
    try {
      if (!toCustomer.trim()) throw new Error('اختر العميل المستلم');
      await addTransfer({
        fromReservationId: spec.reservationId, itemId: spec.itemId,
        qty: Number(qty), toCustomer, date, notes,
      }, s.profile?.email);
      toast.success('تم تسجيل التحويل (تتبع فقط — لا تأثير على المخزون)');
      useAgrima.getState().bumpReservations();
      onDone();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  if (!st || !item) return null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md" dir="rtl">
        <DialogHeader><DialogTitle>تحويل كمية لعميل آخر</DialogTitle></DialogHeader>
        <div className="text-xs bg-slate-50 border rounded p-2">
          الحجز المصدر: <b>{st.reservation.seq} — {st.reservation.customer}</b> • البند: <b>{item.item.quality} / {item.item.gsm} / {item.item.size}</b>
          <div className="mt-1">المطلوب {fmtNum(item.required)} • محمّل {fmtNum(item.loaded)} • محوّل سابقًا {fmtNum(item.transferred)} • ملغى {fmtNum(item.cancelled)} • المتبقي القابل للتحويل <b>{fmtNum(item.remaining)}</b></div>
        </div>
        <div className="agr-form-grid">
          <label className="agr-field"><span>العميل المستلم *</span>
            <input list="trf-cust" value={toCustomer} onChange={(e) => setToCustomer(e.target.value)} />
            <datalist id="trf-cust">{customerOptions.filter((c) => c !== st.reservation.customer).map((c) => <option key={c} value={c} />)}</datalist>
          </label>
          <label className="agr-field"><span>الكمية المحوّلة (بكر) *</span>
            <input type="number" min={1} max={item.remaining} value={qty} onChange={(e) => setQty(e.target.value)} />
          </label>
          <label className="agr-field"><span>التاريخ *</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label className="agr-field"><span>ملاحظات</span><input value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
        </div>
        {err && <div className="agr-form-error">{err}</div>}
        <DialogFooter>
          <button className="agr-btn agr-btn-primary" onClick={save}>تسجيل التحويل</button>
          <button className="agr-btn agr-btn-ghost" onClick={onClose}>إلغاء</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CancelModal({ spec, onClose, onDone }: { spec: { reservationId: string; itemId?: string; maxQty: number; customer: string }; onClose: () => void; onDone: () => void }) {
  const s = useAgrima();
  const [qty, setQty] = useState(String(spec.maxQty));
  const [date, setDate] = useState(todayISO());
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const save = async () => {
    setErr('');
    try {
      if (!(Number(qty) > 0)) throw new Error('أدخل الكمية الملغاة');
      if (Number(qty) > spec.maxQty) throw new Error('لا يمكن إلغاء كميات تم تحميلها فعليًا — الحد الأقصى هو الكمية المتبقية');
      await cancelReservationQty({
        reservationId: spec.reservationId, itemId: spec.itemId,
        qty: Number(qty), date, reason,
      }, s.profile?.email);
      toast.success('تم تسجيل الإلغاء (تتبع فقط — لا تأثير على المخزون)');
      useAgrima.getState().bumpReservations();
      onDone();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm" dir="rtl">
        <DialogHeader><DialogTitle>إلغاء كمية/حجز</DialogTitle></DialogHeader>
        <div className="text-xs bg-slate-50 border rounded p-2">
          الحجز: <b>{spec.customer}</b> — الحد الأقصى للإلغاء (المتبقي): <b>{fmtNum(spec.maxQty)}</b> بكرة.
          لا يمكن إلغاء كميات تم تحميلها فعليًا.
        </div>
        <div className="agr-form-grid">
          <label className="agr-field"><span>الكمية الملغاة (بكر) *</span>
            <input type="number" min={1} max={spec.maxQty} value={qty} onChange={(e) => setQty(e.target.value)} />
          </label>
          <label className="agr-field"><span>التاريخ *</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label className="agr-field"><span>سبب الإلغاء (اختياري)</span><input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        </div>
        {err && <div className="agr-form-error">{err}</div>}
        <DialogFooter>
          <button className="agr-btn agr-btn-danger" onClick={save}>تأكيد الإلغاء</button>
          <button className="agr-btn agr-btn-ghost" onClick={onClose}>إلغاء</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LinkModal({ spec, onClose, onDone }: { spec: { reservationId: string; itemId: string; matched?: { quality: string; gsm: number; size: number } }; onClose: () => void; onDone: () => void }) {
  const s = useAgrima();
  const vouchers = useMemo(() => collectVouchers(s.transactions, s.permits)
    .filter((v) => v.status !== 'draft')
    .sort((a, b) => b.date.localeCompare(a.date)), [s.transactions, s.permits]);
  const draftsCount = useMemo(() => collectVouchers(s.transactions, s.permits).filter((v) => v.status === 'draft').length, [s.transactions, s.permits]);
  const [voucherKey, setVoucherKey] = useState('');
  const [lineIndex, setLineIndex] = useState('');
  const [qty, setQty] = useState('');
  const [err, setErr] = useState('');
  const [data, setData] = useState<ComputedAll | null>(null);

  useEffect(() => {
    computeAll(s.transactions, s.permits, s.balances, s.settings.weightFactor).then(setData);
     
  }, []);

  const voucher = vouchers.find((v) => v.key === voucherKey) || null;
  const line = voucher ? voucher.lines[Number(lineIndex)] : null;

  const consumed = useMemo(() => {
    // linkable = line.qty - previously consumed on that line by other links
    const map = new Map<string, number>();
    (async () => {
      const { links: resvLinks } = await loadResvStores();
      for (const l of resvLinks) {
        const k = `${l.voucherKey}::${l.lineIndex}`;
        map.set(k, (map.get(k) || 0) + (l.loadedQty || 0));
      }
    })();
    return map;
  }, [voucherKey]);

  const linkable = line ? Math.max(0, line.qty - (consumed.get(`${voucherKey}::${lineIndex}`) || 0)) : 0;

  const save = async () => {
    setErr('');
    try {
      if (!voucher || lineIndex === '' || !line) throw new Error('اختر الإذن والسطر');
      if (!(Number(qty) > 0)) throw new Error('أدخل كمية التحميل');
      if (Number(qty) > linkable) throw new Error('ممنوع عدّ كمية الصرف نفسها مرتين — المتاح للربط أقل من المطلوب');
      await addLink({
        reservationId: spec.reservationId, itemId: spec.itemId,
        voucher, lineIndex: Number(lineIndex), loadedQty: Number(qty),
        covers: 'remaining',
      }, s.profile?.email);
      toast.success('تم ربط الإذن (مرجعي فقط — الإذن نفسه لم يُعدل)');
      useAgrima.getState().bumpReservations();
      onDone();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg" dir="rtl">
        <DialogHeader><DialogTitle>ربط إذن صرف قائم (مرجعي فقط)</DialogTitle></DialogHeader>
        {draftsCount > 0 && (
          <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
            ملاحظة: {draftsCount} مسودة إذن غير معتمدة لن تظهر هنا لأنها لم تُصرف من المخزون بعد.
          </div>
        )}
        <div className="agr-form-grid">
          <label className="agr-field"><span>إذن الصرف *</span>
            <select value={voucherKey} onChange={(e) => { setVoucherKey(e.target.value); setLineIndex(''); }}>
              <option value="">— اختر الإذن —</option>
              {vouchers.map((v) => (
                <option key={v.key} value={v.key}>
                  {v.permitNo || '(بدون رقم)'} — {v.customer} — {fmtDate(v.date)} {v.cls ? `(${CLS_LABEL_SHORT[v.cls]})` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="agr-field"><span>سطر الإذن *</span>
            <select value={lineIndex} onChange={(e) => setLineIndex(e.target.value)} disabled={!voucher}>
              <option value="">—</option>
              {voucher?.lines.map((l, i) => (
                <option key={i} value={String(i)}>{l.family} / {l.gsm} / مقاس {l.size} — كمية {l.qty}</option>
              ))}
            </select>
          </label>
          <label className="agr-field"><span>الكمية المحمّلة على الحجز *</span>
            <input type="number" min={1} max={linkable} value={qty} onChange={(e) => setQty(e.target.value)} disabled={!line} />
          </label>
        </div>
        {line && (
          <div className="text-xs bg-slate-50 border rounded p-2">
            كمية الإذن: <b>{fmtNum(line.qty)}</b> • محسوب سابقًا: <b>{fmtNum(consumed.get(`${voucherKey}::${lineIndex}`) || 0)}</b> • المتاح للربط: <b>{fmtNum(linkable)}</b>
          </div>
        )}
        {err && <div className="agr-form-error">{err}</div>}
        <DialogFooter>
          <button className="agr-btn agr-btn-primary" onClick={save} disabled={!line}>ربط</button>
          <button className="agr-btn agr-btn-ghost" onClick={onClose}>إلغاء</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const CLS_LABEL_SHORT: Record<string, string> = { 'ض': 'ضريبي', 'غ': 'غير ضريبي' };

function LogModal({ kind, onClose }: { kind: 'transfers' | 'cancellations'; onClose: () => void }) {
  const [transfers, setTransfers] = useState<ResvTransfer[]>([]);
  const [cancellations, setCancellations] = useState<ResvCancellation[]>([]);
  useEffect(() => {
    loadResvStores().then(({ transfers: t, cancellations: c }) => { setTransfers(t); setCancellations(c); });
  }, []);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle>{kind === 'transfers' ? 'سجل التحويلات بين العملاء' : 'سجل الإلغاءات'}</DialogTitle>
        </DialogHeader>
        {kind === 'transfers' ? (
          <div className="agr-table-wrap">
            <table className="agr-table">
              <thead><tr><th>التاريخ</th><th>من حجز</th><th>العميل المصدر</th><th>العميل المستلم</th><th>الصنف</th><th>الجرام</th><th>المقاس</th><th>الكمية</th><th>الحالة</th></tr></thead>
              <tbody>
                {transfers.length === 0 && <EmptyRow colSpan={9} text="لا توجد تحويلات" />}
                {[...transfers].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((t) => (
                  <tr key={t.id}>
                    <td className="num">{fmtDate(t.date)}</td>
                    <td className="num">{t.fromReservationSeq}</td>
                    <td>{t.fromCustomer}</td>
                    <td>{t.toCustomer}</td>
                    <td>{t.quality}</td>
                    <td className="num">{t.gsm}</td>
                    <td className="num">{t.size}</td>
                    <td className="num">{fmtNum(t.qty)}</td>
                    <td>{t.status === 'active' ? <Badge tone="agr-badge-approved">ساري</Badge> : <Badge tone="agr-badge-void">ملغي</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="agr-table-wrap">
            <table className="agr-table">
              <thead><tr><th>التاريخ</th><th>الحجز</th><th>العميل</th><th>الصنف</th><th>الجرام</th><th>المقاس</th><th>الكمية</th><th>النطاق</th><th>السبب</th></tr></thead>
              <tbody>
                {cancellations.length === 0 && <EmptyRow colSpan={9} text="لا توجد إلغاءات" />}
                {[...cancellations].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((c) => (
                  <tr key={c.id}>
                    <td className="num">{fmtDate(c.date)}</td>
                    <td className="num">{c.reservationSeq}</td>
                    <td>{c.customer}</td>
                    <td>{c.quality}</td>
                    <td className="num">{c.gsm}</td>
                    <td className="num">{c.size}</td>
                    <td className="num">{fmtNum(c.qty)}</td>
                    <td>{c.level === 'reservation' ? 'حجز كامل' : c.level === 'item' ? 'بند كامل' : 'جزء من بند'}</td>
                    <td>{c.reason || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <DialogFooter>
          <button className="agr-btn agr-btn-ghost" onClick={onClose}>إغلاق</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ============================== CUSTOMERS ============================== */

export function CustomersView() {
  const s = useAgrima();
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<{ id?: number; name: string; notes: string } | null>(null);
  const [err, setErr] = useState('');

  const vouchers = useMemo(() => collectVouchers(s.transactions, s.permits), [s.transactions, s.permits]);
  const rows = useMemo(() => {
    const map = new Map<string, { permits: number; out: number; source: string }>();
    for (const v of vouchers) {
      const c = canonicalCustomer(v.customer);
      if (!c || c === 'الإنتاج') continue;
      const e = map.get(c) || { permits: 0, out: 0, source: 'من الحركات' };
      e.permits++;
      e.out += v.totalRolls;
      if (v.kind === 'permit') e.source = 'محفوظ';
      map.set(c, e);
    }
    for (const c of s.customers) {
      if (!map.has(c.name)) map.set(c.name, { permits: 0, out: 0, source: c.source === 'history' ? 'من الحركات' : 'محفوظ' });
    }
    let list = Array.from(map.entries()).map(([name, v]) => ({ name, ...v }));
    if (q) list = list.filter((r) => r.name.includes(q));
    list.sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    return list;
  }, [vouchers, s.customers, q]);

  const save = async () => {
    if (!edit) return;
    setErr('');
    const name = edit.name.trim();
    if (!name) { setErr('اسم العميل مطلوب'); return; }
    if (s.customers.some((c) => c.name === name && c.id !== edit.id)) { setErr('العميل موجود بالفعل'); return; }
    if (edit.id != null) {
      const old = await db.get<{ name: string; notes: string; source?: string }>('customers', edit.id);
      await db.put('customers', { name, notes: edit.notes, source: old?.source || 'manual' });
      await db.logAudit({ entity: 'customer', action: 'edit', entityId: String(edit.id), details: `تعديل عميل: ${name}`, actor: s.profile?.email });
    } else {
      await db.add('customers', { name, notes: edit.notes, source: 'manual', createdAt: new Date().toISOString() });
      await db.logAudit({ entity: 'customer', action: 'add', entityId: name, details: `إضافة عميل: ${name}`, actor: s.profile?.email });
    }
    setEdit(null);
    await useAgrima.getState().refresh();
    toast.success('تم الحفظ');
  };

  const del = async (c: { id?: number; name: string }) => {
    const hasPermits = vouchers.some((v) => canonicalCustomer(v.customer) === c.name);
    if (hasPermits) { toast.error('لا يمكن حذف عميل له حركات صرف محفوظة'); return; }
    const ok = await confirmAction({ title: 'حذف العميل', danger: true, message: `حذف العميل "${c.name}"؟`, yesLabel: 'حذف' });
    if (!ok || c.id == null) return;
    await db.del('customers', c.id);
    await db.logAudit({ entity: 'customer', action: 'delete', entityId: String(c.id), details: `حذف عميل: ${c.name}`, actor: s.profile?.email });
    await useAgrima.getState().refresh();
    toast.success('تم الحذف');
  };

  return (
    <div>
      <PageHead title="العملاء">
        <button className="agr-btn agr-btn-primary" onClick={() => setEdit({ name: '', notes: '' })}><Plus size={15} /> عميل جديد</button>
      </PageHead>
      <div className="agr-card filters mb-3">
        <label className="agr-fl"><span>بحث</span>
          <div className="relative">
            <Search size={14} className="absolute top-1/2 -translate-y-1/2 start-2 text-slate-400" />
            <input className="ps-7" placeholder="بحث باسم العميل…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </label>
        <button className="agr-btn agr-btn-ghost agr-btn-sm" onClick={() => setQ('')}>مسح الفلاتر</button>
      </div>
      <div className="agr-table-wrap">
        <table className="agr-table">
          <thead><tr><th>اسم العميل</th><th>عدد الأذون</th><th>إجمالي الصرف (بكر)</th><th>المصدر</th><th>إجراءات</th></tr></thead>
          <tbody>
            {rows.length === 0 && <EmptyRow colSpan={5} text="لا يوجد عملاء" />}
            {rows.map((r) => {
              const saved = s.customers.find((c) => c.name === r.name);
              return (
                <tr key={r.name}>
                  <td className="text-start font-bold">{r.name}</td>
                  <td className="num">{fmtNum(r.permits)}</td>
                  <td className="num neg">{fmtNum(r.out)}</td>
                  <td><Badge tone="agr-badge-imported">{r.source}</Badge></td>
                  <td>
                    <div className="flex gap-1 justify-center">
                      <button className="agr-icon-btn" title="تعديل" onClick={() => setEdit({ id: saved?.id, name: r.name, notes: saved?.notes || '' })}><Pencil size={14} /></button>
                      <button className="agr-icon-btn danger" title="حذف" onClick={() => del({ id: saved?.id, name: r.name })}><Trash2 size={14} /></button>
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
          <DialogHeader><DialogTitle>{edit?.id ? 'تعديل عميل' : 'عميل جديد'}</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-3">
            <label className="agr-field"><span>اسم العميل *</span>
              <input value={edit?.name || ''} onChange={(e) => setEdit((x) => x && { ...x, name: e.target.value })} />
            </label>
            <label className="agr-field"><span>ملاحظات</span>
              <input value={edit?.notes || ''} onChange={(e) => setEdit((x) => x && { ...x, notes: e.target.value })} />
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
