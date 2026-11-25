'use client';

/* Users — المستخدمون والصلاحيات (محلي بالكامل) + سجل العمليات */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAgrima } from '@/lib/agrima/store';
import * as AUTH from '@/lib/agrima/auth';
import { db } from '@/lib/agrima/db';
import { fmtNum } from '@/lib/agrima/utils';
import { PageHead, EmptyRow, confirmAction } from '../ui-bits';
import { toast } from 'sonner';
import { can } from '@/lib/agrima/permissions';
import { Plus, KeyRound, Pencil, Pause, Play, Trash2, History, RefreshCw, Search } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import type { AuditEntry, LocalUser, Role } from '@/lib/agrima/types';

export default function Users({ mode }: { mode: 'users' | 'audit' }) {
  return mode === 'users' ? <UsersView /> : <AuditView />;
}

function UsersView() {
  const s = useAgrima();
  const [users, setUsers] = useState<LocalUser[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [editUser, setEditUser] = useState<LocalUser | null>(null);
  const [roleUser, setRoleUser] = useState<LocalUser | null>(null);
  const [resetUser, setResetUser] = useState<LocalUser | null>(null);
  const [logsUser, setLogsUser] = useState<LocalUser | null>(null);
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null);

  const reload = useCallback(() => { AUTH.listUsers().then(setUsers); }, []);
  useEffect(() => { reload(); }, [reload]);

  const lastAdmin = (u: LocalUser) => u.role === 'admin' && u.active && users.filter((x) => x.role === 'admin' && x.active).length <= 1;

  const toggleActive = async (u: LocalUser) => {
    const ok = await confirmAction({
      title: u.active ? 'إيقاف الحساب' : 'تفعيل الحساب',
      danger: u.active,
      message: u.active
        ? `إيقاف حساب "${u.fullName || u.email}"؟ سيفقد الوصول لكل البيانات فورًا (بما فيها الجلسات القائمة).`
        : `تفعيل حساب "${u.fullName || u.email}"؟`,
      yesLabel: u.active ? 'إيقاف' : 'تفعيل',
    });
    if (!ok) return;
    await AUTH.setUserActive(u.id, !u.active, s.profile?.email);
    toast.success(u.active ? 'تم إيقاف الحساب' : 'تم تفعيل الحساب');
    reload();
  };

  const del = async (u: LocalUser) => {
    const ok = await confirmAction({
      title: 'حذف المستخدم', danger: true,
      message: `حذف المستخدم "${u.email}" نهائيًا؟ لا يمكن التراجع.`,
      yesLabel: 'حذف نهائي',
    });
    if (!ok) return;
    try {
      await AUTH.deleteUser(u.id, s.profile?.id || '', s.profile?.email);
      toast.success('تم حذف المستخدم');
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <PageHead title="المستخدمون والصلاحيات">
        <button className="agr-btn agr-btn-primary" onClick={() => setAddOpen(true)}><Plus size={15} /> مستخدم جديد</button>
      </PageHead>
      <div className="agr-card mb-3 text-xs text-slate-600">
        الأدوار: <b>مدير النظام</b> — كل الصلاحيات دون استثناء · <b>أمين المخزن</b> — عرض الرصيد الحالي وأذون اليوم
        والأمس وطباعتها فقط، بلا أي إضافة أو تعديل أو حذف. الحسابات وكلمات المرور محفوظة محليًا (PBKDF2-SHA256) —
        لا توجد كلمات مرور نص صريح في أي ملف.
      </div>

      <div className="agr-table-wrap">
        <table className="agr-table">
          <thead>
            <tr><th>الاسم</th><th>البريد الإلكتروني</th><th>الدور</th><th>الحالة</th><th>آخر دخول</th><th>تاريخ الإنشاء</th><th>إجراءات</th></tr>
          </thead>
          <tbody>
            {users.length === 0 && <EmptyRow colSpan={7} text="لا يوجد مستخدمون — أضف أول حساب" />}
            {users.map((u) => {
              const isSelf = u.id === s.profile?.id;
              return (
                <tr key={u.id} className={!u.active ? 'agr-row-void' : ''}>
                  <td className="text-start font-bold">
                    {u.fullName || '—'}
                    {isSelf && <span className="agr-badge agr-badge-multi mr-1">أنت</span>}
                  </td>
                  <td dir="ltr" className="text-xs">{u.email}</td>
                  <td>
                    {u.role === 'admin' && <span className="agr-badge agr-badge-tax">مدير النظام</span>}
                    {u.role === 'warehouse' && <span className="agr-badge agr-badge-nontax">أمين المخزن</span>}
                    {!u.role && <span className="agr-badge agr-badge-draft">بدون دور</span>}
                  </td>
                  <td>
                    {u.active ? <span className="agr-badge agr-badge-approved">نشط</span> : <span className="agr-badge agr-badge-void">موقوف</span>}
                  </td>
                  <td className="text-[11px]" dir="ltr">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('en-GB') : '—'}</td>
                  <td className="text-[11px]" dir="ltr">{u.createdAt ? new Date(u.createdAt).toLocaleDateString('en-GB') : '—'}</td>
                  <td>
                    <div className="flex gap-1 justify-center">
                      <button className="agr-icon-btn" title="سجل عمليات المستخدم" onClick={() => setLogsUser(u)}><History size={14} /></button>
                      <button className="agr-icon-btn" title="إعادة تعيين كلمة المرور" onClick={() => setResetUser(u)}><KeyRound size={14} /></button>
                      <button className="agr-icon-btn" title="تغيير الدور" onClick={() => setRoleUser(u)}><Pencil size={14} /></button>
                      {!isSelf && (
                        <button className="agr-icon-btn" title={u.active ? 'إيقاف الحساب' : 'تفعيل الحساب'} onClick={() => toggleActive(u)}>
                          {u.active ? <Pause size={14} /> : <Play size={14} />}
                        </button>
                      )}
                      {!isSelf && !lastAdmin(u) && (
                        <button className="agr-icon-btn danger" title="حذف" onClick={() => del(u)}><Trash2 size={14} /></button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <AddUserDialog open={addOpen} onClose={() => setAddOpen(false)} onCreated={(c) => { setAddOpen(false); setCreated(c); reload(); }} />
      {editUser && <EditUserDialog user={editUser} onClose={() => setEditUser(null)} onDone={() => { setEditUser(null); reload(); }} />}
      {roleUser && <RoleDialog user={roleUser} onClose={() => setRoleUser(null)} onDone={() => { setRoleUser(null); reload(); }} />}
      {resetUser && <ResetPasswordDialog user={resetUser} onClose={() => setResetUser(null)} onDone={() => { setResetUser(null); reload(); }} />}
      {logsUser && <UserLogsDialog user={logsUser} onClose={() => setLogsUser(null)} />}

      {created && (
        <Dialog open onOpenChange={(o) => !o && setCreated(null)}>
          <DialogContent className="max-w-md" dir="rtl">
            <DialogHeader><DialogTitle>بيانات الدخول</DialogTitle></DialogHeader>
            <p className="text-sm">تم إنشاء الحساب بنجاح. ستُعرض كلمة المرور مرة واحدة فقط — انسخها وأعطها للمستخدم. لا تُخزن في أي ملف.</p>
            <div className="bg-slate-50 border rounded p-3 text-sm font-mono" dir="ltr">
              <div><b>Email:</b> {created.email}</div>
              <div><b>Password:</b> {created.password}</div>
            </div>
            <DialogFooter>
              <button className="agr-btn agr-btn-primary" onClick={async () => {
                try {
                  await navigator.clipboard.writeText(`Email: ${created.email}\nPassword: ${created.password}`);
                  toast.success('تم نسخ بيانات الدخول');
                } catch { toast.error('تعذر النسخ — انسخها يدويًا'); }
              }}>نسخ بيانات الدخول</button>
              <button className="agr-btn agr-btn-ghost" onClick={() => setCreated(null)}>إغلاق</button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function AddUserDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (c: { email: string; password: string }) => void }) {
  const s = useAgrima();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('warehouse');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setPassword(AUTH.generatePassword(14));
  }, [open]);

  const submit = async () => {
    setErr('');
    setBusy(true);
    try {
      const res = await AUTH.createUser({ email, fullName, role, password, actor: s.profile?.email });
      onCreated({ email: res.user.email, password: res.plainPassword });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md" dir="rtl">
        <DialogHeader><DialogTitle>مستخدم جديد</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="agr-field"><span>الاسم الكامل</span>
            <input placeholder="مثال: محمد أمين المخزن" value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </label>
          <label className="agr-field"><span>البريد الإلكتروني *</span>
            <input type="email" dir="ltr" placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="agr-field"><span>الدور *</span>
            <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="warehouse">أمين مخزن — قراءة وطباعة فقط</option>
              <option value="admin">مدير نظام — كل الصلاحيات</option>
            </select>
          </label>
          <label className="agr-field"><span>كلمة المرور *</span>
            <div className="flex gap-2">
              <input dir="ltr" className="font-mono flex-1" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              <button type="button" className="agr-btn agr-btn-ghost agr-btn-sm" onClick={() => setPassword(AUTH.generatePassword(14))}>توليد كلمة مرور قوية</button>
            </div>
          </label>
          <p className="text-[11px] text-slate-500">ستُعرض كلمة المرور مرة واحدة بعد الإنشاء — انسخها وأعطها للمستخدم. لا تُخزن في أي ملف.</p>
          {err && <div className="agr-form-error">{err}</div>}
        </div>
        <DialogFooter>
          <button className="agr-btn agr-btn-primary" disabled={busy} onClick={submit}>{busy ? 'جارٍ إنشاء الحساب…' : 'إنشاء الحساب'}</button>
          <button className="agr-btn agr-btn-ghost" onClick={onClose}>إلغاء</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditUserDialog({ user, onClose, onDone }: { user: LocalUser; onClose: () => void; onDone: () => void }) {
  const s = useAgrima();
  const [fullName, setFullName] = useState(user.fullName);
  const [email, setEmail] = useState(user.email);
  const [err, setErr] = useState('');
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm" dir="rtl">
        <DialogHeader><DialogTitle>تعديل بيانات المستخدم</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="agr-field"><span>الاسم الكامل</span><input value={fullName} onChange={(e) => setFullName(e.target.value)} /></label>
          <label className="agr-field"><span>البريد الإلكتروني</span><input dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          {err && <div className="agr-form-error">{err}</div>}
        </div>
        <DialogFooter>
          <button className="agr-btn agr-btn-primary" onClick={async () => {
            try {
              await AUTH.updateUser(user.id, { fullName, email }, s.profile?.email);
              toast.success('تم حفظ التعديلات');
              onDone();
            } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
          }}>حفظ</button>
          <button className="agr-btn agr-btn-ghost" onClick={onClose}>إلغاء</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RoleDialog({ user, onClose, onDone }: { user: LocalUser; onClose: () => void; onDone: () => void }) {
  const s = useAgrima();
  const [role, setRole] = useState<Role | ''>(user.role);
  const [err, setErr] = useState('');
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm" dir="rtl">
        <DialogHeader><DialogTitle>تغيير دور: {user.fullName || user.email}</DialogTitle></DialogHeader>
        <label className="agr-field"><span>دور المستخدم</span>
          <select value={role} onChange={(e) => setRole(e.target.value as Role | '')}>
            <option value="admin">مدير النظام — كل الصلاحيات</option>
            <option value="warehouse">أمين المخزن — قراءة وطباعة فقط</option>
            <option value="">بدون دور — لا وصول</option>
          </select>
        </label>
        {user.role === 'admin' && user.active && role !== 'admin' && (
          <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
            تنبيه: هذا آخر مدير نظام فعّال — تغيير دوره قد يفقدك إدارة النظام.
          </p>
        )}
        {err && <div className="agr-form-error">{err}</div>}
        <DialogFooter>
          <button className="agr-btn agr-btn-primary" onClick={async () => {
            try {
              await AUTH.changeRole(user.id, role, s.profile?.email);
              toast.success('تم تحديث الدور — يسري فورًا');
              onDone();
            } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
          }}>حفظ</button>
          <button className="agr-btn agr-btn-ghost" onClick={onClose}>إلغاء</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordDialog({ user, onClose, onDone }: { user: LocalUser; onClose: () => void; onDone: () => void }) {
  const s = useAgrima();
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { setPassword(AUTH.generatePassword(14)); }, []);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm" dir="rtl">
        <DialogHeader><DialogTitle>إعادة تعيين كلمة المرور</DialogTitle></DialogHeader>
        <p className="text-xs text-slate-500">تعيين كلمة مرور جديدة لـ <b dir="ltr">{user.email}</b>. سيتم تسجيل العملية في سجل العمليات.</p>
        <label className="agr-field"><span>كلمة المرور الجديدة *</span>
          <div className="flex gap-2">
            <input dir="ltr" className="font-mono flex-1" value={password} onChange={(e) => setPassword(e.target.value)} />
            <button type="button" className="agr-btn agr-btn-ghost agr-btn-sm" onClick={() => setPassword(AUTH.generatePassword(14))}>توليد</button>
          </div>
        </label>
        {err && <div className="agr-form-error">{err}</div>}
        <DialogFooter>
          <button className="agr-btn agr-btn-primary" onClick={async () => {
            try {
              const email = await AUTH.resetPassword(user.id, password, s.profile?.email);
              toast.success(`تم تعيين كلمة المرور الجديدة لـ ${email}`);
              onDone();
            } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
          }}>تعيين كلمة المرور</button>
          <button className="agr-btn agr-btn-ghost" onClick={onClose}>إلغاء</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UserLogsDialog({ user, onClose }: { user: LocalUser; onClose: () => void }) {
  const [rows, setRows] = useState<AuditEntry[]>([]);
  useEffect(() => {
    db.getAudit(2000).then((all) => {
      setRows(all.filter((r) => (r.actor || '') === user.email || (r.details || '').includes(user.email)).slice(0, 200));
    });
  }, [user]);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto" dir="rtl">
        <DialogHeader><DialogTitle>سجل عمليات: {user.email}</DialogTitle></DialogHeader>
        <div className="agr-table-wrap">
          <table className="agr-table">
            <thead><tr><th>الوقت</th><th>العملية</th><th>القسم</th><th>تفاصيل</th></tr></thead>
            <tbody>
              {rows.length === 0 && <EmptyRow colSpan={4} text="لا توجد عمليات مسجلة لهذا المستخدم" />}
              {rows.map((r, i) => (
                <tr key={i}>
                  <td className="text-[11px]" dir="ltr">{new Date(r.at).toLocaleString('en-GB')}</td>
                  <td className="text-[11px]">{r.action}</td>
                  <td className="text-[11px]">{r.entity}</td>
                  <td className="text-[11px] text-start">{r.details || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <DialogFooter><button className="agr-btn agr-btn-ghost" onClick={onClose}>إغلاق</button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------ audit ------------------------------ */

function AuditView() {
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [q, setQ] = useState('');
  const [entity, setEntity] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    setLoading(true);
    db.getAudit(2000).then((all) => { setRows(all); setLoading(false); });
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const filtered = useMemo(() => {
    let list = rows;
    if (q) {
      const t = q.toLowerCase();
      list = list.filter((r) => (r.details || '').toLowerCase().includes(t) || (r.actor || '').toLowerCase().includes(t));
    }
    if (entity) list = list.filter((r) => r.entity === entity);
    if (from) list = list.filter((r) => r.at.slice(0, 10) >= from);
    if (to) list = list.filter((r) => r.at.slice(0, 10) <= to);
    return list.slice(0, 500);
  }, [rows, q, entity, from, to]);

  const entityLabels: Record<string, string> = {
    movement: 'الحركات', permit: 'أذون الصرف', roll: 'الرولات', reel: 'البكر',
    product: 'الأصناف', user: 'المستخدمون', database: 'قاعدة البيانات', customer: 'العملاء',
  };

  return (
    <div>
      <PageHead title="سجل العمليات">
        <button className="agr-btn agr-btn-ghost" onClick={reload}><RefreshCw size={14} /> تحديث</button>
      </PageHead>
      <div className="agr-card mb-3 text-xs text-slate-600">
        سجل غير قابل للتعديل يوثق: تسجيل الدخول والخروج، أذون الصرف (إنشاء/اعتماد/تعديل/حذف)، تغييرات المخزون،
        إدارة المستخدمين، والنسخ الاحتياطي والاستعادة — محفوظ محليًا على هذا الجهاز.
      </div>

      <div className="agr-card filters mb-3">
        <label className="agr-fl"><span>بحث</span>
          <div className="relative">
            <Search size={14} className="absolute top-1/2 -translate-y-1/2 start-2 text-slate-400" />
            <input className="ps-7" placeholder="بحث في التفاصيل…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </label>
        <label className="agr-fl"><span>القسم</span>
          <select value={entity} onChange={(e) => setEntity(e.target.value)}>
            <option value="">الكل</option>
            {Object.entries(entityLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="agr-fl"><span>من تاريخ</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="agr-fl"><span>إلى تاريخ</span><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button className="agr-btn agr-btn-ghost agr-btn-sm" onClick={() => { setQ(''); setEntity(''); setFrom(''); setTo(''); }}>مسح الفلاتر</button>
      </div>

      <div className="agr-table-wrap">
        <table className="agr-table">
          <thead><tr><th>الوقت</th><th>المستخدم</th><th>العملية</th><th>القسم</th><th>التفاصيل</th></tr></thead>
          <tbody>
            {loading && <EmptyRow colSpan={5} text="جارٍ التحميل…" />}
            {!loading && filtered.length === 0 && <EmptyRow colSpan={5} text="لا توجد عمليات مطابقة" />}
            {!loading && filtered.map((r, i) => (
              <tr key={i}>
                <td className="text-[11px]" dir="ltr">{new Date(r.at).toLocaleString('en-GB')}</td>
                <td className="text-[11px]" dir="ltr">{r.actor || '—'}</td>
                <td className="text-[11px]">{r.action}</td>
                <td className="text-[11px]">{entityLabels[r.entity] || r.entity}</td>
                <td className="text-[11px] text-start">{r.details || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="text-[11px] text-slate-400 mt-1">يُعرض أول {fmtNum(filtered.length)} عملية من أصل {fmtNum(rows.length)}</div>
    </div>
  );
}
