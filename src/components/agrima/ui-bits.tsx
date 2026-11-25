'use client';

/* Shared UI bits: page head, stat card, badges, confirm dialogs, pager */

import { create } from 'zustand';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { AlertTriangle } from 'lucide-react';

export function PageHead({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="agr-page-head">
      <h2>{title}</h2>
      {children && <div className="agr-head-actions">{children}</div>}
    </div>
  );
}

export function StatCard({ icon, num, label, accent }: {
  icon: React.ReactNode; num: React.ReactNode; label: string; accent: 'green' | 'teal' | 'amber';
}) {
  return (
    <div className={`agr-stat agr-accent-${accent}`}>
      <div className="agr-stat-ic">{icon}</div>
      <div>
        <div className="agr-stat-num">{num}</div>
        <div className="agr-stat-lbl">{label}</div>
      </div>
    </div>
  );
}

/* ---------------------- promise-based confirm dialog ---------------------- */

interface ConfirmSpec {
  title: string;
  message: string;
  extra?: string;
  danger?: boolean;
  yesLabel?: string;
  noLabel?: string;
}

interface ConfirmState {
  spec: ConfirmSpec | null;
  resolver: ((v: boolean) => void) | null;
  ask: (spec: ConfirmSpec) => Promise<boolean>;
  resolve: (v: boolean) => void;
}

export const useConfirm = create<ConfirmState>((set, get) => ({
  spec: null,
  resolver: null,
  ask: (spec) => new Promise<boolean>((resolve) => set({ spec, resolver: resolve })),
  resolve: (v) => {
    const { resolver } = get();
    resolver?.(v);
    set({ spec: null, resolver: null });
  },
}));

export function confirmAction(spec: ConfirmSpec): Promise<boolean> {
  return useConfirm.getState().ask(spec);
}

export function ConfirmHost() {
  const { spec, resolve } = useConfirm();
  if (!spec) return null;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) resolve(false); }}>
      <DialogContent className="max-w-md" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {spec.danger && <AlertTriangle size={18} className="text-red-600" />}
            {spec.title}
          </DialogTitle>
          <DialogDescription className="whitespace-pre-line">{spec.message}</DialogDescription>
        </DialogHeader>
        {spec.extra && <div className="text-xs bg-slate-50 border rounded p-2 whitespace-pre-line">{spec.extra}</div>}
        <DialogFooter className="flex-row justify-start gap-2">
          <Button
            className={spec.danger ? 'bg-red-600 hover:bg-red-700' : 'bg-teal-700 hover:bg-teal-800'}
            onClick={() => resolve(true)}
          >
            {spec.yesLabel || 'تأكيد'}
          </Button>
          <Button variant="outline" onClick={() => resolve(false)} autoFocus>
            {spec.noLabel || 'إلغاء'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------- pager ------------------------------- */

export function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (p: number) => void }) {
  if (pages <= 1) return null;
  return (
    <div className="flex items-center gap-2 justify-center py-3">
      <button className="agr-btn agr-btn-ghost agr-btn-sm" disabled={page <= 0} onClick={() => onPage(page - 1)}>‹</button>
      <span className="text-xs font-bold text-slate-500">صفحة {page + 1} / {pages}</span>
      <button className="agr-btn agr-btn-ghost agr-btn-sm" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>›</button>
    </div>
  );
}

export function Badge({ tone, children, title }: { tone: string; children: React.ReactNode; title?: string }) {
  return <span className={`agr-badge ${tone}`} title={title}>{children}</span>;
}

export function EmptyRow({ colSpan, text }: { colSpan: number; text: string }) {
  return (
    <tr><td colSpan={colSpan} className="text-center text-slate-400 py-6">{text}</td></tr>
  );
}
