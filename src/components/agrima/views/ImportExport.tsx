'use client';

/* ImportExport — استيراد ملف الإكسل (الرصيد 2025 + اجمالي المخزن) والتصدير */

import { useRef, useState } from 'react';
import { useAgrima } from '@/lib/agrima/store';
import {
  parseBalanceWorkbook, parseWarehouseWorkbook, classifyImport, commitImport,
  commitWarehouseImport, checkFileImported, exportInventoryBuckets, exportTransactions,
  exportRollsList,
} from '@/lib/agrima/excel';
import { exportRollsList as _unused } from '@/lib/agrima/excel';
import { db } from '@/lib/agrima/db';
import { fileFingerprint, fmtDate, productFamily } from '@/lib/agrima/utils';
import { PageHead } from '../ui-bits';
import { toast } from 'sonner';
import { can, isWarehouse } from '@/lib/agrima/permissions';
import { Upload, FileSpreadsheet, Download, Info } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { confirmAction } from '../ui-bits';
import type { Product, Transaction, Roll, Reel } from '@/lib/agrima/types';

export default function ImportExport() {
  const s = useAgrima();
  const keeper = isWarehouse();
  const [dialog, setDialog] = useState<null | 'balance-merge' | 'balance-replace' | 'warehouse'>(null);

  if (keeper) {
    return (
      <div>
        <PageHead title="الاستيراد والتصدير" />
        <div className="agr-card text-sm font-bold text-red-700" style={{ borderInlineStart: '4px solid #DC2626' }}>
          لا تملك صلاحية الاستيراد أو التصدير — صلاحياتك للعرض والطباعة فقط.
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHead title="الاستيراد والتصدير" />
      <div className="agr-grid-2">
        <div className="agr-card">
          <h3 className="font-extrabold text-sm mb-1">📥 ملف «الرصيد 2025» — مصدر الرصيد الافتتاحي والحركات</h3>
          <p className="text-xs text-slate-500 mb-3">
            ورقتان: «الرصيد» (تعريف الأصناف) و«انتاج و مبيعات» (الحركات). الأوزان بالأطنان تُحوَّل تلقائيًا إلى كجم.
          </p>
          <div className="flex gap-2 flex-wrap">
            <button className="agr-btn agr-btn-primary" onClick={() => setDialog('balance-merge')}>📥 استيراد وإضافة</button>
            <button className="agr-btn agr-btn-warn" onClick={() => setDialog('balance-replace')}>♻️ استيراد مع الاستبدال</button>
          </div>
          {s.settings.lastImport && (
            <div className="text-[11px] text-slate-500 mt-2">
              آخر استيراد: {fmtDate(String(s.settings.lastImport.at).slice(0, 10))} — جديد: {s.settings.lastImport.newTx} — أصناف جديدة: {s.settings.lastImport.newProd}
            </div>
          )}
        </div>

        <div className="agr-card">
          <h3 className="font-extrabold text-sm mb-1">🗂 ملف «اجمالي المخزن 2025» — تفاصيل الرولات والبكر</h3>
          <p className="text-xs text-slate-500 mb-3">
            أعمدة: الكود (رول/بكرة)، طول، جرام، وزن(طن)، تاريخ الانتاج، النوع. تُحفظ بحالة «غير محددة» — لا تدخل الرصيد.
          </p>
          <button className="agr-btn agr-btn-primary" onClick={() => setDialog('warehouse')}>🗂 استيراد التفاصيل</button>
          {s.settings.lastWarehouseImport && (
            <div className="text-[11px] text-slate-500 mt-2">
              آخر استيراد: {fmtDate(String(s.settings.lastWarehouseImport.at).slice(0, 10))} — {s.settings.lastWarehouseImport.rolls} رول و {s.settings.lastWarehouseImport.reels} بكرة
            </div>
          )}
        </div>

        <div className="agr-card">
          <h3 className="font-extrabold text-sm mb-1">📤 تصدير Excel</h3>
          <div className="flex gap-2 flex-wrap mt-2">
            <button className="agr-btn agr-btn-ghost" onClick={() => {
              exportInventoryBuckets(Array.from(s.balancesW.values()).map((b) => ({
                quality: productFamily(b.quality), gsm: b.gsm, size: b.size, add: b.add, out: b.out, net: b.net,
                estWeight: Number(b.size) * b.net * s.settings.weightFactor,
                weight: b.weight ?? null,
              })), true);
              toast.success('تم تنزيل ملف الأرصدة');
            }}><Download size={14} /> 📊 الأرصدة</button>
            <button className="agr-btn agr-btn-ghost" onClick={() => { exportTransactions(s.transactions); toast.success('تم تنزيل ملف الحركات'); }}>
              <Download size={14} /> 🧾 الحركات
            </button>
            <button className="agr-btn agr-btn-ghost" onClick={async () => {
              const rolls: Roll[] = await db.getAll('rolls');
              const reels: Reel[] = await db.getAll('reels');
              const rollMap = new Map<number, Roll>();
              rolls.forEach((r) => rollMap.set(Number(r.rollNo), r));
              const rows: Parameters<typeof exportRollsList>[0] = reels
                .sort((a, b) => Number(b.rollNo) - Number(a.rollNo) || a.reelNo - b.reelNo)
                .map((reel) => ({ roll: rollMap.get(reel.rollNo) as Roll, reel }));
              exportRollsList(rows.filter((r) => r.roll));
              toast.success('تم تنزيل ملف الرولات والبكر');
            }}>
              <Download size={14} /> 🗂 الرولات والبكر
            </button>
          </div>
        </div>

        <div className="agr-card text-xs text-slate-600 flex items-start gap-2">
          <Info size={16} className="mt-0.5 flex-shrink-0 text-teal-700" />
          <div>
            <b>قاعدة منع مضاعفة المخزون:</b>
            <div className="mt-1">
              تفاصيل البكر المستوردة (اجمالي المخزن) تُحفظ بحالة «غير محددة» ولا تدخل حساب الرصيد —
              لأن الرصيد محسوب بالفعل من حركات ملف «الرصيد». استيراد نفس الملف مرتين مرفوض عبر بصمة الملف.
            </div>
          </div>
        </div>
      </div>

      {dialog === 'balance-merge' || dialog === 'balance-replace' ? (
        <BalanceImportDialog mode={dialog === 'balance-merge' ? 'merge' : 'replace'} onClose={() => setDialog(null)} />
      ) : dialog === 'warehouse' ? (
        <WarehouseImportDialog onClose={() => setDialog(null)} />
      ) : null}
    </div>
  );
}

function ImportZone({ onFile }: { onFile: (f: File) => void }) {
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div
      className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition ${drag ? 'border-teal-600 bg-teal-50' : 'border-slate-300 bg-white'}`}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
      role="button"
      aria-label="اختيار ملف الإكسل"
    >
      <Upload size={26} className="mx-auto text-slate-400" />
      <div className="text-sm font-bold mt-2">📁 اختر ملف الإكسل أو اسحبه هنا</div>
      <div className="text-[11px] text-slate-400 mt-1">.xlsx / .xls</div>
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xls"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }}
      />
    </div>
  );
}

function StatMini({ label, value, tone }: { label: string; value: string | number; tone?: 'ok' | 'warn' }) {
  return (
    <div className="border rounded-lg p-2 bg-white">
      <div className="text-[10px] text-slate-500 font-bold">{label}</div>
      <div className={`text-sm font-extrabold ${tone === 'warn' ? 'text-amber-600' : 'text-slate-800'}`}>{value}</div>
    </div>
  );
}

function BalanceImportDialog({ mode, onClose }: { mode: 'merge' | 'replace'; onClose: () => void }) {
  const s = useAgrima();
  const [fileName, setFileName] = useState('');
  const [cls, setCls] = useState<Awaited<ReturnType<typeof classifyImport>> | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [sheets, setSheets] = useState<{ name: string; ok: boolean }[]>([]);
  const [fp, setFp] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const onFile = async (f: File) => {
    setErr('');
    setCls(null);
    setFileName(f.name);
    try {
      const buf = await f.arrayBuffer();
      const digest = await fileFingerprint(buf);
      setFp(digest);
      const seen = await checkFileImported(digest);
      if (seen && mode === 'merge') {
        throw new Error(`⛔ هذا الملف نفسه تم استيراده سابقًا (${fmtDate(String(seen.at).slice(0, 10))}): ${seen.fileName}. الاستيراد المتكرر يمنع مضاعفة الرصيد — لتحديث الحركات استخدم الملف المحدّث (بصمته مختلفة) وسيُضاف الجديد فقط.`);
      }
      const parsed = await parseBalanceWorkbook(buf);
      const classified = await classifyImport(parsed);
      setCls(classified);
      setWarnings(parsed.stats.warnings);
      setSheets(parsed.stats.sheets.map((name) => ({
        name,
        ok: parsed.stats.balanceSheetFound && name.toLowerCase().includes('رصيد') || parsed.stats.txSheetFound,
      })));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const commit = async () => {
    if (!cls || !fp) return;
    setBusy(true);
    try {
      if (mode === 'replace') {
        const ok = await confirmAction({
          title: '⚠ استبدال بيانات الرصيد',
          danger: true,
          message: `سيتم استبدال الأصناف والحركات (${cls.transactions.length} حركة و ${cls.products.length} صنف) بمحتوى الملف فقط. تفاصيل الرولات والبكر وأذون الصرف والعملاء كلها تبقى كما هي. متابعة؟`,
          yesLabel: 'استبدال بيانات الرصيد',
        });
        if (!ok) return;
      }
      await commitImport(cls, mode, fileName, fp, s.profile?.email);
      await useAgrima.getState().refresh();
      toast.success(`تم الاستيراد: ${cls.newTx} حركة جديدة، ${cls.newProd} صنف جديد — تم تخطي التكرارات`);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle>{mode === 'replace' ? 'استيراد مع استبدال بيانات الرصيد' : 'استيراد ملف الإكسل'}</DialogTitle>
        </DialogHeader>
        <ImportZone onFile={onFile} />
        {fileName && <div className="text-xs text-slate-500">الملف: {fileName}</div>}
        {err && <div className="agr-form-error">{err}</div>}
        {cls && (
          <>
            <div className="grid grid-cols-3 gap-2">
              <StatMini label="أصناف في الملف" value={cls.prodRows + cls.existingProd} />
              <StatMini label="حركات في الملف" value={cls.txRows} />
              <StatMini label="جديدة (ستُحفظ)" value={cls.newTx} tone="ok" />
              <StatMini label="مكررة (موجودة في القاعدة)" value={cls.dupTx} tone="warn" />
              <StatMini label="صفوف متطابقة داخل الملف (تُحفظ كسجلات منفصلة)" value={cls.inFileDup} tone="warn" />
              <StatMini label="حركات ملغاة (لاغي)" value={cls.voidTx} tone="warn" />
              <StatMini label="حركات ناقصة (بدون جرام/مقاس)" value={cls.incompleteTx} tone="warn" />
              <StatMini label="أصناف جديدة" value={cls.newProd} tone="ok" />
              <StatMini label="أصناف موجودة (تخطي)" value={cls.existingProd} />
            </div>
            <div className="text-[11px] text-slate-500">
              الورق المكتشفة: {cls.balanceSheetFound ? '✓ الرصيد' : '⚠ لم تُعثر ورقة الرصيد'} — {cls.txSheetFound ? '✓ انتاج و مبيعات' : '⚠ لم تُعثر ورقة الحركات'}
            </div>
            {warnings.length > 0 && (
              <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded p-2 max-h-24 overflow-y-auto">
                {warnings.slice(0, 8).map((w, i) => <div key={i}>• {w}</div>)}
              </div>
            )}
            <details className="text-xs">
              <summary className="cursor-pointer font-bold">معاينة أول 5 حركات جديدة</summary>
              <div className="agr-table-wrap mt-2">
                <table className="agr-table">
                  <thead><tr><th>التاريخ</th><th>اسم الصنف</th><th>الجرام</th><th>المقاس</th><th>العميل / الجهة</th><th>الكمية المضافة</th><th>الكمية المنصرفة</th></tr></thead>
                  <tbody>
                    {cls.transactions.slice(0, 5).map((t: Transaction, i: number) => (
                      <tr key={i}>
                        <td className="num">{t.date}</td>
                        <td>{productFamily(t.quality)}</td>
                        <td className="num">{String(t.gsm ?? '')}</td>
                        <td className="num">{String(t.size ?? '')}</td>
                        <td>{t.customer}</td>
                        <td className="num">{t.addQty || ''}</td>
                        <td className="num">{t.outQty || ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        )}
        <DialogFooter>
          <button className="agr-btn agr-btn-primary" disabled={!cls || busy} onClick={commit}>
            {busy ? 'جارٍ الحفظ…' : mode === 'replace' ? 'استبدال بيانات الرصيد' : 'حفظ السجلات الجديدة'}
          </button>
          <button className="agr-btn agr-btn-ghost" onClick={onClose}>إلغاء</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WarehouseImportDialog({ onClose }: { onClose: () => void }) {
  const s = useAgrima();
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<Awaited<ReturnType<typeof parseWarehouseWorkbook>> | null>(null);
  const [fp, setFp] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const onFile = async (f: File) => {
    setErr('');
    setParsed(null);
    setFileName(f.name);
    try {
      const buf = await f.arrayBuffer();
      const digest = await fileFingerprint(buf);
      setFp(digest);
      const seen = await checkFileImported(digest);
      if (seen) {
        throw new Error(`⛔ هذا الملف نفسه تم استيراده سابقًا (${fmtDate(String(seen.at).slice(0, 10))}): ${seen.fileName}`);
      }
      const p = await parseWarehouseWorkbook(buf);
      setParsed(p);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const commit = async () => {
    if (!parsed || !fp) return;
    setBusy(true);
    try {
      const res = await commitWarehouseImport(parsed.rolls, fileName, fp, s.profile?.email);
      await useAgrima.getState().refresh();
      toast.success(`تم استيراد التفاصيل: ${res.rolls} رول و ${res.reels} بكرة بحالة «غير محددة» — الرصيد لم يتغير (تخطي ${res.skipped})`);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl max-h-[88vh] overflow-y-auto" dir="rtl">
        <DialogHeader><DialogTitle>استيراد تفاصيل الرولات والبكر — «اجمالي المخزن 2025»</DialogTitle></DialogHeader>
        <ImportZone onFile={onFile} />
        {fileName && <div className="text-xs text-slate-500">الملف: {fileName}</div>}
        {err && <div className="agr-form-error">{err}</div>}
        {parsed && (
          <>
            <div className="grid grid-cols-3 gap-2">
              <StatMini label="رولات في الملف" value={parsed.stats.rolls as number} />
              <StatMini label="بكر في الملف" value={parsed.stats.reels as number} />
              <StatMini label="أعلى رقم رول" value={parsed.stats.maxRoll as number} />
              <StatMini label="إجمالي الوزن (كجم)" value={parsed.stats.totalWeight as number} />
              <StatMini label="بكر بلا صنف" value={parsed.stats.noQuality as number} tone="warn" />
              <StatMini label="الفترة" value={String(parsed.stats.period || '—')} />
            </div>
            <div className="text-[11px] bg-teal-50 border border-teal-100 text-teal-800 rounded p-2">
              ستُحفظ كل البكر بحالة «غير محددة» — سجل تفاصيل فقط لا يدخل الرصيد، ولن يُضاعف المخزون.
            </div>
            {parsed.warnings.length > 0 && (
              <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded p-2 max-h-24 overflow-y-auto">
                {parsed.warnings.slice(0, 8).map((w, i) => <div key={i}>• {w}</div>)}
              </div>
            )}
          </>
        )}
        <DialogFooter>
          <button className="agr-btn agr-btn-primary" disabled={!parsed || busy} onClick={commit}>
            {busy ? 'جارٍ الحفظ…' : 'حفظ التفاصيل'}
          </button>
          <button className="agr-btn agr-btn-ghost" onClick={onClose}>إلغاء</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
