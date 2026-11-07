import { ArrowRight } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FileFact, FileRole } from '../../engine/types';
import { plural, useR } from '../ctx';

interface Rect { x: number; y: number; w: number; h: number; }
interface Item<T> { value: number; data: T; }
interface Placed<T> extends Rect { data: T; }

/** Squarified treemap: keeps cells close to square so names stay readable. */
function squarify<T>(items: Item<T>[], box: Rect): Placed<T>[] {
  const total = items.reduce((s, i) => s + i.value, 0);
  if (!total || box.w <= 0 || box.h <= 0) return [];
  const scale = (box.w * box.h) / total;
  const sorted = [...items].sort((a, b) => b.value - a.value).map((i) => ({ ...i, area: i.value * scale }));
  const out: Placed<T>[] = [];
  let { x, y, w, h } = box;
  let row: typeof sorted = [];
  const worst = (r: typeof sorted, side: number): number => {
    const sum = r.reduce((s, i) => s + i.area, 0);
    const max = Math.max(...r.map((i) => i.area));
    const min = Math.min(...r.map((i) => i.area));
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  };
  const flush = (): void => {
    const sum = row.reduce((s, i) => s + i.area, 0);
    if (w >= h) {
      const rw = sum / h;
      let cy = y;
      for (const i of row) {
        const ih = i.area / rw;
        out.push({ x, y: cy, w: rw, h: ih, data: i.data });
        cy += ih;
      }
      x += rw;
      w -= rw;
    } else {
      const rh = sum / w;
      let cx = x;
      for (const i of row) {
        const iw = i.area / rh;
        out.push({ x: cx, y, w: iw, h: rh, data: i.data });
        cx += iw;
      }
      y += rh;
      h -= rh;
    }
    row = [];
  };
  for (const item of sorted) {
    const side = Math.min(w, h);
    if (!row.length || worst([...row, item], side) <= worst(row, side)) row.push(item);
    else {
      flush();
      row.push(item);
    }
  }
  if (row.length) flush();
  return out;
}

const ROLE_NAMES: Partial<Record<FileRole, string>> = {
  screen: 'Screens', route: 'Server routes', component: 'Interface pieces', logic: 'Shared code', data: 'Data shape', config: 'Settings', script: 'Scripts', test: 'Tests',
};

function folderOf(path: string): string {
  const parts = path.split('/');
  if (parts.length === 1) return '(top level)';
  if (/^(apps?|packages|services)$/.test(parts[0]) && parts.length > 2) return parts.slice(0, 2).join('/');
  return parts[0] === 'src' && parts.length > 2 ? parts.slice(0, 2).join('/') : parts[0];
}

function cellName(path: string): string {
  const parts = path.split('/');
  const base = parts[parts.length - 1];
  if (/^(route|page|layout|index|__init__|\+server|\+page)\./.test(base) && parts.length > 1) return `${parts[parts.length - 2]}/${base}`;
  return base;
}

export function Parts() {
  const { report: r, go } = useR();
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 900, h: 560 });
  const [role, setRole] = useState<FileRole | null>(null);
  const shown = useMemo(() => r.files.filter((f) => ROLE_NAMES[f.role]), [r]);
  const biggest = useMemo(() => [...shown].filter((f) => f.role !== 'config' && f.role !== 'test').sort((a, b) => b.importedBy - a.importedBy)[0], [shown]);
  const [sel, setSel] = useState<FileFact | null>(biggest ?? null);

  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);

  const cells = useMemo(() => {
    const folders = new Map<string, FileFact[]>();
    for (const f of shown) folders.set(folderOf(f.path), [...(folders.get(folderOf(f.path)) ?? []), f]);
    const weight = (f: FileFact): number => Math.max(14, Math.min(f.lines, 1600)) * (f.role === 'config' ? 0.4 : 1);
    const groups = [...folders.entries()].map(([name, files]) => ({ value: files.reduce((s, f) => s + weight(f), 0), data: { name, files } }));
    const out: Array<Placed<FileFact>> = [];
    const heads: Array<Placed<string>> = [];
    for (const g of squarify(groups, { x: 0, y: 0, w: size.w, h: size.h })) {
      const label = g.w > 80 && g.h > 54;
      if (label) heads.push({ ...g, data: g.data.name });
      const pad = label ? 20 : 0;
      out.push(...squarify(g.data.files.map((f) => ({ value: weight(f), data: f })), { x: g.x, y: g.y + pad, w: g.w, h: g.h - pad }));
    }
    return { out, heads };
  }, [shown, size]);

  const roles = useMemo(() => {
    const c = new Map<FileRole, number>();
    for (const f of shown) c.set(f.role, (c.get(f.role) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]);
  }, [shown]);

  const unreached = r.files.filter((f) => f.unreached);

  return (
    <div className="stage wide">
      <h1 className="title" style={{ maxWidth: 'none' }}>Where the code actually lives</h1>
      <p className="lede">Each block is a file, sized by how long it is and grouped by folder. Dark is what people see. The accent colour is your server's doors.</p>
      <div className="tree" ref={box}>
        {cells.out.map((c) => (
          <button
            key={c.data.path}
            className={`cell r-${c.data.role} ${role && c.data.role !== role ? 'dim' : ''}`}
            style={{ left: c.x, top: c.y, width: c.w, height: c.h }}
            aria-pressed={sel?.path === c.data.path}
            aria-label={c.data.path}
            onClick={() => setSel(c.data)}
          >
            {c.w > 54 && c.h > 22 ? cellName(c.data.path) : ''}
          </button>
        ))}
        {cells.heads.map((h) => (
          <div key={h.data} style={{ position: 'absolute', left: h.x + 7, top: h.y + 2, fontSize: 13, color: 'var(--ink-2)', fontFamily: 'var(--mono)', pointerEvents: 'none', whiteSpace: 'nowrap', overflow: 'hidden', maxWidth: h.w - 12 }}>{h.data}</div>
        ))}
      </div>
      <div className="legend">
        {roles.map(([k, n]) => (
          <button key={k} aria-pressed={role === k} onClick={() => setRole(role === k ? null : k)}>
            <i className={`r-${k}`} /> {ROLE_NAMES[k]} ({n})
          </button>
        ))}
      </div>
      <div className="fileinfo">
        <div>
          {sel ? (
            <>
              <h2>{sel.path}</h2>
              <p>{sel.plain}</p>
              {sel.ownWords && <p style={{ color: 'var(--ink-3)' }}>The file says: “{sel.ownWords}”</p>}
            </>
          ) : <p>Pick a block to see what it is for.</p>}
        </div>
        <div>
          {sel && <p>{plural(sel.lines, 'line')}. Used by {plural(sel.importedBy, 'other file')}.{sel.unreached ? ' Nothing I can trace reaches this file, so it may be left over.' : ''}</p>}
          {sel?.exports.length ? <div className="pills">{sel.exports.slice(0, 8).map((e) => <span key={e} className="pill">{e}</span>)}</div> : null}
          {unreached.length > 0 && <p style={{ marginTop: 10, color: 'var(--ink-3)' }}>{plural(unreached.length, 'file')} {unreached.length === 1 ? 'is' : 'are'} not reached from any screen or route I found. Dynamic loading can hide a connection, so check before deleting.</p>}
        </div>
      </div>
      <button className="next" onClick={() => go('stack')}>See what each technology is <ArrowRight size={18} /></button>
    </div>
  );
}
