/* =========================================================================
   store.ts — central client state (zustand). Everything lives on-device.
   ========================================================================= */

import { create } from 'zustand';
import { db, openDB, repo } from './db';
import { comboKey, computeBalances, computeBalancesByWeight } from './calc';
import type { Product } from './types';
import * as AUTH from './auth';
import { setProfile, routeAllowed } from './permissions';
import * as TX from './tx';
import type {
  BalanceRow, Customer, Permit, Reel, Roll, Route, Settings, SessionProfile,
  Transaction, Voucher,
} from './types';

interface AgrimaState {
  bootPhase: 'loading' | 'ready' | 'error' | 'first-run';
  bootError: string | null;
  profile: SessionProfile | null;
  route: Route;
  products: Product[];
  transactions: Transaction[];
  permits: Permit[];
  reels: Reel[];
  rolls: Roll[];
  customers: Customer[];
  settings: Settings;
  balances: Map<string, BalanceRow>;
  balancesW: Map<string, BalanceRow>;
  pendingEdit: { kind: 'permit' | 'legacy'; voucher?: Voucher; permit?: Permit } | null;
  pendingDoc: Voucher | null;
  pendingReservationId: string | null;
  autoPrintDoc: boolean;
  reservationsVersion: number;
}

interface AgrimaActions {
  boot: () => Promise<void>;
  refresh: () => Promise<void>;
  navigate: (route: Route) => void;
  rerender: () => void;
  setPendingEdit: (p: AgrimaState['pendingEdit']) => void;
  setPendingDoc: (p: Voucher | null) => void;
  setPendingReservationId: (id: string | null) => void;
  setAutoPrintDoc: (v: boolean) => void;
  saveSettings: (patch: Partial<Settings>) => Promise<void>;
  signOut: () => Promise<void>;
  bumpReservations: () => void;
  actor: () => string | undefined;
}

const defaultSettings: Settings = {
  companyName: '', lang: 'ar', weightFactor: 7.5,
  docSeqTax: 0, docSeqNontax: 0, rollSeq: 1,
};

export const useAgrima = create<AgrimaState & AgrimaActions>((set, get) => ({
  bootPhase: 'loading',
  bootError: null,
  profile: null,
  route: 'dashboard',
  products: [],
  transactions: [],
  permits: [],
  reels: [],
  rolls: [],
  customers: [],
  settings: { ...defaultSettings },
  balances: new Map(),
  balancesW: new Map(),
  pendingEdit: null,
  pendingDoc: null,
  pendingReservationId: null,
  autoPrintDoc: false,
  reservationsVersion: 0,

  actor: () => get().profile?.email || undefined,

  boot: async () => {
    try {
      await openDB();
      // migrations (one-time, additive, never destructive)
      await TX.migrateWeightsIfNeeded();
      await TX.migrateReservationsIfNeeded();
      // session
      const profile = await AUTH.restoreSession();
      if (!profile) {
        const n = await AUTH.usersCount();
        setProfile(null);
        set({ bootPhase: n === 0 ? 'first-run' : 'ready', profile: null });
        return;
      }
      setProfile(profile);
      await get().refresh();
      set({ profile, bootPhase: 'ready' });
    } catch (e) {
      set({
        bootPhase: 'error',
        bootError: e instanceof Error ? e.message : String(e),
      });
    }
  },

  refresh: async () => {
    const [products, transactions, permits, reels, rolls, customers] = await Promise.all([
      repo.products(), repo.transactions(), repo.permits(),
      repo.reels(), repo.rolls(), repo.customers(),
    ]);
    const settings: Settings = {
      companyName: await db.getSetting<string>('companyName', ''),
      lang: await db.getSetting<'ar' | 'en'>('lang', 'ar'),
      weightFactor: (await db.getSetting<number>('weightFactor', 7.5)) || 7.5,
      docSeqTax: (await db.getSetting<number>('docSeqTax', 0)) || 0,
      docSeqNontax: (await db.getSetting<number>('docSeqNontax', 0)) || 0,
      rollSeq: (await db.getSetting<number>('rollSeq', 1)) || 1,
      lastImport: (await db.getSetting('lastImport', null)) || null,
      lastWarehouseImport: (await db.getSetting('lastWarehouseImport', null)) || null,
    };
    set({
      products, transactions, permits, reels, rolls, customers, settings,
      balances: computeBalances(transactions),
      balancesW: computeBalancesByWeight(transactions),
    });
  },

  navigate: (route: Route) => {
    // route gate: even a manually-edited URL cannot open a disallowed route
    if (!routeAllowed(route)) {
      route = (typeof window !== 'undefined'
        ? (useAgrima.getState().profile?.role === 'warehouse' ? 'inventory' : 'dashboard')
        : 'dashboard') as Route;
    }
    set({ route });
    try { history.replaceState(null, '', '#' + route); } catch { /* noop */ }
    if (typeof document !== 'undefined') {
      document.title = routeTitle(route) + ' — Agrima ERP';
    }
  },

  rerender: () => set((s) => ({ reservationsVersion: s.reservationsVersion })),

  setPendingEdit: (p) => set({ pendingEdit: p }),
  setPendingDoc: (p) => set({ pendingDoc: p }),
  setPendingReservationId: (id) => set({ pendingReservationId: id }),
  setAutoPrintDoc: (v) => set({ autoPrintDoc: v }),

  saveSettings: async (patch) => {
    for (const [k, v] of Object.entries(patch)) {
      await db.setSetting(k, v);
    }
    await get().refresh();
  },

  signOut: async () => {
    await AUTH.signOut(get().profile?.email);
    setProfile(null);
    set({ profile: null });
  },

  bumpReservations: () => set((s) => ({ reservationsVersion: s.reservationsVersion + 1 })),
}));

export function routeTitle(route: Route | string): string {
  const titles: Record<string, string> = {
    dashboard: 'لوحة التحكم',
    inventory: 'الرصيد الحالي',
    products: 'إدارة الأصناف',
    issuedocs: 'أذون الصرف',
    issuedoc: 'عرض إذن صرف',
    'baker-issue': 'إذن صرف مخزني',
    reservations: 'حجوزات العملاء',
    'reservation-form': 'حجز جديد',
    'reservation-details': 'تفاصيل الحجز',
    outlog: 'سجل حركات الصرف',
    production: 'سجل الإنتاج',
    history: 'سجل الحركات الكامل',
    addtx: 'إضافة حركة',
    'reels-add': 'تسجيل البكر',
    rolls: 'إدارة الرولات والبكر',
    customers: 'العملاء',
    reports: 'التقارير',
    import: 'الاستيراد والتصدير',
    backup: 'النسخ الاحتياطي',
    settings: 'الإعدادات',
    users: 'المستخدمون والصلاحيات',
    audit: 'سجل العمليات',
    account: 'حسابي',
  };
  return titles[route] || 'Agrima ERP';
}

/* Convenience selectors */
export const balanceOf = (s: AgrimaState, quality: string, gsm: unknown, size: unknown): BalanceRow | undefined =>
  s.balances.get(comboKey(quality, gsm, size));
