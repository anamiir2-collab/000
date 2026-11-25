'use client';

/* Account — حسابي: البيانات + تغيير كلمة المرور + تسجيل الخروج */

import { useState } from 'react';
import { useAgrima } from '@/lib/agrima/store';
import * as AUTH from '@/lib/agrima/auth';
import { roleLabel } from '@/lib/agrima/permissions';
import { PageHead } from '../ui-bits';
import { toast } from 'sonner';
import { LogOut, KeyRound } from 'lucide-react';
import { db } from '@/lib/agrima/db';

export default function Account() {
  const s = useAgrima();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const changePassword = async () => {
    setErr('');
    if (!current || !next) { setErr('أكمل الحقول'); return; }
    if (next !== confirm) { setErr('كلمتا المرور غير متطابقتين'); return; }
    setBusy(true);
    try {
      await AUTH.changeMyPassword(s.profile?.id || '', current, next);
      await db.logAudit({ entity: 'user', action: 'user-password-change', entityId: s.profile?.id, details: 'تغيير كلمة المرور من المستخدم نفسه', actor: s.profile?.email });
      setCurrent(''); setNext(''); setConfirm('');
      toast.success('تم تغيير كلمة المرور بنجاح');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doLogout = async () => {
    await useAgrima.getState().signOut();
    try { location.hash = ''; } catch { /* noop */ }
    location.reload();
  };

  return (
    <div>
      <PageHead title="حسابي" />
      <div className="agr-grid-2">
        <div className="agr-card">
          <h3 className="font-extrabold text-sm mb-3">بيانات الحساب</h3>
          <div className="flex items-center gap-3 mb-3">
            <span className="agr-avatar" style={{ width: 44, height: 44, fontSize: 18 }}>
              {(s.profile?.fullName || s.profile?.email || '؟').charAt(0)}
            </span>
            <div>
              <div className="font-extrabold">{s.profile?.fullName}</div>
              <div className="text-xs text-slate-500" dir="ltr">{s.profile?.email}</div>
            </div>
          </div>
          <div className="text-xs">
            <div className="flex justify-between border-b py-1.5"><span className="text-slate-500">الدور</span><b>{roleLabel()}</b></div>
            <div className="flex justify-between border-b py-1.5"><span className="text-slate-500">الحالة</span><b>نشط</b></div>
            <div className="flex justify-between py-1.5"><span className="text-slate-500">التخزين</span><b>محلي على هذا الجهاز (IndexedDB)</b></div>
          </div>
          <button className="agr-btn agr-btn-danger mt-3" onClick={doLogout}><LogOut size={15} /> تسجيل الخروج</button>
        </div>

        <div className="agr-card">
          <h3 className="font-extrabold text-sm mb-3 flex items-center gap-2"><KeyRound size={16} /> تغيير كلمة المرور</h3>
          <div className="flex flex-col gap-3">
            <label className="agr-field"><span>كلمة المرور الحالية</span>
              <input type="password" dir="ltr" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
            </label>
            <label className="agr-field"><span>كلمة المرور الجديدة (8 أحرف على الأقل)</span>
              <input type="password" dir="ltr" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
            </label>
            <label className="agr-field"><span>تأكيد كلمة المرور الجديدة</span>
              <input type="password" dir="ltr" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </label>
            {err && <div className="agr-form-error">{err}</div>}
            <button className="agr-btn agr-btn-primary self-start" disabled={busy} onClick={changePassword}>
              {busy ? 'جارٍ التغيير…' : 'تغيير كلمة المرور'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
