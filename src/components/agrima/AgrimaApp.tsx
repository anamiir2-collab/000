'use client';

/* =========================================================================
   AgrimaApp.tsx — root: boot → first-run setup → login → ERP shell
   100% local: IndexedDB data, PBKDF2 auth, zero Supabase.
   ========================================================================= */

import { useEffect, useState } from 'react';
import { useAgrima } from '@/lib/agrima/store';
import { setProfile } from '@/lib/agrima/permissions';
import * as AUTH from '@/lib/agrima/auth';
import type { SessionProfile } from '@/lib/agrima/types';
import PrintRoot from './print/PrintRoot';
import Shell from './Shell';
import { ConfirmHost } from './ui-bits';
import { Toaster } from '@/components/ui/sonner';

function BootScreen({ status, error }: { status: string; error?: string | null }) {
  return (
    <div className="agr-boot">
      <div className="text-center">
        <div className="spinner" />
        <p className="font-bold text-[15px]">{error ? 'تعذر تشغيل البرنامج' : 'جاري التحميل…'}</p>
        <p className="text-xs text-slate-500 mt-1">{error || status}</p>
        {error && (
          <div className="mt-4">
            <button className="agr-btn agr-btn-primary" onClick={() => location.reload()}>إعادة المحاولة</button>
            <p className="text-xs text-slate-500 mt-3 max-w-sm mx-auto">
              بياناتك المحفوظة لم تُحذف — بقاءها مضمون في قاعدة البيانات المحلية على هذا الجهاز.
              إن كانت نسخة أخرى من البرنامج مفتوحة في تبويب آخر فأغلقها ثم أعد المحاولة.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function FirstRunSetup({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (!email.trim() || !password) { setErr('أدخل البريد وكلمة المرور'); return; }
    if (password !== confirm) { setErr('كلمتا المرور غير متطابقتين'); return; }
    setBusy(true);
    try {
      await AUTH.createFirstAdmin(email, fullName, password);
      onDone();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="agr-auth-scene">
      <div className="agr-auth-card">
        <div className="agr-auth-brand">
          <div className="agr-auth-logo">أ</div>
          <div>
            <div className="agr-auth-app">Agrima ERP</div>
            <div className="agr-auth-sub">نظام إدارة المخزون والبكر وأذون الصرف — يعمل محليًا بالكامل</div>
          </div>
        </div>
        <h2 className="agr-auth-title">إعداد أول تشغيل — إنشاء حساب مدير النظام</h2>
        <p className="text-xs text-slate-500 mb-3">
          هذا هو الحساب الأول على هذا الجهاز ويحصل على كل الصلاحيات. لا توجد أي كلمة مرور مثبتة مسبقًا في
          البرنامج — أنت من يحددها الآن، وتُخزَّن مشفّرة (PBKDF2) ولا تُكتب نصًا صريحًا في أي ملف.
        </p>
        <form onSubmit={submit} noValidate className="flex flex-col gap-3">
          <label className="agr-field"><span>الاسم الكامل</span>
            <input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="مثال: مدير النظام" />
          </label>
          <label className="agr-field"><span>البريد الإلكتروني *</span>
            <input type="email" dir="ltr" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" autoComplete="username" />
          </label>
          <label className="agr-field"><span>كلمة المرور * (8 أحرف على الأقل)</span>
            <input type="password" dir="ltr" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" autoComplete="new-password" />
          </label>
          <label className="agr-field"><span>تأكيد كلمة المرور *</span>
            <input type="password" dir="ltr" required value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="••••••••" autoComplete="new-password" />
          </label>
          {err && <div className="agr-form-error" role="alert">{err}</div>}
          <button className="agr-btn agr-btn-primary agr-auth-btn" disabled={busy} type="submit">
            {busy ? 'جارٍ إنشاء الحساب…' : 'إنشاء حساب مدير النظام'}
          </button>
        </form>
        <div className="agr-auth-foot">
          بيانات التطبيق تُخزَّن محليًا على هذا الجهاز (IndexedDB) — لا يوجد أي اتصال بخوادم خارجية.
        </div>
      </div>
    </div>
  );
}

function LoginScreen({ onSignedIn }: { onSignedIn: (profile: SessionProfile) => void }) {
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (!email || !pass) { setErr('أدخل البريد وكلمة المرور'); return; }
    setBusy(true);
    try {
      const profile = await AUTH.signIn(email, pass);
      setProfile(profile);
      onSignedIn(profile);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="agr-auth-scene">
      <div className="agr-auth-card">
        <div className="agr-auth-brand">
          <div className="agr-auth-logo">أ</div>
          <div>
            <div className="agr-auth-app">Agrima ERP</div>
            <div className="agr-auth-sub">نظام إدارة المخزون والبكر وأذون الصرف</div>
          </div>
        </div>
        <h2 className="agr-auth-title">تسجيل الدخول</h2>
        <p className="text-xs text-slate-500 mb-3">
          الدخول بحسابك الممنوح من مدير النظام — الحسابات والصلاحيات محفوظة محليًا على هذا الجهاز.
        </p>
        <form onSubmit={submit} noValidate className="flex flex-col gap-3">
          <label className="agr-field"><span>البريد الإلكتروني</span>
            <input type="email" dir="ltr" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" autoComplete="username" />
          </label>
          <label className="agr-field"><span>كلمة المرور</span>
            <input type="password" required value={pass} onChange={(e) => setPass(e.target.value)} placeholder="••••••••" autoComplete="current-password" />
          </label>
          {err && <div className="agr-form-error" role="alert">{err}</div>}
          <button className="agr-btn agr-btn-primary agr-auth-btn" disabled={busy} type="submit">
            {busy ? 'جارٍ التحقق…' : 'دخول'}
          </button>
        </form>
        <div className="agr-auth-foot">
          كلمات المرور محفوظة مشفّرة (PBKDF2-SHA256) ولا تُترك نصًا صريحًا — يعمل التطبيق دون إنترنت.
        </div>
      </div>
    </div>
  );
}

export default function AgrimaApp() {
  const { bootPhase, bootError, profile, boot, refresh } = useAgrima();
  const [status, setStatus] = useState('فتح قاعدة البيانات المحلية…');

  useEffect(() => {
    setStatus('فتح قاعدة البيانات المحلية…');
    boot();
    // PWA service worker (offline support) — https/localhost only
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
      const base = process.env.NEXT_PUBLIC_BASE_PATH || '';
      navigator.serviceWorker.register(`${base}/sw.js`, { updateViaCache: 'none' }).catch(() => { /* noop */ });
    }
  }, [boot]);

  const handleSignedIn = async (profile: SessionProfile) => {
    setStatus('تحميل البيانات…');
    await refresh();
    useAgrima.setState({ profile, bootPhase: 'ready' });
    const { navigate } = useAgrima.getState();
    navigate(profile.role === 'warehouse' ? 'inventory' : 'dashboard');
  };

  if (bootPhase === 'loading' || bootPhase === 'error') {
    return <BootScreen status={status} error={bootError} />;
  }

  if (bootPhase === 'first-run') {
    return <FirstRunSetup onDone={() => useAgrima.setState({ bootPhase: 'ready' })} />;
  }

  if (!profile) {
    return (
      <>
        <LoginScreen onSignedIn={handleSignedIn} />
        <ConfirmHost />
        <Toaster position="bottom-center" richColors />
      </>
    );
  }

  return (
    <>
      <Shell />
      <PrintRoot />
      <ConfirmHost />
      <Toaster position="bottom-center" richColors />
    </>
  );
}
