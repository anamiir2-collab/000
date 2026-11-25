'use client';

/* IssuedocView — عرض إذن صرف (شاشة + طباعة A4 رسمية) */

import { useEffect, useMemo, useState } from 'react';
import { useAgrima } from '@/lib/agrima/store';
import { collectVouchers, approvePermit, CLS_LABEL } from '@/lib/agrima/tx';
import { round6 } from '@/lib/agrima/calc';
import { fmtNum, fmtDate } from '@/lib/agrima/utils';
import { PageHead, confirmAction } from '../ui-bits';
import { toast } from 'sonner';
import { can, isWarehouse } from '@/lib/agrima/permissions';
import { ArrowRight, Printer, Check, Pencil } from 'lucide-react';
import { usePrint } from '../print/printStore';
import type { Voucher } from '@/lib/agrima/types';

export default function IssuedocView() {
  const s = useAgrima();
  const keeper = isWarehouse();
  const doc = s.pendingDoc;

  /* fallback: find by pendingEdit permit or latest voucher */
  const voucher: Voucher | null = useMemo(() => {
    if (doc) return doc;
    if (s.pendingEdit?.kind === 'permit' && s.pendingEdit.permit) {
      const list = collectVouchers(s.transactions, s.permits);
      return list.find((v) => v.permitId === s.pendingEdit!.permit!.id) || null;
    }
    return null;
  }, [doc, s.pendingEdit, s.transactions, s.permits]);

  const doPrint = () => {
    if (!voucher) return;
    const gsmTotalsMap = new Map<string, { gsm: number | string; rolls: number; wKg: number | null; est: boolean }>();
    for (const l of voucher.lines) {
      const k = String(l.gsm);
      const e = gsmTotalsMap.get(k) || { gsm: l.gsm, rolls: 0, wKg: null, est: false };
      e.rolls += l.qty;
      const lw = l.weightKg != null ? l.weightKg : (l.weight && l.weight > 0 ? l.weight * l.qty : null);
      if (lw != null) {
        e.wKg = (e.wKg || 0) + lw;
      } else {
        e.est = true;
      }
      gsmTotalsMap.set(k, e);
    }
    const totalW = voucher.totalWeightKg;
    usePrint.getState().open({
      kind: 'permit',
      company: s.settings.companyName || 'إدارة المخزن',
      permitNo: voucher.permitNo || '—',
      cls: voucher.cls || '',
      clsLabel: voucher.cls ? CLS_LABEL[voucher.cls] : '—',
      status: voucher.status === 'draft' ? 'مسودة — غير معتمدة' : voucher.status === 'approved' ? 'معتمد' : 'مستورد',
      customer: voucher.customer,
      date: fmtDate(voucher.date),
      conflictNote: voucher.customerConflict ? '⚠ تعارض عميل — نفس الرقم مستخدم لعملاء آخرين' : undefined,
      multiDate: voucher.multiDate,
      lines: voucher.lines.map((l) => ({ qty: l.qty, size: l.size, gsm: l.gsm, quality: l.family })),
      gsmTotals: Array.from(gsmTotalsMap.values()).map((e) => ({
        gsm: e.gsm, rolls: e.rolls,
        tons: fmtNum((e.wKg || 0) / 1000, 4), est: e.est,
      })),
      totalRolls: voucher.totalRolls,
      totalTons: totalW != null ? fmtNum(totalW / 1000, 4) : 'تقديري',
      totalEst: voucher.weightEstimated,
      notes: voucher.notes,
      estNote: voucher.weightEstimated,
      draft: voucher.status === 'draft',
      signatures: ['المُسلِّم (أمين المخزن)', 'المستلم (العميل)'],
    }, 'portrait');
  };

  const doApprove = async () => {
    if (!voucher || voucher.kind !== 'permit' || !voucher.permitId) return;
    const ok = await confirmAction({
      title: 'اعتماد الإذن',
      message: `اعتماد الإذن "${voucher.permitNo}" للعميل ${voucher.customer} (${fmtNum(voucher.totalRolls)} بكرة)؟ سيتم التحقق من الرصيد، وخصم الكميات، وتحديث حالة البكر المحددة إلى «مصروفة».`,
      yesLabel: 'اعتماد',
    });
    if (!ok) return;
    try {
      await approvePermit(voucher.permitId, s.profile?.email);
      await useAgrima.getState().refresh();
      const list = collectVouchers(s.transactions, s.permits);
      useAgrima.getState().setPendingDoc(list.find((v) => v.permitId === voucher.permitId) || null);
      toast.success(`تم اعتماد الإذن ${voucher.permitNo} وخصم ${fmtNum(voucher.totalRolls)} بكرة من الرصيد`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const doEdit = () => {
    if (!voucher) return;
    if (voucher.kind === 'permit' && voucher.permitId) {
      const p = s.permits.find((x) => x.id === voucher.permitId);
      if (p) {
        useAgrima.getState().setPendingEdit({ kind: 'permit', permit: p });
        useAgrima.getState().navigate('baker-issue' as never);
      }
    } else {
      useAgrima.getState().setPendingEdit({ kind: 'legacy', voucher });
      useAgrima.getState().navigate('baker-issue' as never);
    }
  };

  useEffect(() => {
    if (s.autoPrintDoc && voucher) {
      const t = setTimeout(doPrint, 350);
      useAgrima.getState().setAutoPrintDoc(false);
      return () => clearTimeout(t);
    }
     
  }, [s.autoPrintDoc, voucher]);

  if (!voucher) {
    return (
      <div>
        <PageHead title="عرض إذن صرف" />
        <div className="agr-card">لا يوجد إذن محدد — عد إلى قائمة أذون الصرف واختر إذنًا.</div>
      </div>
    );
  }

  const gsmTotalsMap = new Map<string, { gsm: number | string; rolls: number; wKg: number | null; est: boolean }>();
  for (const l of voucher.lines) {
    const k = String(l.gsm);
    const e = gsmTotalsMap.get(k) || { gsm: l.gsm, rolls: 0, wKg: null, est: false };
    e.rolls += l.qty;
    const lw = l.weightKg != null ? l.weightKg : (l.weight && l.weight > 0 ? l.weight * l.qty : null);
    if (lw != null) e.wKg = (e.wKg || 0) + lw;
    else e.est = true;
    gsmTotalsMap.set(k, e);
  }

  return (
    <div>
      <PageHead title="عرض إذن صرف">
        <button className="agr-btn agr-btn-ghost" onClick={() => useAgrima.getState().navigate('issuedocs' as never)}>
          <ArrowRight size={15} /> رجوع لأذون الصرف
        </button>
        <button className="agr-btn agr-btn-primary" onClick={doPrint}><Printer size={15} /> طباعة الإذن (A4)</button>
        {!keeper && voucher.kind === 'permit' && voucher.status === 'draft' && can('approve') && (
          <button className="agr-btn agr-btn-amber" onClick={doApprove}><Check size={15} /> اعتماد الإذن</button>
        )}
        {!keeper && can('edit') && (
          <button className="agr-btn agr-btn-ghost" onClick={doEdit}><Pencil size={15} /> تعديل</button>
        )}
      </PageHead>

      <div className="agr-card" style={{ maxWidth: 760, margin: '0 auto', position: 'relative', overflow: 'hidden' }}>
        {voucher.status === 'draft' && (
          <div className="draft-watermark">مسودة — غير معتمدة</div>
        )}
        <div className="rp-head" style={{ position: 'relative', zIndex: 1 }}>
          <div className="rp-co">{s.settings.companyName || 'إدارة المخزن'}</div>
          <div className="rp-title">إذن صرف مخزني</div>
          <div className="rp-sub">
            رقم الإذن: {voucher.permitNo || '—'} — التصنيف: {voucher.cls ? CLS_LABEL[voucher.cls] : '—'} — الحالة:{' '}
            {voucher.status === 'draft' ? 'مسودة — غير معتمدة' : voucher.status === 'approved' ? 'معتمد' : 'مستورد'}
          </div>
        </div>
        <table className="doc-meta" style={{ position: 'relative', zIndex: 1 }}>
          <tbody>
            <tr>
              <th>العميل / الجهة</th>
              <td>
                {voucher.customer}
                {voucher.customerConflict && <div className="doc-note-est" style={{ color: '#DC2626', fontWeight: 700 }}>⚠ تعارض عميل — نفس الرقم مستخدم لعملاء آخرين</div>}
              </td>
              <th>التاريخ</th>
              <td>{fmtDate(voucher.date)}{voucher.multiDate ? ' (أحدث تاريخ)' : ''}</td>
            </tr>
          </tbody>
        </table>
        <table className="rp-table" style={{ position: 'relative', zIndex: 1 }}>
          <thead><tr><th>العدد</th><th>المقاس</th><th>الجرام</th><th>الصنف</th></tr></thead>
          <tbody>
            {voucher.lines.map((l, i) => (
              <tr key={i}>
                <td className="rp-num">{fmtNum(l.qty)}</td>
                <td className="rp-num">{l.size}</td>
                <td className="rp-num">{l.gsm}</td>
                <td>{l.family}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table className="rp-table" style={{ marginTop: 6, position: 'relative', zIndex: 1 }}>
          <thead><tr><th>الجرام</th><th>إجمالي عدد البكر</th><th>إجمالي الوزن (طن)</th></tr></thead>
          <tbody>
            {Array.from(gsmTotalsMap.values()).map((e, i) => (
              <tr key={i}>
                <td className="rp-num">{String(e.gsm)}</td>
                <td className="rp-num">{fmtNum(e.rolls)}</td>
                <td className="rp-num">{fmtNum((e.wKg || 0) / 1000, 4)}{e.est ? ' *' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table className="rp-table doc-total" style={{ position: 'relative', zIndex: 1 }}>
          <tbody>
            <tr><td className="doc-total-label">إجمالي البكر</td><td className="doc-total-num">{fmtNum(voucher.totalRolls)} بكرة</td></tr>
            <tr><td className="doc-total-label">إجمالي الوزن (طن)</td><td className="doc-total-num">
              {voucher.totalWeightKg != null ? fmtNum(voucher.totalWeightKg / 1000, 4) : 'تقديري'}{voucher.weightEstimated ? ' *' : ''}
            </td></tr>
          </tbody>
        </table>
        {voucher.notes && <div className="doc-notes" style={{ position: 'relative', zIndex: 1 }}>ملاحظات: {voucher.notes}</div>}
        {voucher.weightEstimated && (
          <div className="doc-note-est" style={{ position: 'relative', zIndex: 1 }}>
            * جزء من الوزن تقديري (المقاس × 7.5) لبكر بلا وزن مسجل — لم يُستبدل أي وزن فعلي.
          </div>
        )}
        <div className="rp-foot" style={{ position: 'relative', zIndex: 1 }}>
          <div className="sig-row">
            <div className="sig"><span>المُسلِّم (أمين المخزن)</span><i /></div>
            <div className="sig"><span>المستلم (العميل)</span><i /></div>
          </div>
        </div>
      </div>
    </div>
  );
}
