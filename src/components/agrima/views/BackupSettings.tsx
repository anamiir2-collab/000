'use client';

/* BackupSettings — النسخ الاحتياطي + الإعدادات + منطقة الخطر */

import { useEffect, useRef, useState } from 'react';
import { useAgrima } from '@/lib/agrima/store';
import { downloadBackup, restoreBackup } from '@/lib/agrima/backup';
import { db } from '@/lib/agrima/db';
import { saveDocSequences, nextDocNumbers } from '@/lib/agrima/tx';
import { fmtNum, fmtDate } from '@/lib/agrima/utils';
import { PageHead, confirmAction } from '../ui-bits';
import { toast } from 'sonner';
import { can } from '@/lib/agrima/permissions';
import { Download, Upload, FileJson, ShieldAlert, Database } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';

export default function BackupSettings({ mode }: { mode: 'backup' | 'settings' }) {
  return mode === 'backup' ? <BackupView /> : <SettingsView />;
}

function BackupView() {
  const s = useAgrima();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<{ at: string; entity: string; action: string; details?: string }[]>([]);

  useEffect(() => {
    db.getAudit(12).then((rows) => {
      setRecent(rows.map((r) => ({ at: r.at, entity: r.entity, action: r.action, details: r.details })));
    });
  }, [s.transactions, s.permits]);

  const doDownload = async () => {
    setBusy(true);
    try {
      const n = await downloadBackup(s.profile?.email);
      toast.success(`تم تنزيل النسخة الاحتياطية (${n} حركة)`);
    } finally {
      setBusy(false);
    }
  };

  const doRestore = async (f: File) => {
    try {
      const ok = await confirmAction({
        title: 'استعادة نسخة احتياطية',
        danger: true,
        yesLabel: 'استبدال البيانات',
        message: 'سيتم استبدال جميع البيانات الحالية بمحتوى النسخة. قبل الاستبدال سيتم تنزيل نسخة تلقائية من بياناتك الحالية. متابعة؟',
      });
      if (!ok) return;
      setBusy(true);
      const res = await restoreBackup(f, s.profile?.email);
      await useAgrima.getState().refresh();
      toast.success(`تمت الاستعادة بنجاح (${res.tx} حركة — ${res.prod} صنف)`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const actionIcon: Record<string, string> = {
    add: '➕', edit: '✎', delete: '🗑', import: '📥', 'import-replace': '♻️',
    restore: '♻️', backup: '💾', approve: '✔', 'user-create': '👤', login: '🔓',
  };
  const entityLabel: Record<string, string> = {
    movement: 'حركة', permit: 'إذن صرف', product: 'صنف', roll: 'رول', reel: 'بكرة',
    user: 'مستخدم', database: 'قاعدة البيانات', customer: 'عميل',
  };

  return (
    <div>
      <PageHead title="النسخ الاحتياطي" />
      <div className="agr-grid-2">
        <div className="agr-card">
          <h3 className="font-extrabold text-sm mb-1">💾 نسخة احتياطية كاملة (JSON)</h3>
          <p className="text-xs text-slate-500 mb-3">
            تشمل: المستخدمين، الحركات ({fmtNum(s.transactions.length)})، الأصناف، الرولات والبكر ({fmtNum(s.rolls.length)})،
            أذون الصرف ({fmtNum(s.permits.length)})، العملاء، الحجوزات، الإعدادات، وسجل العمليات.
          </p>
          <div className="flex gap-2 flex-wrap">
            <button className="agr-btn agr-btn-primary" disabled={busy} onClick={doDownload}>
              <Download size={15} /> تنزيل نسخة احتياطية
            </button>
            <button className="agr-btn agr-btn-warn" disabled={busy} onClick={() => fileRef.current?.click()}>
              <Upload size={15} /> استعادة من ملف
            </button>
            <input
              ref={fileRef} type="file" accept=".json" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) doRestore(f); }}
            />
          </div>
          <div className="text-[11px] text-slate-500 mt-2">
            قبل أي استعادة يتم التحقق من سلامة الملف، ثم تنزيل نسخة تلقائية من بياناتك الحالية، ثم طلب تأكيد صريح.
          </div>
        </div>

        <div className="agr-card">
          <h3 className="font-extrabold text-sm mb-1">🗂 سجل التدقيق (آخر العمليات)</h3>
          <div className="agr-table-wrap mt-2 max-h-64 overflow-y-auto">
            <table className="agr-table">
              <thead><tr><th>الوقت</th><th>القسم</th><th>العملية</th><th>التفاصيل</th></tr></thead>
              <tbody>
                {recent.length === 0 && <tr><td colSpan={4} className="text-center text-slate-400 py-4">لا توجد عمليات بعد</td></tr>}
                {recent.map((r, i) => (
                  <tr key={i}>
                    <td className="num text-[11px]" dir="ltr">{new Date(r.at).toLocaleString('en-GB')}</td>
                    <td className="text-[11px]">{entityLabel[r.entity] || r.entity}</td>
                    <td className="text-[11px]">{actionIcon[r.action] || ''} {r.action}</td>
                    <td className="text-[11px] text-start">{r.details || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="agr-card mt-3 text-xs text-slate-600 flex items-start gap-2">
        <FileJson size={16} className="mt-0.5 text-teal-700 flex-shrink-0" />
        <div>
          <b>أين تُحفظ البيانات؟</b> كل شيء داخل قاعدة بيانات IndexedDB محلية على هذا الجهاز/المتصفح —
          لا يوجد أي خادم أو خدمة سحابية. النسخ الاحتياطي الدوري هو طريقة الحماية الوحيدة: نزّل نسخة JSON بعد كل فترة عمل مهمة واحفظها خارج الجهاز.
        </div>
      </div>
    </div>
  );
}

function SettingsView() {
  const s = useAgrima();
  const [company, setCompany] = useState(s.settings.companyName);
  const [wf, setWf] = useState(String(s.settings.weightFactor));
  const [seqTax, setSeqTax] = useState('0');
  const [seqNontax, setSeqNontax] = useState('0');
  const [wipeOpen, setWipeOpen] = useState(false);
  const [wipeText, setWipeText] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    nextDocNumbers().then((n) => {
      setSeqTax(String(n.tax));
      setSeqNontax(String(n.nontax));
    });
  }, []);

  const saveCompany = async () => {
    await useAgrima.getState().saveSettings({ companyName: company.trim() });
    toast.success('تم الحفظ');
  };

  const saveWf = async () => {
    const v = Number(wf);
    if (!(v > 0)) { toast.error('أدخل معاملًا أكبر من صفر'); return; }
    await useAgrima.getState().saveSettings({ weightFactor: v });
    toast.success('تم الحفظ');
  };

  const saveSeq = async () => {
    const t = Number(seqTax), g = Number(seqNontax);
    const n = await nextDocNumbers();
    if (t <= n.maxTax || g <= n.maxNontax) {
      const ok = await confirmAction({
        title: 'تأكيد الرقم',
        message: `توجد أذون في تصنيف «ضريبي» بأرقام تصل إلى ${n.maxTax} و«غير ضريبي» بأرقام تصل إلى ${n.maxNontax}. تعيين رقم أقل قد يسبب تكرار أرقام عند الاعتماد. متابعة؟`,
        yesLabel: 'متابعة',
      });
      if (!ok) return;
    }
    await saveDocSequences(t, g);
    toast.success('تم حفظ ترقيم أذون الصرف');
  };

  const doWipe = async () => {
    if (wipeText !== 'احذف') return;
    setBusy(true);
    try {
      await db.wipeAll({ keepUsers: true });
      await db.logAudit({ entity: 'database', action: 'delete', entityId: 'wipe', details: 'حذف كل البيانات (منطقة الخطر)', actor: s.profile?.email });
      await useAgrima.getState().refresh();
      setWipeOpen(false);
      setWipeText('');
      toast.success('تم حذف كل البيانات — حسابات المستخدمين بقيت محفوظة');
    } finally {
      setBusy(false);
    }
  };

  const txCount = s.transactions.length;
  const prodCount = s.products.length;

  return (
    <div>
      <PageHead title="الإعدادات" />
      <div className="agr-grid-2">
        <div className="agr-card">
          <h3 className="font-extrabold text-sm mb-2">🏢 بيانات الشركة (تظهر في التقارير والطباعة)</h3>
          <div className="flex gap-2">
            <input className="flex-1 border rounded-lg px-3 py-2 text-sm" placeholder="مثال: مصنع الورق الحديث"
              value={company} onChange={(e) => setCompany(e.target.value)} />
            <button className="agr-btn agr-btn-primary" onClick={saveCompany}>حفظ</button>
          </div>
        </div>

        <div className="agr-card">
          <h3 className="font-extrabold text-sm mb-2">⚖️ معامل الوزن</h3>
          <p className="text-xs text-slate-500 mb-2">الوزن = المقاس × الرصيد × المعامل. القيمة الأصلية من ملف الإكسل هي 7.5.</p>
          <div className="flex gap-2">
            <input type="number" step="0.1" min="0" className="w-32 border rounded-lg px-3 py-2 text-sm"
              value={wf} onChange={(e) => setWf(e.target.value)} />
            <button className="agr-btn agr-btn-primary" onClick={saveWf}>حفظ</button>
          </div>
        </div>

        <div className="agr-card">
          <h3 className="font-extrabold text-sm mb-2">🔢 ترقيم أذون الصرف</h3>
          <p className="text-xs text-slate-500 mb-2">الرقم القادم المقترح لكل تصنيف — تسلسلان مستقلان (ضريبي / غير ضريبي).</p>
          <div className="flex gap-2 items-end flex-wrap">
            <label className="agr-field"><span>الرقم القادم — ضريبي</span>
              <input type="number" min={1} className="w-32" value={seqTax} onChange={(e) => setSeqTax(e.target.value)} />
            </label>
            <label className="agr-field"><span>الرقم القادم — غير ضريبي</span>
              <input type="number" min={1} className="w-32" value={seqNontax} onChange={(e) => setSeqNontax(e.target.value)} />
            </label>
            <button className="agr-btn agr-btn-primary" onClick={saveSeq}>حفظ</button>
          </div>
        </div>

        <div className="agr-card" style={{ borderColor: '#FECACA' }}>
          <h3 className="font-extrabold text-sm mb-2 text-red-700 flex items-center gap-2">
            <ShieldAlert size={16} /> منطقة الخطر
          </h3>
          <p className="text-xs text-slate-500 mb-2">
            حذف كل البيانات: الحركات والأصناف والرولات وأذون الصرف والعملاء والحجوزات والإعدادات التشغيلية.
            حسابات المستخدمين تبقى حتى لا تفقد الدخول. نزّل نسخة احتياطية أولًا!
          </p>
          <button className="agr-btn agr-btn-danger" onClick={() => setWipeOpen(true)}>
            <Database size={15} /> 🗑 حذف كل البيانات
          </button>
        </div>

        <div className="agr-card text-xs text-slate-600">
          <h3 className="font-extrabold text-sm mb-2 text-slate-800">🌐 اللغة والاتجاه</h3>
          التطبيق يعمل بالعربية واتجاه RTL بالكامل — الأرقام تُعرض بالأرقام الغربية لضمان دقة القيود.
        </div>
      </div>

      <Dialog open={wipeOpen} onOpenChange={(o) => !o && setWipeOpen(false)}>
        <DialogContent className="max-w-sm" dir="rtl">
          <DialogHeader><DialogTitle className="text-red-700">⚠️ حذف نهائي</DialogTitle></DialogHeader>
          <p className="text-sm">
            اكتب <b className="text-red-700">«احذف»</b> للتأكيد. سيتم حذف {fmtNum(txCount)} حركة و {fmtNum(prodCount)} صنف نهائيًا.
            نزّل نسخة احتياطية أولًا!
          </p>
          <input className="border rounded-lg px-3 py-2 text-sm" placeholder="احذف" value={wipeText} onChange={(e) => setWipeText(e.target.value)} />
          <DialogFooter>
            <button className="agr-btn agr-btn-danger" disabled={wipeText !== 'احذف' || busy} onClick={doWipe}>
              {busy ? 'جارٍ الحذف…' : 'حذف كل البيانات'}
            </button>
            <button className="agr-btn agr-btn-ghost" onClick={() => setWipeOpen(false)}>إلغاء</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
