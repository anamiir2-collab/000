'use client';

/* Dashboard — KPIs, lightweight charts, low-stock, recent movements */

import { useEffect, useMemo, useState } from 'react';
import { useAgrima } from '@/lib/agrima/store';
import { grandTotals, productWeight, round6 } from '@/lib/agrima/calc';
import { buildGroups, collectVouchers } from '@/lib/agrima/tx';
import { repo } from '@/lib/agrima/db';
import { fmtNum, fmtDate, productFamily } from '@/lib/agrima/utils';
import { PageHead, StatCard, EmptyRow } from '../ui-bits';
import { toast } from 'sonner';
import type { BalanceRow } from '@/lib/agrima/types';
import {
  Boxes, Tag, Factory, FileOutput, ArrowDownToLine, PackagePlus, Plus,
} from 'lucide-react';

interface ReelAgg { total: number; available: number; availW: number; dispatched: number; undef: number }

function MonthlyChart({ tx }: { tx: ReturnType<typeof useAgrima.getState>['transactions'] }) {
  const data = useMemo(() => {
    const map = new Map<string, { add: number; out: number }>();
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const k = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}`;
      map.set(k, { add: 0, out: 0 });
    }
    for (const t of tx) {
      if (t.void) continue;
      const d = String(t.date || '').slice(0, 10);
      const k = `${Number(d.slice(0, 4))}/${Number(d.slice(5, 7))}`;
      if (!map.has(k)) continue;
      const e = map.get(k)!;
      e.add += Number(t.addQty) || 0;
      e.out += Number(t.outQty) || 0;
    }
    return Array.from(map.entries());
  }, [tx]);
  const max = Math.max(1, ...data.map(([, v]) => Math.max(v.add, v.out)));
  return (
    <div className="agr-chart">
      {data.map(([k, v]) => (
        <div className="agr-chart-row" key={k}>
          <span className="agr-chart-lbl">{k}</span>
          <div className="agr-chart-bar-wrap">
            <div className="agr-chart-bar" style={{ width: `${(v.add / max) * 100}%`, background: '#14B8A6' }} title={`إضافة ${fmtNum(v.add)}`} />
          </div>
          <span className="agr-chart-val" style={{ color: '#0F766E' }}>{fmtNum(v.add)}</span>
          <div className="agr-chart-bar-wrap">
            <div className="agr-chart-bar" style={{ width: `${(v.out / max) * 100}%`, background: '#D97706' }} title={`صرف ${fmtNum(v.out)}`} />
          </div>
          <span className="agr-chart-val" style={{ color: '#B45309' }}>{fmtNum(v.out)}</span>
        </div>
      ))}
      <div className="text-[10px] text-slate-500 text-center mt-1">
        <span style={{ color: '#0F766E' }}>■</span> إضافة &nbsp; <span style={{ color: '#B45309' }}>■</span> صرف
      </div>
    </div>
  );
}

function TopProductsChart({ balancesW }: { balancesW: Map<string, BalanceRow> }) {
  const rows = useMemo(() => {
    const list = Array.from(balancesW.values())
      .filter((b) => b.net > 0)
      .sort((a, b) => b.net - a.net)
      .slice(0, 10);
    return list;
  }, [balancesW]);
  const max = Math.max(1, ...rows.map((r) => r.net));
  return (
    <div className="agr-chart">
      {rows.map((r, i) => (
        <div className="agr-chart-row" key={i}>
          <span className="agr-chart-lbl" style={{ width: 120, direction: 'rtl' }}>
            {productFamily(r.quality)} {String(r.gsm)}g{r.weight ? ` — ${String(r.weight)}kg` : ''} — {String(r.size)}
          </span>
          <div className="agr-chart-bar-wrap">
            <div className="agr-chart-bar" style={{ width: `${(r.net / max) * 100}%`, background: '#134E4A' }} />
          </div>
          <span className="agr-chart-val">{fmtNum(r.net)}</span>
        </div>
      ))}
      {rows.length === 0 && <div className="text-xs text-slate-400 text-center py-3">لا توجد بيانات بعد — ابدأ باستيراد ملف الإكسل أو تسجيل بكر</div>}
    </div>
  );
}

export default function Dashboard() {
  const s = useAgrima();
  const [reelAgg, setReelAgg] = useState<ReelAgg | null>(null);

  useEffect(() => {
    repo.reels().then((reels) => {
      const agg: ReelAgg = { total: reels.length, available: 0, availW: 0, dispatched: 0, undef: 0 };
      for (const r of reels) {
        if (r.status === 'available') { agg.available++; agg.availW += Number(r.weight) || 0; }
        else if (r.status === 'dispatched') agg.dispatched++;
        else if (r.status === 'undefined') agg.undef++;
      }
      agg.availW = round6(agg.availW);
      setReelAgg(agg);
    });
  }, [s.transactions, s.permits, s.reels]);

  const groups = useMemo(() => buildGroups(s.transactions.filter((t) => !t.void)), [s.transactions]);
  const vouchers = useMemo(() => collectVouchers(s.transactions, s.permits), [s.transactions, s.permits]);
  const totals = useMemo(() => grandTotals(s.transactions), [s.transactions]);

  const stockTotal = useMemo(
    () => round6(Array.from(s.balances.values()).reduce((sum, b) => sum + (b.net > 0 ? b.net : 0), 0)),
    [s.balances],
  );
  const totalWeight = useMemo(
    () => round6(Array.from(s.balances.values()).reduce((sum, b) => sum + (b.net > 0 ? productWeight(b.size, b.net, s.settings.weightFactor) : 0), 0)),
    [s.balances, s.settings.weightFactor],
  );
  const drafts = vouchers.filter((v) => v.kind === 'permit' && v.status === 'draft').length;
  const prodCount = useMemo(() => {
    const g = groups.filter((x) => x.add > 0 && !x.key.startsWith('G:R:roll-'));
    const reelRows = groups.filter((x) => x.key.startsWith('G:R:roll-')).length;
    return g.length + reelRows;
  }, [groups]);

  const lowStock = useMemo(() => {
    return Array.from(s.balancesW.values())
      .filter((b) => b.net <= 0 && (b.add > 0 || b.out > 0))
      .sort((a, b) => a.net - b.net)
      .slice(0, 5);
  }, [s.balancesW]);
  const lowCount = useMemo(
    () => Array.from(s.balancesW.values()).filter((b) => b.net <= 0 && (b.add > 0 || b.out > 0)).length,
    [s.balancesW],
  );

  const families = useMemo(() => {
    const map = new Map<string, { count: number; net: number }>();
    for (const b of s.balances.values()) {
      if (b.net <= 0) continue;
      const f = productFamily(b.quality);
      const e = map.get(f) || { count: 0, net: 0 };
      e.count++; e.net += b.net;
      map.set(f, e);
    }
    return Array.from(map.entries());
  }, [s.balances]);

  const recent = useMemo(() => {
    return buildGroups(s.transactions.filter((t) => !t.void))
      .slice(0, 8)
      .map((g) => ({
        date: g.date, quality: productFamily(g.quality), gsm: g.gsm, size: g.rows.map((r) => r.size).join('، '),
        customer: g.customer, add: g.add, out: g.out,
      }));
  }, [s.transactions]);

  const { navigate } = useAgrima();

  return (
    <div>
      <PageHead title="لوحة التحكم">
        {s.transactions.length === 0 && (
          <button className="agr-btn agr-btn-ghost" onClick={() => { toast.info('انتقل إلى قسم الاستيراد والتصدير لاستيراد ملف الإكسل'); navigate('import' as never); }}>
            استيراد ملف الإكسل
          </button>
        )}
        <button className="agr-btn agr-btn-primary" onClick={() => navigate('reels-add' as never)}>
          <Plus size={15} /> تسجيل بكر
        </button>
      </PageHead>

      {reelAgg && (
        <div className="agr-card mb-3 text-xs font-bold text-slate-600">
          البكر المتتبعة: <b>{fmtNum(reelAgg.total)}</b> — متاحة: <b>{fmtNum(reelAgg.available)}</b> بوزن فعلي{' '}
          <b>{fmtNum(reelAgg.availW, 3)}</b> كجم — مصروفة: <b>{fmtNum(reelAgg.dispatched)}</b> — غير محددة (مستوردة تاريخية): <b>{fmtNum(reelAgg.undef)}</b>
        </div>
      )}

      <div className="agr-stats">
        <StatCard accent="green" icon={<Boxes size={19} />} num={fmtNum(stockTotal)} label="إجمالي رصيد المخزن (بكرة)" />
        <StatCard accent="teal" icon={<Tag size={19} />} num={fmtNum(s.products.length)} label="إجمالي الأصناف" />
        <StatCard accent="teal" icon={<Factory size={19} />} num={fmtNum(prodCount)} label="حركات الإنتاج (منها البكر المسجلة)" />
        <StatCard accent="amber" icon={<FileOutput size={19} />} num={fmtNum(vouchers.length)} label={`عدد أذون الصرف${drafts ? ` (معتمدة + ${drafts} مسودة)` : ''}`} />
        <StatCard accent="green" icon={<PackagePlus size={19} />} num={fmtNum(totals.add)} label="إجمالي الإضافات للإنتاج" />
        <StatCard accent="amber" icon={<ArrowDownToLine size={19} />} num={fmtNum(totals.out)} label="إجمالي الصرف للعملاء" />
      </div>

      <div className="agr-card mb-3 text-xs font-bold text-slate-600">
        إجمالي وزن الرصيد التقديري: <b>{fmtNum(totalWeight, 2)}</b> كجم (المقاس × الرصيد × {s.settings.weightFactor})
      </div>

      {lowCount > 0 && (
        <div className="agr-card mb-3 text-xs" style={{ borderInlineStart: '4px solid #DC2626' }}>
          <b>أصناف منتهية أو سالبة: {fmtNum(lowCount)}</b>
          <div className="text-slate-500 mt-1">
            {lowStock.map((b, i) => (
              <span key={i} className="mr-2">
                {productFamily(b.quality)} / {String(b.gsm)} / وزن {b.weight ?? '—'} / مقاس {String(b.size)}: {fmtNum(b.net)}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="agr-grid-2">
        <div className="agr-card">
          <h3 className="font-extrabold text-sm mb-2">الإضافات والصرف الشهري</h3>
          <MonthlyChart tx={s.transactions} />
        </div>
        <div className="agr-card">
          <h3 className="font-extrabold text-sm mb-2">أعلى 10 أصناف بالرصيد</h3>
          <TopProductsChart balancesW={s.balancesW} />
        </div>
      </div>

      <div className="agr-grid-2 mt-3">
        <div>
          <div className="flex items-center mb-2">
            <h3 className="font-extrabold text-sm">الرصيد حسب الصنف</h3>
            <button className="agr-voucher-no mr-auto text-xs" onClick={() => navigate('inventory' as never)}>عرض الكل</button>
          </div>
          <div className="agr-table-wrap">
            <table className="agr-table">
              <thead><tr><th>اسم الصنف</th><th>عدد الأصناف</th><th>رصيد المخزن (بكرة)</th></tr></thead>
              <tbody>
                {families.length === 0 && <EmptyRow colSpan={3} text="لا توجد بيانات بعد — ابدأ باستيراد ملف الإكسل" />}
                {families.map(([f, v]) => (
                  <tr key={f}><td>{f}</td><td className="num">{fmtNum(v.count)}</td><td className="num pos">{fmtNum(v.net)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <div className="flex items-center mb-2">
            <h3 className="font-extrabold text-sm">أحدث الحركات</h3>
            <button className="agr-voucher-no mr-auto text-xs" onClick={() => navigate('history' as never)}>عرض الكل</button>
          </div>
          <div className="agr-table-wrap">
            <table className="agr-table">
              <thead><tr><th>التاريخ</th><th>اسم الصنف</th><th>الجرام</th><th>المقاس</th><th>العميل</th><th>إضافة</th><th>صرف</th></tr></thead>
              <tbody>
                {recent.length === 0 && <EmptyRow colSpan={7} text="لا توجد بيانات بعد" />}
                {recent.map((r, i) => (
                  <tr key={i}>
                    <td className="num">{fmtDate(r.date)}</td>
                    <td>{r.quality}</td>
                    <td className="num">{fmtNum(Number(r.gsm))}</td>
                    <td className="num">{String(r.size)}</td>
                    <td>{r.customer}</td>
                    <td className="num pos">{r.add > 0 ? fmtNum(r.add) : ''}</td>
                    <td className="num neg">{r.out > 0 ? fmtNum(r.out) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
