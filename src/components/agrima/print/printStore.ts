'use client';

/* =========================================================================
   printStore.ts — print documents are built as plain data specs and rendered
   by <PrintRoot/>. One rendering pipeline for screen preview + paper print:
   no second computation, no divergence between screen and paper.
   ========================================================================= */

import { create } from 'zustand';

export interface PrintTableSpec {
  kind: 'table';
  company: string;
  title: string;
  subtitle?: string[];
  /** opening/closing band — product statement reports */
  obLine?: string[];
  /** summary band — rendered on the FIRST page only */
  summary?: string[];
  headers: string[];
  rows: string[][];
  totals?: string[] | null;
  signatures?: string[];
  footerNote?: string;
  /** compact: smaller font + tighter rows (very wide tables) */
  compact?: boolean;
}

export interface PrintPermitSpec {
  kind: 'permit';
  company: string;
  permitNo: string;
  cls: string;
  clsLabel: string;
  status: string;
  customer: string;
  date: string;
  conflictNote?: string;
  multiDate?: boolean;
  /** main lines table: العدد | المقاس | الجرام | الصنف */
  lines: { qty: number; size: number | string; gsm: number | string; quality: string }[];
  /** per-gram totals table */
  gsmTotals: { gsm: number | string; rolls: number; tons: string; est: boolean }[];
  totalRolls: number;
  totalTons: string;
  totalEst: boolean;
  notes?: string;
  estNote?: boolean;
  draft: boolean;
  signatures: string[];
}

export type PrintSpec = PrintTableSpec | PrintPermitSpec;

interface PrintState {
  spec: PrintSpec | null;
  preview: boolean;
  orientation: 'portrait' | 'landscape';
  open: (spec: PrintSpec, orientation?: 'portrait' | 'landscape') => void;
  setOrientation: (o: 'portrait' | 'landscape') => void;
  setPreview: (v: boolean) => void;
  close: () => void;
}

export const usePrint = create<PrintState>((set) => ({
  spec: null,
  preview: false,
  orientation: 'portrait',
  open: (spec, orientation) => set({ spec, preview: true, orientation: orientation || 'portrait' }),
  setOrientation: (orientation) => set({ orientation }),
  setPreview: (preview) => set({ preview }),
  close: () => set({ spec: null, preview: false }),
}));

/** Heuristic: wide tables print landscape automatically. */
export function autoOrientation(headersCount: number): 'portrait' | 'landscape' {
  return headersCount >= 8 ? 'landscape' : 'portrait';
}
