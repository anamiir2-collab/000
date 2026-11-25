'use client';

/* Reports — 9 report types with print + excel, zero-hide post-pass */

import { useMemo, useState } from 'react';
import { useAgrima } from '@/lib/agrima/store';
import { computeBalances, openingBalance, productWeight, round6, sameCombo } from '@/lib/agrima/calc';
import { collectVouchers, CLS_LABEL, REEL_STATUS } from '@/lib/agrima/tx';
import { fmtNum, fmtDate, productFamily, canonicalCustomer, CANON_FAMILIES } from '@/lib/agrima/utils';
import { PageHead, EmptyRow } from '../ui-bits';
import { exportReportAOA } from '@/lib/agrima/excel';
import { repo } from '@/lib/agrima/db';
import { toast } from 'sonner';
import { Printer } from 'lucide-react';
import { usePrint } from '../print/printStore';
import type { Roll, Reel, Voucher } from '@/lib/agrima/types';

type ReportId = 'warehouse' | 'balance' | 'rolls' | 'additions' | 'withdrawals' | 'issuedocs' | 'product' | 'customer' | 'period';

const REPORTS: { id: ReportId; icon: string; name: string }[] = [
  { id: 'warehouse', icon: '📦', name: 'التقرير' },
  { id: 'balance', icon: '📊', name: 'تقرير الرصيد الحالي' },
  { id: 'rolls', icon: '🔄', name: 'تقرير الرولات والبكر' },
  { id: 'additions', icon: '➕', name: 'تقرير حركة الإضافات' },
  { id: 'withdrawals', icon: '➖', name: 'تقرير حركة الصرف' },
  { id: 'issuedocs', icon: '🧾', name: 'تقرير أذون الصرف' },
  { id: 'product', icon: '📋', name: 'تقرير حركة صنف معين' },
  { id: 'customer', icon: '👤', name: 'تقرير حركة عميل معين' },
  { id: 'period', icon: '🗓', name: 'تقرير حركة المخزن خلال فترة محددة' },
];

interface ReportModel {
  title: string;
  subtitle: string[];
  obLine?: string[];
  summary?: string[];
  headers: string[];
  rows: string[][];
  totals: string[] | null;
  orientation: 'portrait' | 'landscape';
  excelName: string;
}

function hideZeros(rows: string[][]): string[][] {
  return rows.map((r) => r.map((c) => {
    const s = String(c ?? '').replace(/,/g, '').trim();
    if (/^[-+]?0+(\.0+)?$/.test(s)) return '';
    return c;
  }));
}

export default function Reports() {
  const s = useAgrima();
  const [report, setReport] = useState<ReportId>('warehouse');
  const [model, setModel] = useState<ReportModel | null>(null);
  const [screenRows, setScreenRows] = useState<string[][]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [product, setProduct] = useState('');
  const [gsm, setGsm] = useState('');
  const [size, setSize] = useState('');
  const [pgsm, setPgsm] = useState('');
  const [psize, setPsize] = useState('');
  const [customer, setCustomer] = useState('');
  const [type, setType] = useState('');
  const [rollst, setRollst] = useState('');
  const [cls, setCls] = useState('');
  const [rollsData, setRollsData] = useState<{ rolls: Roll[]; reels: Reel[] } | null>(null);

  const families = useMemo(() => {
    const set = new Set(s.products.map((p) => productFamily(p.quality)));
    return CANON_FAMILIES.filter((f) => set.has(f));
  }, [s.products]);
  const allGsms = useMemo(() => Array.from(new Set(s.products.map((p) => String(p.gsm)))).sort((a, b) => Number(a) - Number(b)), [s.products]);
  const allSizes = useMemo(() => Array.from(new Set(s.products.map((p) => String(p.size)))).sort((a, b) => Number(a) - Number(b)), [s.products]);
  const productGsms = useMemo(() => {
    if (!product) return [];
    return Array.from(new Set(s.products.filter((p) => productFamily(p.quality) === product).map((p) => String(p.gsm)))).sort((a, b) => Number(a) - Number(b));
  }, [s.products, product]);
  const productSizes = useMemo(() => {
    if (!product || !pgsm) return [];
    return Array.from(new Set(s.products.filter((p) => productFamily(p.quality) === product && String(p.gsm) === pgsm).map((p) => String(p.size)))).sort((a, b) => Number(a) - Number(b));
  }, [s.products, product, pgsm]);
  const customers = useMemo(() => {
    const set = new Set<string>();
    for (const t of s.transactions) {
      const c = canonicalCustomer(t.customer);
      if (c && c !== 'الإنتاج') set.add(c);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'ar'));
  }, [s.transactions]);

  const needs = {
    warehouse: ['product', 'gsm', 'size', 'asof'],
    balance: ['product', 'gsm', 'size'],
    rolls: ['product', 'gsm', 'rollst'],
    additions: ['from', 'to', 'product', 'gsm', 'size', 'customer'],
    withdrawals: ['from', 'to', 'product', 'gsm', 'size', 'customer'],
    issuedocs: ['from', 'to', 'cls'],
    product: ['from', 'to', 'productCombo'],
    customer: ['from', 'to', 'customer'],
    period: ['from', 'to', 'product', 'gsm', 'size', 'customer', 'type'],
  } as Record<ReportId, string[]>;

  const filterCombo = (r: { quality: string; gsm: unknown; size: unknown }) => {
    if (product && productFamily(r.quality) !== product) return false;
    if (gsm && String(r.gsm) !== gsm) return false;
    if (size && String(r.size) !== size) return false;
    return true;
  };
  const filterCustomer = (r: { customer: string }) => !customer || canonicalCustomer(r.customer) === customer;
  const filterPeriod = (r: { date: string }) =>
    (!from || r.date >= from) && (!to || r.date <= to);

  const build = async (): Promise<ReportModel | null> => {
    const wf = s.settings.weightFactor;
    const company = s.settings.companyName || 'إدارة المخزن';
    const tx = s.transactions.filter((t) => !t.void);

    if (report === 'product') {
      if (!product || !pgsm || !psize) {
        toast.error('اختر الصنف والجرام والمقاس أولًا');
        return null;
      }
      const q = product, g = Number(pgsm), sz = Number(psize);
      const comboTx = tx.filter((t) => sameCombo(t, q, g, sz))
        .sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.id || 0) - (b.id || 0));
      const opening = from ? openingBalance(tx, q, g, sz, from) : 0;
      let run = opening;
      let pAdd = 0, pOut = 0;
      const rows: string[][] = [];
      for (const t of comboTx) {
        if (!filterPeriod(t)) continue;
        const add = Number(t.addQty) || 0;
        const out = Number(t.outQty) || 0;
        pAdd += add; pOut += out;
        run = round6(run + add - out);
        rows.push([fmtDate(t.date), canonicalCustomer(t.customer), t.permitNo || '—', fmtNum(add), fmtNum(out), fmtNum(run), t.settlement || '']);
      }
      const closing = run;
      return {
        title: 'تقرير حركة صنف معين',
        subtitle: [`اسم الصنف: ${q} — الجرام: ${g} — المقاس: ${sz}`, from || to ? `من تاريخ: ${from ? fmtDate(from) : '—'} إلى تاريخ: ${to ? fmtDate(to) : '—'}` : 'كل الحركات'],
        obLine: [`الرصيد الافتتاحي: ${fmtNum(opening)}`, `إجمالي الإضافات في الفترة: ${fmtNum(round6(pAdd))}`, `إجمالي الصرف في الفترة: ${fmtNum(round6(pOut))}`, `الرصيد الختامي: ${fmtNum(closing)}`],
        headers: ['التاريخ', 'العميل / الجهة', 'رقم إذن الصرف', 'الكمية المضافة', 'الكمية المنصرفة', 'الرصيد الجاري', 'تصفيه'],
        rows: hideZeros(rows),
        totals: ['الإجمالي', `${fmtNum(rows.length)} حركة`, '', fmtNum(round6(pAdd)), fmtNum(round6(pOut)), fmtNum(closing), ''],
        orientation: 'portrait',
        excelName: 'تقرير حركة صنف معين',
      };
    }

    if (report === 'warehouse') {
      const scope = to ? tx.filter((t) => t.date <= to) : tx;
      const bal = computeBalances(scope);
      let totalQty = 0, totalWeight = 0;
      const list = Array.from(bal.values())
        .filter((b) => Number(b.net) > 0 && filterCombo(b))
        .sort((a, b) => {
          const ia = CANON_FAMILIES.indexOf(productFamily(a.quality) as never);
          const ib = CANON_FAMILIES.indexOf(productFamily(b.quality) as never);
          if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
          return productFamily(a.quality).localeCompare(productFamily(b.quality), 'ar') || Number(a.gsm) - Number(b.gsm) || Number(a.size) - Number(b.size);
        });
      const rows = list.map((b) => {
        totalQty += b.net;
        const w = productWeight(b.size, b.net, wf);
        totalWeight += w;
        return [productFamily(b.quality), String(b.gsm), String(b.size), fmtNum(b.net), fmtNum(w, 2)];
      });
      return {
        title: 'التقرير',
        subtitle: [to ? `الرصيد محسوب من الحركات الأصلية حتى تاريخ: ${fmtDate(to)}` : 'الرصيد الحالي من جميع الحركات الأصلية'],
        summary: [`إجمالي البكر الموجودة بالمخزن: ${fmtNum(round6(totalQty))}`, `إجمالي الوزن التقريبي (كجم): ${fmtNum(round6(totalWeight), 2)}`, `عدد المقاسات الموجودة: ${fmtNum(list.length)}`],
        headers: ['اسم الصنف', 'الجرام', 'المقاس', 'رصيد المخزن (بكر)', 'الوزن التقريبي (كجم)'],
        rows: hideZeros(rows),
        totals: ['الإجمالي', `${fmtNum(list.length)} مقاس`, '', fmtNum(round6(totalQty)), fmtNum(round6(totalWeight), 2)],
        orientation: 'portrait',
        excelName: 'التقرير',
      };
    }

    if (report === 'balance') {
      const list = Array.from(s.balancesW.values())
        .filter((b) => b.net !== 0 && filterCombo(b))
        .sort((a, b) => productFamily(a.quality).localeCompare(productFamily(b.quality), 'ar')
          || Number(a.gsm) - Number(b.gsm) || ((a.weight ?? 0) - (b.weight ?? 0)) || Number(a.size) - Number(b.size));
      let tQty = 0, tW = 0;
      const rows = list.map((b) => {
        tQty += b.net;
        const w = productWeight(b.size, b.net, wf);
        tW += w;
        return [productFamily(b.quality), String(b.gsm), b.weight != null ? fmtNum(b.weight, 3) : '—', String(b.size), fmtNum(b.net), fmtNum(w, 2)];
      });
      return {
        title: 'تقرير الرصيد الحالي',
        subtitle: ['يشمل الأصناف ذات الرصيد الصفري والسالب لأغراض المراجعة'],
        headers: ['اسم الصنف', 'الجرام', 'وزن البكرة (كجم)', 'المقاس', 'رصيد المخزن', 'الوزن التقديري (كجم)'],
        rows: hideZeros(rows),
        totals: ['الإجمالي', `${fmtNum(list.length)} صنف`, '', '', fmtNum(round6(tQty)), fmtNum(round6(tW), 2)],
        orientation: 'landscape',
        excelName: 'تقرير الرصيد الحالي',
      };
    }

    if (report === 'rolls') {
      const data = rollsData || { rolls: await repo.rolls(), reels: await repo.reels() };
      if (!rollsData) setRollsData(data);
      const reelsByRoll = new Map<number, Reel[]>();
      for (const r of data.reels) {
        const arr = reelsByRoll.get(r.rollNo) || [];
        arr.push(r);
        reelsByRoll.set(r.rollNo, arr);
      }
      const sorted = [...data.rolls].sort((a, b) => Number(b.rollNo) - Number(a.rollNo));
      const MAX = 800;
      const rows: string[][] = [];
      let tReels = 0, tW = 0;
      for (const roll of sorted) {
        const reels = (reelsByRoll.get(Number(roll.rollNo)) || []).sort((a, b) => a.reelNo - b.reelNo);
        if (product && !reels.some((x) => productFamily(String(x.quality)) === product)) continue;
        if (gsm && String(roll.gram) !== gsm && !reels.some((x) => String(x.gram) === gsm)) continue;
        const filteredReels = reels.filter((r) => !rollst || r.status === rollst);
        for (const r of filteredReels) {
          tReels++;
          tW += Number(r.weight) || 0;
          if (rows.length < MAX) {
            rows.push([
              String(roll.rollNo), fmtDate(roll.date), roll.gram != null ? fmtNum(roll.gram) : '—',
              String(r.reelNo), String(r.size ?? '—'), fmtNum(r.weight, 3),
              r.gram != null ? fmtNum(r.gram) : '—', productFamily(r.quality || '') || '—', REEL_STATUS[r.status],
            ]);
          }
        }
      }
      return {
        title: 'تقرير الرولات والبكر',
        subtitle: rows.length >= MAX ? [`يُعرض أول ${MAX} بكرة من الإجمالي — استخدم الفلاتر للتنقيح والتصدير للقائمة الكاملة`] : [],
        headers: ['رقم الرول', 'التاريخ', 'الجرام', 'رقم البكرة', 'المقاس', 'الوزن (كجم)', 'الجرام', 'اسم الصنف', 'الحالة'],
        rows: hideZeros(rows),
        totals: ['الإجمالي', `${fmtNum(sorted.length)} رول`, '', `${fmtNum(tReels)} بكرة`, '', '', '', '', fmtNum(round6(tW), 3)],
        orientation: 'landscape',
        excelName: 'تقرير الرولات والبكر',
      };
    }

    if (report === 'additions' || report === 'withdrawals') {
      const isAdd = report === 'additions';
      const list = tx.filter((t) => (isAdd ? (Number(t.addQty) || 0) > 0 : (Number(t.outQty) || 0) > 0)
        && filterCombo(t) && filterPeriod(t) && filterCustomer(t))
        .sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.id || 0) - (b.id || 0));
      let tQty = 0, tW = 0;
      const rows = list.map((t) => {
        const qty = isAdd ? Number(t.addQty) || 0 : Number(t.outQty) || 0;
        tQty += qty;
        tW += Number(t.weight) || 0;
        return [fmtDate(t.date), t.permitNo || '—', productFamily(t.quality), String(t.gsm), String(t.size), canonicalCustomer(t.customer), fmtNum(qty), fmtNum(t.weight, 3)];
      });
      return {
        title: isAdd ? 'تقرير حركة الإضافات' : 'تقرير حركة الصرف',
        subtitle: [from || to ? `من تاريخ: ${from ? fmtDate(from) : '—'} إلى تاريخ: ${to ? fmtDate(to) : '—'}` : 'كل الحركات'],
        summary: [`${isAdd ? 'عدد حركات الإنتاج' : 'عدد أذون الصرف'}: ${fmtNum(list.length)}`, `إجمالي ${isAdd ? 'الإضافات' : 'المنصرف'}: ${fmtNum(round6(tQty))}`, `إجمالي الوزن المسجل (كجم): ${fmtNum(round6(tW), 3)}`],
        headers: ['التاريخ', 'رقم إذن الصرف', 'اسم الصنف', 'الجرام', 'المقاس', 'العميل / الجهة', isAdd ? 'الكمية المضافة' : 'الكمية المنصرفة', 'الوزن (كجم)'],
        rows: hideZeros(rows),
        totals: ['الإجمالي', `${fmtNum(list.length)} حركة`, '', '', '', '', fmtNum(round6(tQty)), fmtNum(round6(tW), 3)],
        orientation: 'landscape',
        excelName: isAdd ? 'تقرير حركة الإضافات' : 'تقرير حركة الصرف',
      };
    }

    if (report === 'issuedocs') {
      const vouchers: Voucher[] = collectVouchers(tx, s.permits)
        .filter((v) => (!from || v.date >= from) && (!to || v.date <= to) && (!cls || v.cls === cls))
        .sort((a, b) => `${b.date}|${b.minId || 0}`.localeCompare(`${a.date}|${a.minId || 0}`));
      let tRolls = 0, tW = 0, nTax = 0, nNon = 0;
      const rows: string[][] = [];
      for (const v of vouchers) {
        if (v.cls === 'ض') nTax++; else if (v.cls === 'غ') nNon++;
        tRolls += v.totalRolls;
        tW += v.totalWeightKg || 0;
        for (const l of v.lines) {
          rows.push([
            v.permitNo || '—', fmtDate(v.date), v.customer,
            v.cls ? CLS_LABEL[v.cls] : '—',
            v.status === 'draft' ? 'مسودة' : v.status === 'approved' ? 'معتمد' : 'مستورد',
            l.family, String(l.gsm), String(l.size), fmtNum(l.qty),
            v.totalWeightKg != null ? fmtNum(v.totalWeightKg, 3) : 'تقديري',
          ]);
        }
      }
      return {
        title: 'تقرير أذون الصرف',
        subtitle: [from || to ? `من تاريخ: ${from ? fmtDate(from) : '—'} إلى تاريخ: ${to ? fmtDate(to) : '—'}` : 'كل الأذون'],
        summary: [`عدد الأذون: ${fmtNum(vouchers.length)} (ضريبي: ${nTax} — غير ضريبي: ${nNon})`, `إجمالي البكر: ${fmtNum(round6(tRolls))}`, `إجمالي الوزن (كجم): ${fmtNum(round6(tW), 3)}`],
        headers: ['رقم الإذن', 'التاريخ', 'العميل / الجهة', 'التصنيف', 'الحالة', 'اسم الصنف', 'الجرام', 'المقاس', 'الكمية المنصرفة', 'الوزن الإجمالي (كجم)'],
        rows: hideZeros(rows),
        totals: ['الإجمالي', `${fmtNum(vouchers.length)} إذن`, '', '', '', '', '', '', fmtNum(round6(tRolls)), fmtNum(round6(tW), 3)],
        orientation: 'landscape',
        excelName: 'تقرير أذون الصرف',
      };
    }

    if (report === 'customer') {
      if (!customer) {
        toast.error('اختر العميل أولًا');
        return null;
      }
      const list = tx.filter((t) => filterCustomer(t) && filterPeriod(t))
        .sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.id || 0) - (b.id || 0));
      let addSum = 0, outSum = 0;
      const rows = list.map((t) => {
        addSum += Number(t.addQty) || 0;
        outSum += Number(t.outQty) || 0;
        return [fmtDate(t.date), productFamily(t.quality), String(t.gsm), String(t.size), t.permitNo || '—', fmtNum(Number(t.addQty) || 0), fmtNum(Number(t.outQty) || 0), t.settlement || ''];
      });
      const net = round6(addSum - outSum);
      return {
        title: 'تقرير حركة عميل معين',
        subtitle: [`العميل / الجهة: ${customer}`, from || to ? `من تاريخ: ${from ? fmtDate(from) : '—'} إلى تاريخ: ${to ? fmtDate(to) : '—'}` : 'كل الحركات'],
        summary: [`إجمالي الإضافات: ${fmtNum(round6(addSum))}`, `إجمالي الصرف: ${fmtNum(round6(outSum))}`, `الصافي للعميل: ${fmtNum(net)}`],
        headers: ['التاريخ', 'اسم الصنف', 'الجرام', 'المقاس', 'رقم إذن الصرف', 'الكمية المضافة', 'الكمية المنصرفة', 'تصفيه'],
        rows: hideZeros(rows),
        totals: ['الإجمالي', `${fmtNum(list.length)} حركة`, '', '', '', fmtNum(round6(addSum)), fmtNum(round6(outSum)), ''],
        orientation: 'landscape',
        excelName: 'تقرير حركة عميل معين',
      };
    }

    /* period */
    {
      const list = tx.filter((t) => {
        if (!filterPeriod(t)) return false;
        if (!filterCombo(t)) return false;
        if (!filterCustomer(t)) return false;
        if (type === 'add' && !(Number(t.addQty) > 0)) return false;
        if (type === 'out' && !(Number(t.outQty) > 0)) return false;
        return true;
      }).sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.id || 0) - (b.id || 0));
      let addSum = 0, outSum = 0, nAdd = 0, nOut = 0;
      const rows = list.map((t) => {
        const a = Number(t.addQty) || 0;
        const o = Number(t.outQty) || 0;
        addSum += a; outSum += o;
        if (a > 0) nAdd++;
        if (o > 0) nOut++;
        return [fmtDate(t.date), a > 0 ? 'إضافة' : 'صرف', productFamily(t.quality), String(t.gsm), String(t.size), canonicalCustomer(t.customer), t.permitNo || '—', fmtNum(a), fmtNum(o), t.settlement || ''];
      });
      return {
        title: 'تقرير حركة المخزن خلال فترة محددة',
        subtitle: [from || to ? `من تاريخ: ${from ? fmtDate(from) : '—'} إلى تاريخ: ${to ? fmtDate(to) : '—'}` : 'كل الحركات'],
        summary: [`عدد حركات الإنتاج: ${fmtNum(nAdd)} — إجمالي الإضافات: ${fmtNum(round6(addSum))}`, `عدد أذون الصرف: ${fmtNum(nOut)} — إجمالي المنصرف: ${fmtNum(round6(outSum))}`, `صافي الحركة خلال الفترة: ${fmtNum(round6(addSum - outSum))}`],
        headers: ['التاريخ', 'نوع الحركة', 'اسم الصنف', 'الجرام', 'المقاس', 'العميل / الجهة', 'رقم إذن الصرف', 'الكمية المضافة', 'الكمية المنصرفة', 'تصفيه'],
        rows: hideZeros(rows),
        totals: ['الإجمالي', `${fmtNum(list.length)} حركة`, '', '', '', '', '', fmtNum(round6(addSum)), fmtNum(round6(outSum)), ''],
        orientation: 'landscape',
        excelName: 'تقرير حركة المخزن خلال فترة محددة',
      };
    }
  };

  const run = async () => {
    const m = await build();
    if (m) {
      setModel(m);
      setScreenRows(m.rows);
    } else {
      setModel(null);
      setScreenRows([]);
    }
  };

  const doPrint = async () => {
    const m = model || await build();
    if (m) {
      setModel(m);
      usePrint.getState().open({
        kind: 'table',
        company: s.settings.companyName || 'إدارة المخزن',
        title: m.title,
        subtitle: m.subtitle,
        obLine: m.obLine,
        summary: m.summary,
        headers: m.headers,
        rows: m.rows,
        totals: m.totals,
        signatures: ['أمين المخزن', 'المحاسب', 'مدير المخزن'],
      }, m.orientation);
    }
  };

  const doExcel = async () => {
    const m = model || await build();
    if (!m) return;
    exportReportAOA(m.title, m.headers, m.rows.map((r) => r.map((c) => c.replace(/,/g, '') || '')), m.totals, m.excelName);
    toast.success('تم تنزيل التقرير بصيغة إكسل');
  };

  const fl = needs[report];

  return (
    <div>
      <PageHead title="التقارير">
        <button className="agr-btn agr-btn-primary" onClick={doPrint}><Printer size={15} /> طباعة التقرير (A4)</button>
        <button className="agr-btn agr-btn-ghost" onClick={doExcel}>تصدير Excel</button>
      </PageHead>

      <div className="grid grid-cols-3 md:grid-cols-5 gap-2 mb-3">
        {REPORTS.map((r) => (
          <button
            key={r.id}
            className={`agr-card text-center py-3 cursor-pointer border ${report === r.id ? 'border-teal-600 bg-teal-50' : 'hover:bg-slate-50'}`}
            onClick={() => { setReport(r.id); setModel(null); setScreenRows([]); setPgsm(''); setPsize(''); }}
          >
            <div className="text-xl">{r.icon}</div>
            <div className="text-[11px] font-bold mt-1">{r.name}</div>
          </button>
        ))}
      </div>

      <div className="agr-card filters mb-3">
        {fl.includes('from') && <label className="agr-fl"><span>من تاريخ</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>}
        {fl.includes('to') && !fl.includes('asof') && <label className="agr-fl"><span>إلى تاريخ</span><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>}
        {fl.includes('asof') && <label className="agr-fl"><span>حتى تاريخ (الرصيد حتى هذا اليوم)</span><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>}
        {fl.includes('product') && !fl.includes('productCombo') && (
          <label className="agr-fl"><span>اسم الصنف</span>
            <select value={product} onChange={(e) => setProduct(e.target.value)}>
              <option value="">— اختر الصنف —</option>
              {families.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </label>
        )}
        {fl.includes('productCombo') && (
          <>
            <label className="agr-fl"><span>اسم الصنف</span>
              <select value={product} onChange={(e) => { setProduct(e.target.value); setPgsm(''); setPsize(''); }}>
                <option value="">— اختر الصنف —</option>
                {families.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </label>
            <label className="agr-fl"><span>الجرام</span>
              <select value={pgsm} onChange={(e) => { setPgsm(e.target.value); setPsize(''); }}>
                <option value="">—</option>
                {productGsms.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </label>
            <label className="agr-fl"><span>المقاس</span>
              <select value={psize} onChange={(e) => setPsize(e.target.value)}>
                <option value="">—</option>
                {productSizes.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </label>
          </>
        )}
        {fl.includes('gsm') && (
          <label className="agr-fl"><span>الجرام</span>
            <select value={gsm} onChange={(e) => setGsm(e.target.value)}>
              <option value="">الكل</option>
              {allGsms.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </label>
        )}
        {fl.includes('size') && (
          <label className="agr-fl"><span>المقاس</span>
            <select value={size} onChange={(e) => setSize(e.target.value)}>
              <option value="">الكل</option>
              {allSizes.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </label>
        )}
        {fl.includes('customer') && (
          <label className="agr-fl"><span>العميل / الجهة</span>
            <select value={customer} onChange={(e) => setCustomer(e.target.value)}>
              <option value="">— اختر العميل —</option>
              {customers.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        )}
        {fl.includes('type') && (
          <label className="agr-fl"><span>نوع الحركة</span>
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">الكل</option><option value="add">إضافة</option><option value="out">صرف</option>
            </select>
          </label>
        )}
        {fl.includes('rollst') && (
          <label className="agr-fl"><span>حالة البكرة</span>
            <select value={rollst} onChange={(e) => setRollst(e.target.value)}>
              <option value="">الكل</option>
              <option value="available">متاحة</option>
              <option value="dispatched">مصروفة</option>
              <option value="undefined">غير محددة (مستوردة)</option>
            </select>
          </label>
        )}
        {fl.includes('cls') && (
          <label className="agr-fl"><span>التصنيف</span>
            <select value={cls} onChange={(e) => setCls(e.target.value)}>
              <option value="">الكل</option><option value="ض">ضريبي</option><option value="غ">غير ضريبي</option>
            </select>
          </label>
        )}
        <button className="agr-btn agr-btn-primary agr-btn-sm" onClick={run}>عرض التقرير</button>
      </div>

      {model && (
        <div className="agr-table-wrap">
          <table className="agr-table">
            <thead>
              <tr>{model.headers.map((h, i) => <th key={i}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {screenRows.length === 0 && <EmptyRow colSpan={model.headers.length} text="لا توجد بيانات" />}
              {screenRows.map((r, i) => (
                <tr key={i}>{r.map((c, ci) => <td key={ci}>{c}</td>)}</tr>
              ))}
            </tbody>
            {model.totals && (
              <tfoot>
                <tr>{model.totals.map((c, i) => <td key={i}>{c}</td>)}</tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}
