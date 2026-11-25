/* =========================================================================
   permissions.ts — role matrix enforced at router AND operation level
   Roles:
     admin     مدير النظام — كل الأقسام وكل العمليات دون استثناء.
     warehouse أمين المخزن — عرض الرصيد الحالي + أذون اليوم والأمس (توقيت
                 مصر) + الطباعة فقط. لا إضافة/تعديل/حذف/اعتماد/تصدير/استيراد/
                 نسخ احتياطي/إعدادات/مستخدمين.
   ملاحظة أمنية: التطبيق محلي بالكامل؛ الصلاحيات تحكم الواجهة وعمليات
   التطبيق على بيانات هذا الجهاز، ولا توفر حماية ضد من يعدّل بيانات
   المتصفح مباشرة.
   ========================================================================= */

import { cairoToday, inKeeperWindow, keeperWindowStart } from './utils';
import type { Role, Route } from './types';

export const ROLES = { ADMIN: 'admin' as Role, WAREHOUSE: 'warehouse' as Role, NONE: '' };

export type Capability =
  | 'add' | 'edit' | 'delete' | 'approve' | 'settlement' | 'stockWrite'
  | 'oldPermits' | 'reports' | 'customersView' | 'usersManage'
  | 'settings' | 'importExport' | 'backup' | 'auditView' | 'print';

const CAPABILITIES: Capability[] = [
  'add', 'edit', 'delete', 'approve', 'settlement', 'stockWrite',
  'oldPermits', 'reports', 'customersView', 'usersManage',
  'settings', 'importExport', 'backup', 'auditView', 'print',
];

export const ROUTE_ACCESS: Record<string, 'all' | Route[]> = {
  admin: 'all',
  warehouse: ['inventory', 'issuedocs', 'issuedoc'],
  '': [],
};

const MATRIX: Record<string, Partial<Record<Capability, boolean>>> = {
  admin: CAPABILITIES.reduce((m, c) => { m[c] = true; return m; }, {} as Partial<Record<Capability, boolean>>),
  warehouse: { print: true },
  '': {},
};

export interface PermState {
  role: Role | '';
  userId: string | null;
  email: string | null;
  fullName: string;
  active: boolean;
}

let state: PermState = { role: '', userId: null, email: null, fullName: '', active: true };

export function setProfile(p: { id?: string; email?: string; fullName?: string; role?: Role | ''; active?: boolean } | null): void {
  state = {
    role: (p?.role as Role) ?? '',
    userId: p?.id ?? null,
    email: p?.email ?? null,
    fullName: p?.fullName ?? '',
    active: p ? p.active !== false : true,
  };
  if (state.role === ROLES.ADMIN && !state.active) state.role = '';
}

export function role(): Role | '' { return state.role; }
export function isAdmin(): boolean { return state.role === ROLES.ADMIN; }
export function isWarehouse(): boolean { return state.role === ROLES.WAREHOUSE; }
export function signedIn(): boolean { return state.role === ROLES.ADMIN || state.role === ROLES.WAREHOUSE; }

export function can(cap: Capability): boolean {
  const m = MATRIX[state.role];
  return !!(m && m[cap]);
}

export function routeAllowed(route: Route): boolean {
  const access = ROUTE_ACCESS[state.role] ?? [];
  if (access === 'all') return true;
  return access.indexOf(route) >= 0;
}

export function roleLabel(r?: Role | '' | null): string {
  const v = r == null ? state.role : r;
  return v === ROLES.ADMIN ? 'مدير النظام'
    : v === ROLES.WAREHOUSE ? 'أمين المخزن'
    : 'بدون صلاحيات';
}

export { cairoToday, keeperWindowStart, inKeeperWindow };
