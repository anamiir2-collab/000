'use client';

/* =========================================================================
   Shell.tsx — sidebar / topbar / bottom-nav + permission-aware hash router
   ========================================================================= */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAgrima, routeTitle } from '@/lib/agrima/store';
import { routeAllowed, roleLabel, isAdmin, isWarehouse } from '@/lib/agrima/permissions';
import type { Route } from '@/lib/agrima/types';
import { toast } from 'sonner';
import {
  LayoutDashboard, Boxes, FileOutput, CalendarCheck, ArrowDownToLine, Factory,
  PlusCircle, Rows3, UsersRound, Tag, BarChart3, Import, DatabaseBackup,
  ShieldCheck, UserCog, Settings as SettingsIcon, UserCircle, LogOut, Menu, WifiOff,
} from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Dashboard from './views/Dashboard';
import Inventory from './views/Inventory';
import TxTables from './views/TxTables';
import ReelsAdd from './views/ReelsAdd';
import Rolls from './views/Rolls';
import Issuedocs from './views/Issuedocs';
import IssueForm from './views/IssueForm';
import IssuedocView from './views/IssuedocView';
import Reservations, { CustomersView } from './views/Reservations';
import Reports from './views/Reports';
import ImportExport from './views/ImportExport';
import BackupSettings from './views/BackupSettings';
import Users from './views/Users';
import Account from './views/Account';

interface NavItem { route: Route; label: string; icon: React.ComponentType<{ size?: number | string }> }

const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: 'الرئيسية',
    items: [
      { route: 'dashboard', label: 'لوحة التحكم', icon: LayoutDashboard },
      { route: 'inventory', label: 'الرصيد الحالي', icon: Boxes },
    ],
  },
  {
    title: 'العمليات',
    items: [
      { route: 'issuedocs', label: 'أذون الصرف', icon: FileOutput },
      { route: 'reservations', label: 'حجوزات العملاء', icon: CalendarCheck },
      { route: 'outlog', label: 'سجل حركات الصرف', icon: ArrowDownToLine },
      { route: 'production', label: 'سجل الإنتاج', icon: Factory },
    ],
  },
  {
    title: 'الإدخال',
    items: [
      { route: 'reels-add', label: 'تسجيل البكر', icon: PlusCircle },
      { route: 'rolls', label: 'إدارة الرولات والبكر', icon: Rows3 },
    ],
  },
  {
    title: 'البيانات',
    items: [
      { route: 'customers', label: 'العملاء', icon: UsersRound },
      { route: 'products', label: 'إدارة الأصناف', icon: Tag },
    ],
  },
  {
    title: 'الإدارة',
    items: [
      { route: 'reports', label: 'التقارير', icon: BarChart3 },
      { route: 'import', label: 'الاستيراد والتصدير', icon: Import },
      { route: 'backup', label: 'النسخ الاحتياطي', icon: DatabaseBackup },
      { route: 'audit', label: 'سجل العمليات', icon: ShieldCheck },
      { route: 'users', label: 'المستخدمون والصلاحيات', icon: UserCog },
      { route: 'settings', label: 'الإعدادات', icon: SettingsIcon },
      { route: 'account', label: 'حسابي', icon: UserCircle },
    ],
  },
];

const BOTTOM_NAV: NavItem[] = [
  { route: 'dashboard', label: 'الرئيسية', icon: LayoutDashboard },
  { route: 'inventory', label: 'الرصيد', icon: Boxes },
  { route: 'reels-add', label: 'تسجيل بكر', icon: PlusCircle },
  { route: 'issuedocs', label: 'أذون الصرف', icon: FileOutput },
  { route: 'rolls', label: 'الرولات', icon: Rows3 },
];

const ROUTE_REDIRECTS: Record<string, string> = {
  additions: 'rolls', withdrawals: 'issuedocs', baker: 'rolls', 'baker-add': 'reels-add',
};

export default function Shell() {
  const { route, navigate, profile, signOut } = useAgrima();
  const [navOpen, setNavOpen] = useState(false);
  const [online, setOnline] = useState(true);

  const safeRoute = useCallback((raw: string): Route => {
    const r = (ROUTE_REDIRECTS[raw] || raw) as Route;
    return routeAllowed(r) ? r : ((isWarehouse() ? 'inventory' : 'dashboard') as Route);
  }, []);

  useEffect(() => {
    setOnline(navigator.onLine);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    // initial hash — always route through the permission gate
    const raw = (location.hash || '').replace('#', '');
    navigate(safeRoute(raw || 'dashboard'));
    const onHash = () => {
      const h = (location.hash || '').replace('#', '');
      if (h && h !== useAgrima.getState().route) navigate(safeRoute(h));
    };
    window.addEventListener('hashchange', onHash);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
      window.removeEventListener('hashchange', onHash);
    };
  }, [navigate, safeRoute]);

  const go = useCallback((r: Route) => {
    if (!routeAllowed(r)) {
      toast.error('لا تملك صلاحية الوصول إلى هذا القسم');
      navigate((isWarehouse() ? 'inventory' : 'dashboard') as Route);
      return;
    }
    navigate(r);
    setNavOpen(false);
  }, [navigate]);

  const visibleGroups = useMemo(
    () => NAV_GROUPS
      .map((g) => ({ ...g, items: g.items.filter((it) => routeAllowed(it.route as Route)) }))
      .filter((g) => g.items.length > 0),
    [],
  );

  const view = useMemo(() => {
    switch (route) {
      case 'dashboard': return <Dashboard />;
      case 'inventory': return <Inventory mode="inventory" />;
      case 'products': return <Inventory mode="products" />;
      case 'production': return <TxTables mode="production" />;
      case 'outlog': return <TxTables mode="outlog" />;
      case 'history': return <TxTables mode="history" />;
      case 'reels-add': return <ReelsAdd />;
      case 'rolls': return <Rolls />;
      case 'issuedocs': return <Issuedocs />;
      case 'baker-issue': return <IssueForm />;
      case 'issuedoc': return <IssuedocView />;
      case 'reservations': return <Reservations />;
      case 'reservation-form': return <Reservations />;
      case 'reservation-details': return <Reservations />;
      case 'customers': return <CustomersView />;
      case 'reports': return <Reports />;
      case 'import': return <ImportExport />;
      case 'backup': return <BackupSettings mode="backup" />;
      case 'settings': return <BackupSettings mode="settings" />;
      case 'users': return <Users mode="users" />;
      case 'audit': return <Users mode="audit" />;
      case 'account': return <Account />;
      default: return <Dashboard />;
    }
  }, [route]);

  const doLogout = async () => {
    await signOut();
    try { location.hash = ''; } catch { /* noop */ }
    location.reload();
  };

  return (
    <div className={`agr-shell ${navOpen ? 'nav-open' : ''}`}>
      <aside className="agr-sidebar">
        <div className="agr-brand">
          <div className="agr-brand-ic">أ</div>
          <div>
            <div className="agr-brand-name">Agrima <span className="agr-brand-badge">ERP</span></div>
            <div className="agr-brand-sub">إدارة المخزون والبكر</div>
          </div>
        </div>
        <nav className="agr-nav" aria-label="التنقل الرئيسي">
          {visibleGroups.map((g) => (
            <div key={g.title}>
              <div className="agr-nav-group">{g.title}</div>
              {g.items.map((it) => {
                const Icon = it.icon;
                return (
                  <button
                    key={it.route}
                    className={`agr-nav-item ${route === it.route ? 'active' : ''}`}
                    onClick={() => go(it.route)}
                  >
                    <span className="agr-nav-ic"><Icon size={18} /></span>
                    <span>{it.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="agr-side-foot">
          {!online && <div className="agr-net-off"><WifiOff size={12} className="inline" /> غير متصل — يعمل بدون إنترنت</div>}
          <div>Agrima ERP v11 — نسخة محلية</div>
        </div>
      </aside>
      <div className="agr-backdrop" onClick={() => setNavOpen(false)} />

      <main className="agr-main">
        <header className="agr-topbar">
          <button className="agr-icon-btn agr-burger" aria-label="القائمة" onClick={() => setNavOpen(true)}>
            <Menu size={18} />
          </button>
          <div className="agr-topbar-title">{routeTitle(route)}</div>
          <div className="agr-topbar-user">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="agr-user-chip" aria-label="قائمة المستخدم">
                  <span className="agr-avatar">{(profile?.fullName || profile?.email || '؟').charAt(0)}</span>
                  <span className="text-start">
                    <span className="agr-user-name block">{profile?.fullName || '—'}</span>
                    <span className="agr-user-role block">{roleLabel()}</span>
                  </span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>
                  <div className="text-xs">{profile?.fullName}</div>
                  <div className="text-[11px] text-slate-500" dir="ltr">{profile?.email}</div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {isAdmin() && <DropdownMenuItem onClick={() => go('users')}>المستخدمون والصلاحيات</DropdownMenuItem>}
                {isAdmin() && <DropdownMenuItem onClick={() => go('audit')}>سجل العمليات</DropdownMenuItem>}
                <DropdownMenuItem onClick={() => go('account')}>حسابي وتغيير كلمة المرور</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={doLogout} className="text-red-600 focus:text-red-700">
                  <LogOut size={14} className="mr-2" /> تسجيل الخروج
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <section className="agr-view" aria-live="polite">
          {view}
        </section>

        <nav className="agr-bottomnav" aria-label="التنقل السريع">
          {BOTTOM_NAV.filter((it) => routeAllowed(it.route as Route)).map((it) => {
            const Icon = it.icon;
            return (
              <button
                key={it.route}
                className={`agr-bn-item ${route === it.route ? 'active' : ''}`}
                onClick={() => go(it.route)}
              >
                <Icon size={20} />
                <span>{it.label}</span>
              </button>
            );
          })}
        </nav>
      </main>
    </div>
  );
}
