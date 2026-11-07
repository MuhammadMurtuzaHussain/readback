import { ArrowRight, Lock, LockOpen, Warning } from '@phosphor-icons/react';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Route, Screen, Service } from '../../engine/types';
import { plural, useR } from '../ctx';

const KIND: Record<string, string> = { ai: 'AI model', database: 'database', auth: 'login', payments: 'payments', email: 'email', storage: 'file storage', analytics: 'analytics', monitoring: 'error tracking', messaging: 'messages', queue: 'background jobs', maps: 'maps', web: 'outside API', blockchain: 'blockchain', other: 'outside service' };

interface RouteNode {
  id: string;
  routes: Route[];
  label: string;
  group: boolean;
}

function groupRoutes(routes: Route[]): RouteNode[] {
  const web = routes.filter((r) => r.kind !== 'command');
  const others = routes.filter((r) => r.kind === 'command');
  const raw = web.length > 14 ? groupBy(web) : web.map((r) => ({ id: `r:${r.id}`, routes: [r], label: r.path, group: false }));
  return [...raw, ...others.slice(0, 6).map((r) => ({ id: `r:${r.id}`, routes: [r], label: r.path, group: false }))];
}

function groupBy(routes: Route[]): RouteNode[] {
  const map = new Map<string, Route[]>();
  for (const r of routes) {
    const segs = r.path.split('/').filter((s) => s && !s.startsWith(':'));
    const key = r.kind === 'action' ? 'server actions' : `/${segs.slice(0, 2).join('/')}`;
    map.set(key, [...(map.get(key) ?? []), r]);
  }
  return [...map.entries()].map(([key, list]) => ({ id: `g:${key}`, routes: list, label: list.length === 1 ? list[0].path : key, group: list.length > 1 }));
}

function doorState(routes: Route[]): 'open' | 'locked' | 'mixed' | 'na' {
  const relevant = routes.filter((r) => r.kind !== 'command' && r.kind !== 'webhook');
  if (!relevant.length) return 'na';
  const open = relevant.filter((r) => r.auth.status === 'none' || r.auth.status === 'read-only').length;
  if (open === relevant.length) return 'open';
  return open ? 'mixed' : 'locked';
}

export function MapView() {
  const { report: r, go, show } = useR();
  const screens = useMemo(() => r.screens.slice(0, 30), [r]);
  const routeNodes = useMemo(() => groupRoutes(r.routes), [r]);
  const services = useMemo(() => r.services.filter((s) => s.operations.length), [r]);
  const quiet = useMemo(() => r.services.filter((s) => !s.operations.length), [r]);

  const edges = useMemo(() => {
    const e: Array<[string, string]> = [];
    const has = new Set<string>();
    const add = (a: string, b: string): void => {
      if (has.has(`${a}|${b}`)) return;
      has.add(`${a}|${b}`);
      e.push([a, b]);
    };
    const nodeOf = new Map<string, string>();
    for (const n of routeNodes) for (const x of n.routes) nodeOf.set(x.id, n.id);
    for (const n of routeNodes) {
      for (const x of n.routes) {
        for (const sc of x.calledBy) add(`s:${sc}`, n.id);
        for (const sv of x.services) add(n.id, `x:${sv}`);
      }
    }
    for (const j of r.journeys) {
      if (!j.screen) continue;
      const viaRoute = new Set(j.routeIds.flatMap((id) => r.routes.find((x) => x.id === id)?.services ?? []));
      for (const sv of j.serviceIds) if (!viaRoute.has(sv)) add(`s:${j.screen}`, `x:${sv}`);
    }
    return e;
  }, [r, routeNodes]);

  // Order each column by its neighbours so lines cross less.
  const [orderedScreens, orderedRoutes, orderedServices] = useMemo(() => {
    let a: Screen[] = [...screens];
    let b: RouteNode[] = [...routeNodes];
    let c: Service[] = [...services];
    const pos = (list: Array<{ id: string }>, prefix: string): Map<string, number> => new Map(list.map((x, i) => [prefix + x.id, i]));
    for (let round = 0; round < 6; round++) {
      const pa = pos(a, 's:');
      const pb = new Map(b.map((x, i) => [x.id, i]));
      const pc = pos(c, 'x:');
      const score = (id: string, others: Map<string, number>): number => {
        const hits = edges.filter(([x, y]) => x === id || y === id).map(([x, y]) => others.get(x === id ? y : x)).filter((v): v is number => v !== undefined);
        return hits.length ? hits.reduce((s, v) => s + v, 0) / hits.length : 1e6;
      };
      b = [...b].sort((m, n) => score(m.id, pa) - score(n.id, pa));
      const pb2 = new Map(b.map((x, i) => [x.id, i]));
      c = [...c].sort((m, n) => score(`x:${m.id}`, pb2) - score(`x:${n.id}`, pb2));
      a = [...a].sort((m, n) => score(`s:${m.id}`, pb2) - score(`s:${n.id}`, pb2));
      void pb; void pc;
    }
    return [a, b, c];
  }, [screens, routeNodes, services, edges]);

  const [hover, setHover] = useState<string | null>(null);
  const [off, setOff] = useState<string | null>(null);
  const offService = services.find((s) => s.id === off) ?? null;

  const downNodes = useMemo(() => {
    const set = new Set<string>();
    if (!offService) return set;
    set.add(`x:${offService.id}`);
    for (const n of routeNodes) if (n.routes.some((x) => offService.routes.includes(x.id))) set.add(n.id);
    for (const s of offService.screens) set.add(`s:${s}`);
    return set;
  }, [offService, routeNodes]);

  const litNodes = useMemo(() => {
    if (!hover) return null;
    const set = new Set([hover]);
    const walk = (dir: 0 | 1, from: string): void => {
      for (const e of edges) {
        if (e[dir] === from && !set.has(e[1 - dir])) {
          set.add(e[1 - dir]);
          walk(dir, e[1 - dir]);
        }
      }
    };
    walk(0, hover);
    walk(1, hover);
    return set;
  }, [hover, edges]);

  const wrap = useRef<HTMLDivElement>(null);
  const refs = useRef(new Map<string, HTMLElement>());
  const [paths, setPaths] = useState<Array<{ id: string; a: string; b: string; d: string }>>([]);
  const measure = useCallback(() => {
    const box = wrap.current?.getBoundingClientRect();
    if (!box) return;
    const next = [];
    for (const [a, b] of edges) {
      const x = refs.current.get(a)?.getBoundingClientRect();
      const y = refs.current.get(b)?.getBoundingClientRect();
      if (!x || !y) continue;
      const x1 = x.right - box.left;
      const y1 = x.top + x.height / 2 - box.top;
      const x2 = y.left - box.left;
      const y2 = y.top + y.height / 2 - box.top;
      const mid = (x1 + x2) / 2;
      next.push({ id: `${a}|${b}`, a, b, d: `M${x1} ${y1} C${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}` });
    }
    setPaths(next);
  }, [edges]);
  useLayoutEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (wrap.current) ro.observe(wrap.current);
    return () => ro.disconnect();
  }, [measure, orderedRoutes, orderedScreens, orderedServices]);

  const nodeClass = (id: string, base: string): string => {
    const cls = [base];
    if (offService) {
      if (id === `x:${offService.id}`) cls.push('off');
      else if (downNodes.has(id)) cls.push('down');
      else cls.push('dim');
    } else if (litNodes) cls.push(litNodes.has(id) ? 'lit' : 'dim');
    return cls.join(' ');
  };
  const edgeClass = (a: string, b: string): string => {
    if (offService) return downNodes.has(a) && downNodes.has(b) ? 'down' : 'dim';
    if (litNodes) return litNodes.has(a) && litNodes.has(b) ? 'lit' : 'dim';
    return '';
  };
  const reg = (id: string) => (el: HTMLElement | null) => {
    if (el) refs.current.set(id, el);
    else refs.current.delete(id);
  };
  const hoverProps = (id: string) => ({
    onMouseEnter: () => setHover(id), onMouseLeave: () => setHover(null),
    onFocus: () => setHover(id), onBlur: () => setHover(null),
  });

  const totalScreens = r.screens.length;
  const webRoutes = r.routes.filter((x) => x.kind !== 'command');
  const downRoutes = offService ? offService.routes.length : 0;
  const downScreens = offService ? offService.screens.length : 0;

  return (
    <div className="stage">
      <h1 className="title">What it is made of, and what holds it up</h1>
      <p className="lede">Each line is a call I traced in your code. Pick a service under What it depends on to turn it off and see what breaks.</p>

      <div className="map-wrap" ref={wrap}>
        <div className="map">
          <svg className="edges" aria-hidden="true">
            {paths.map((p) => <path key={p.id} d={p.d} className={edgeClass(p.a, p.b)} />)}
          </svg>
          <div className="band">
            <h2>What people see</h2>
            <p>Runs in their browser or phone</p>
            <div className="nodes">
              {orderedScreens.map((s) => (
                <button key={s.id} ref={reg(`s:${s.id}`)} className={nodeClass(`s:${s.id}`, 'node')} {...hoverProps(`s:${s.id}`)} onClick={() => show({ title: `The ${s.path} screen`, body: `${s.framework}. ${s.render === 'server' ? 'Your server builds this page first.' : s.render === 'native' ? 'Runs on the phone.' : 'Runs in the visitor\'s browser.'}`, evidence: [s.evidence] })}>
                  <b>{s.path}</b>
                  <span>{s.app ? `${s.app}, ` : ''}{s.render === 'server' ? 'built on your server' : s.render === 'native' ? 'on the phone' : 'in the browser'}</span>
                </button>
              ))}
              {!orderedScreens.length && <p className="hint">No screens found. This project may be a server, a tool or a library.</p>}
            </div>
          </div>
          <div className="band">
            <h2>What your server does</h2>
            <p>Each one is a door on the internet</p>
            <div className="nodes">
              {orderedRoutes.map((n) => {
                const state = doorState(n.routes);
                const first = n.routes[0];
                return (
                  <button key={n.id} ref={reg(n.id)} className={nodeClass(n.id, `node ${state === 'open' ? 'open' : ''}`)} {...hoverProps(n.id)} onClick={() => show({ title: n.group ? `${n.label}: ${n.routes.length} routes` : `${first.method === 'ANY' ? '' : `${first.method} `}${first.path}`, body: n.routes.length === 1 ? doorText(first) : undefined, evidence: n.routes.slice(0, 8).map((x) => x.evidence) })}>
                    <b>{!n.group && first.method !== 'ANY' && first.method !== 'RUN' && <span className="m" style={{ display: 'inline' }}>{first.method}</span>}{n.label}</b>
                    <span className="door">
                      {state === 'open' && <><LockOpen size={15} /> {n.group ? 'no login checks seen' : 'no login check seen'}</>}
                      {state === 'locked' && <><Lock size={15} /> checks who is asking</>}
                      {state === 'mixed' && <><LockOpen size={15} /> {plural(n.routes.length, 'route')}, some open</>}
                      {state === 'na' && <>{first.kind === 'webhook' ? 'webhook' : first.kind === 'command' ? 'command' : 'route'}</>}
                    </span>
                  </button>
                );
              })}
              {!orderedRoutes.length && <p className="hint">No server routes found.</p>}
            </div>
          </div>
          <div className="band">
            <h2>What it depends on</h2>
            <p>Other people's computers, mostly</p>
            <div className="nodes">
              {orderedServices.map((s) => (
                <button key={s.id} ref={reg(`x:${s.id}`)} aria-pressed={off === s.id} className={nodeClass(`x:${s.id}`, 'node')} {...hoverProps(`x:${s.id}`)} onClick={() => setOff(off === s.id ? null : s.id)}>
                  <b style={{ fontFamily: 'var(--sans)', fontWeight: 700 }}>{s.name}</b>
                  <span>{KIND[s.kind] ?? s.kind}{s.from.includes('browser') ? ', reached from the browser' : ''}</span>
                </button>
              ))}
              {!orderedServices.length && <p className="hint">No outside services traced.</p>}
            </div>
          </div>
        </div>
      </div>

      {offService ? (
        <div className="outage">
          <div>
            <h2>
              If {offService.name} goes down, {downScreens ? `${downScreens} of ${totalScreens} screen${totalScreens === 1 ? '' : 's'}` : 'no screens I can trace'}
              {webRoutes.length ? ` and ${downRoutes} of ${webRoutes.length} route${webRoutes.length === 1 ? '' : 's'}` : ''} lose something they need.
            </h2>
            <p>{offService.plain}</p>
            {offService.envVars.length > 0 && <div className="pills">{offService.envVars.map((e) => <span className="pill" key={e}>{e}</span>)}</div>}
          </div>
          <div>
            <h3 style={{ fontSize: 16, marginBottom: 8 }}>Where the code calls it</h3>
            <div className="oplist">
              {offService.operations.slice(0, 7).map((o, i) => (
                <button key={i} onClick={() => show({ title: `${offService.name}: ${o.target ?? o.label}`, evidence: [o.evidence] })}>
                  {o.access === 'write' ? 'writes' : o.access === 'read' ? 'reads' : 'calls'} {o.target ?? ''} in {o.evidence.file}:{o.evidence.line}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <p className="hint hover-only">Hover anything to trace its connections.</p>
      )}

      {quiet.length > 0 && (
        <p className="hint"><Warning size={16} style={{ verticalAlign: '-2px' }} /> Installed, but I traced no calls to: {quiet.map((q) => q.name).join(', ')}.</p>
      )}

      <button className="next" onClick={() => go('journeys')}>Watch one thing move through it <ArrowRight size={18} /></button>
    </div>
  );
}

function doorText(x: Route): string {
  const who = {
    checked: `It checks who is asking with ${x.auth.how}.`,
    middleware: `Your middleware checks who is asking first (${x.auth.how}).`,
    'read-only': `It looks up who is asking with ${x.auth.how}, but I could not see it stop anyone.`,
    none: 'I can see no login check on this route.',
    'not-applicable': '',
  }[x.auth.status];
  return `${who} ${x.validates ? 'It checks the incoming data.' : ''} ${x.writes ? 'It changes data.' : ''}`.trim();
}
