import { createContext, useContext } from 'react';
import type { Evidence, Report, ViewId } from '../engine/types';

export interface Opened {
  title: string;
  body?: string;
  evidence: Evidence[];
}

export interface Ctx {
  report: Report;
  view: ViewId;
  go: (v: ViewId, id?: string) => void;
  focus?: string;
  show: (o: Opened) => void;
}

export const ReportCtx = createContext<Ctx>(null as unknown as Ctx);
export const useR = (): Ctx => useContext(ReportCtx);

export function store<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private window or blocked storage: the page still works */
  }
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
