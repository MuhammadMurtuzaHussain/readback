import { dirname, joinPath, parseLooseJson, Sources } from './files';
import type { Graph, Ref } from './graph';
import { argsOf, chainOf, literal } from './model';
import type { CallSite, Module, Unit, Value } from './model';
import type { Certainty, Evidence, Gap, Route, Screen } from './types';

const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all']);
const NEXT_VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
export const AUTH_MW = /auth|requireuser|requirelogin|protect|verifytoken|verifyjwt|isloggedin|ensureloggedin|jwt|session|clerk|passport|bearer/i;

/** A route as the engine sees it, with the code still attached. */
export interface RouteRec {
  id: string;
  method: string;
  path: string;
  file: string;
  line: number;
  kind: Route['kind'];
  framework: string;
  handler: Unit | null;
  authHints: Array<{ how: string; line: number; file: string }>;
  certainty: Certainty;
  wrapper?: string;
  validatedBy?: { how: string; line: number; file: string };
  /** Only this part of the handler belongs to the route. */
  range?: [number, number];
}

export interface ScreenRec {
  id: string;
  path: string;
  file: string;
  name: string;
  render: Screen['render'];
  framework: string;
  entry: Unit | null;
  line: number;
}

interface RouterInstance {
  key: string;
  file: string;
  line: number;
  isApp: boolean;
  framework: string;
  mounts: Array<{ parent: string; prefix: string }>;
  uses: Array<{ prefix: string; name: string; line: number; file: string }>;
  routes: Array<{ method: string; path: string; line: number; handler: Unit | null; mw: string[]; file: string; certainty: Certainty }>;
}

function nextRoutePath(file: string, marker: RegExp): string {
  const m = file.match(marker);
  const rest = m ? file.slice((m.index ?? 0) + m[0].length) : file;
  const dir = dirname(rest);
  const segs = dir.split('/').filter(Boolean).filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith('@'));
  const path = segs
    .map((s) => s.replace(/^\[\[?\.\.\.(.+?)\]?\]$/, ':$1*').replace(/^\[(.+)\]$/, ':$1'))
    .join('/');
  return `/${path}`;
}

function pagesPath(file: string, marker: RegExp): string {
  const m = file.match(marker)!;
  const rest = file.slice((m.index ?? 0) + m[0].length).replace(/\.[a-z]+$/, '').replace(/(^|\/)index$/, '');
  const path = rest.split('/').filter(Boolean).map((s) => s.replace(/^\[\.\.\.(.+)\]$/, ':$1*').replace(/^\[(.+)\]$/, ':$1')).join('/');
  return `/${path}`;
}

function humanName(path: string, file: string): string {
  if (path === '/' || !path) return 'Home';
  const last = path.split('/').filter((s) => s && !s.startsWith(':')).pop();
  if (!last) return file.split('/').pop() ?? path;
  return last.replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function join(prefix: string, path: string): string {
  const out = `${prefix.replace(/\/$/, '')}/${path.replace(/^\//, '')}`.replace(/\/+/g, '/');
  return out.length > 1 ? out.replace(/\/$/, '') : out;
}

function normPath(p: string): string {
  return p.replace(/\{([^}:]+)(?::[^}]*)?\}/g, ':$1').replace(/<(?:[^:>]+:)?([^>]+)>/g, ':$1');
}

export function findRoutes(g: Graph, gaps: Gap[], src: Sources): RouteRec[] {
  const out: RouteRec[] = [];
  const seen = new Set<string>();
  const add = (r: Omit<RouteRec, 'id'>): void => {
    const id = `${r.method} ${r.path} ${r.file}`;
    if (seen.has(id)) return;
    seen.add(id);
    let kind = r.kind;
    if (kind === 'route' && /webhook|\/hooks?\//i.test(r.path)) kind = 'webhook';
    out.push({ ...r, kind, id });
  };

  for (const mod of g.modules.values()) {
    fileRoutes(g, mod, add);
    actions(g, mod, add);
    if (mod.language === 'python') pythonRoutes(g, mod, add);
    nestRoutes(mod, add);
  }
  routerRoutes(g, add, gaps, src);
  plainServers(g, add);
  trpcRoutes(g, add);
  cliCommands(g, add);
  markCrons(g, out);
  return out;
}

function fileRoutes(g: Graph, mod: Module, add: (r: Omit<RouteRec, 'id'>) => void): void {
  const f = mod.file;
  const base = f.split('/').pop() ?? '';
  // Next.js App Router
  if (/^route\.(ts|js|tsx|jsx|mts)$/.test(base) && /(^|\/)app\//.test(f) && !/\/components\//.test(f)) {
    const path = nextRoutePath(f, /(^|\/)app\//);
    for (const e of mod.exports) {
      if (!NEXT_VERBS.includes(e.name)) continue;
      const handler = e.value ? g.handlerUnit(e.value, mod.root) : null;
      const wrapper = e.value ? wrapperName(e.value, mod.root) : undefined;
      add({ method: e.name, path, file: f, line: handler?.line ?? e.line, kind: 'route', framework: 'Next.js', handler, authHints: wrapper && AUTH_MW.test(wrapper) ? [{ how: wrapper, line: e.line, file: f }] : [], certainty: 'seen', wrapper });
    }
    return;
  }
  // Next.js Pages Router API and Vercel functions
  if (/(^|\/)pages\/api\//.test(f)) {
    addDefault(g, mod, pagesPath(f, /(^|\/)pages\//), 'Next.js', add);
    return;
  }
  if (/(^|\/)api\//.test(f) && /\.(ts|js|mjs)$/.test(f) && !g.uses(f, 'next') && !/(^|\/)(src|lib|apps?|packages|server|client)\/.*api\//.test(f) && mod.exports.some((e) => e.name === 'default')) {
    addDefault(g, mod, `/${f.slice(f.indexOf('api/')).replace(/\.[a-z]+$/, '').replace(/\/index$/, '')}`, 'Vercel function', add);
    return;
  }
  // SvelteKit
  if (/\+server\.(ts|js)$/.test(base)) {
    const path = nextRoutePath(f, /(^|\/)src\/routes\//);
    for (const e of mod.exports) {
      if (!NEXT_VERBS.includes(e.name) || !e.value) continue;
      const handler = g.handlerUnit(e.value, mod.root);
      add({ method: e.name, path, file: f, line: handler?.line ?? e.line, kind: 'route', framework: 'SvelteKit', handler, authHints: [], certainty: 'seen' });
    }
    return;
  }
  // Nuxt
  const nuxt = f.match(/(^|\/)server\/(api|routes)\/(.+?)(?:\.(get|post|put|patch|delete))?\.(ts|js)$/);
  if (nuxt && g.uses(f, 'nuxt')) {
    const def = mod.exports.find((e) => e.name === 'default');
    const prefix = nuxt[2] === 'api' ? '/api' : '';
    const path = `${prefix}/${nuxt[3].replace(/\/index$/, '').replace(/\[(.+?)\]/g, ':$1')}`;
    add({ method: nuxt[4]?.toUpperCase() ?? 'ANY', path, file: f, line: def?.line ?? 1, kind: 'route', framework: 'Nuxt', handler: def?.value ? g.handlerUnit(def.value, mod.root) : null, authHints: [], certainty: 'seen' });
    return;
  }
  // Supabase Edge Functions
  const edge = f.match(/(^|\/)supabase\/functions\/([^/]+)\/index\.(ts|js)$/);
  if (edge) {
    let handler: Unit | null = null;
    let line = 1;
    for (const u of mod.units.values()) {
      for (const c of u.calls) {
        const name = chainOf(c).join('.');
        if (name === 'serve' || name === 'Deno.serve') {
          const a = argsOf(c);
          const fn = a[a.length - 1];
          if (fn) handler = g.handlerUnit(fn, u);
          line = c.line;
        }
      }
    }
    add({ method: 'ANY', path: `/functions/v1/${edge[2]}`, file: f, line, kind: 'function', framework: 'Supabase Edge Function', handler, authHints: [], certainty: 'seen' });
  }
}

function addDefault(g: Graph, mod: Module, path: string, framework: string, add: (r: Omit<RouteRec, 'id'>) => void): void {
  const def = mod.exports.find((e) => e.name === 'default');
  if (!def?.value) return;
  const handler = g.handlerUnit(def.value, mod.root);
  const wrapper = wrapperName(def.value, mod.root);
  const methods = handler ? methodsFromBody(handler) : [];
  add({ method: methods.length === 1 ? methods[0] : 'ANY', path, file: mod.file, line: handler?.line ?? def.line, kind: 'route', framework, handler, authHints: wrapper && AUTH_MW.test(wrapper) ? [{ how: wrapper, line: def.line, file: mod.file }] : [], certainty: 'seen', wrapper });
}

function methodsFromBody(_u: Unit): string[] {
  return [];
}

function wrapperName(v: Value, scope: Unit): string | undefined {
  if (v.k === 'call') return chainOf(v.call).join('.');
  if (v.k === 'ident') {
    const local = scope.locals.get(v.name);
    if (local?.k === 'call') return chainOf(local.call).join('.');
  }
  return undefined;
}

function actions(g: Graph, mod: Module, add: (r: Omit<RouteRec, 'id'>) => void): void {
  if (mod.directive === 'use server') {
    for (const e of mod.exports) {
      if (!e.value) continue;
      const handler = g.handlerUnit(e.value, mod.root);
      if (!handler) continue;
      add({ method: 'ACTION', path: e.name, file: mod.file, line: handler.line, kind: 'action', framework: 'Next.js server action', handler, authHints: [], certainty: 'seen' });
    }
  }
  for (const u of mod.units.values()) {
    if (u.directive === 'use server' && u.kind === 'fn') {
      add({ method: 'ACTION', path: u.name, file: mod.file, line: u.line, kind: 'action', framework: 'Next.js server action', handler: u, authHints: [], certainty: 'seen' });
    }
  }
}

function nestRoutes(mod: Module, add: (r: Omit<RouteRec, 'id'>) => void): void {
  for (const u of mod.units.values()) {
    const ctrl = u.classDecorators?.find((d) => d.name === 'Controller');
    if (!ctrl) continue;
    const base = literal(ctrl.args[0]) ?? '';
    for (const d of u.decorators) {
      if (!/^(Get|Post|Put|Patch|Delete|All)$/.test(d.name)) continue;
      const hints = [...u.decorators, ...(u.classDecorators ?? [])]
        .filter((x) => x.name === 'UseGuards')
        .map((x) => ({ how: 'UseGuards', line: x.line, file: mod.file }));
      add({ method: d.name.toUpperCase(), path: join(`/${base}`, literal(d.args[0]) ?? ''), file: mod.file, line: d.line, kind: 'route', framework: 'NestJS', handler: u, authHints: hints, certainty: 'seen' });
    }
  }
}

function pythonRoutes(g: Graph, mod: Module, add: (r: Omit<RouteRec, 'id'>) => void): void {
  for (const u of mod.units.values()) {
    for (const d of u.decorators) {
      const parts = d.name.split('.');
      const verb = parts[parts.length - 1];
      const owner = parts.slice(0, -1).join('.');
      if (!owner) continue;
      const isVerb = VERBS.has(verb);
      if (!isVerb && verb !== 'route') continue;
      const inst = pyInstance(mod, owner);
      if (!inst) continue;
      const path = literal(d.args[0]);
      if (path === null) continue;
      const prefix = inst.prefix + (pyIncludePrefix(g, mod, owner) ?? '');
      const hints: RouteRec['authHints'] = [];
      for (const dep of u.decorators) {
        if (dep.name.startsWith('Depends:') && AUTH_MW.test(dep.name)) hints.push({ how: dep.name.slice(8), line: dep.line, file: mod.file });
        if (/login_required|jwt_required|auth/i.test(dep.name) && dep !== d) hints.push({ how: dep.name, line: dep.line, file: mod.file });
      }
      const pyd = [...u.paramTypes.values()].find((t) => pydantic(g, mod, t));
      add({ method: isVerb ? verb.toUpperCase() : 'ANY', path: normPath(join(prefix, path)), file: mod.file, line: d.line, kind: 'route', framework: inst.framework, handler: u, authHints: hints, certainty: 'seen', validatedBy: pyd ? { how: pyd, line: u.line, file: mod.file } : undefined });
    }
  }
}

function pydantic(g: Graph, mod: Module, type: string): boolean {
  if (mod.typeAliases.has(`pydantic:${type}`)) return true;
  const im = mod.imports.find((i) => i.local === type);
  if (!im) return false;
  const r = g.resolve(mod.file, im.source);
  return r.kind === 'file' && !!g.modules.get(r.file)?.typeAliases.has(`pydantic:${im.imported}`);
}

function pyInstance(mod: Module, name: string): { framework: string; prefix: string } | null {
  const v = mod.root.locals.get(name);
  if (v?.k === 'call') {
    const chain = chainOf(v.call).join('.');
    if (/(^|\.)(FastAPI)$/.test(chain)) return { framework: 'FastAPI', prefix: '' };
    if (/(^|\.)APIRouter$/.test(chain)) {
      const obj = argsOf(v.call).find((a) => a.k === 'obj');
      return { framework: 'FastAPI', prefix: (obj?.k === 'obj' && literal(obj.props.prefix)) || '' };
    }
    if (/(^|\.)Flask$/.test(chain)) return { framework: 'Flask', prefix: '' };
    if (/(^|\.)Blueprint$/.test(chain)) {
      const obj = argsOf(v.call).find((a) => a.k === 'obj');
      return { framework: 'Flask', prefix: (obj?.k === 'obj' && literal(obj.props.url_prefix)) || '' };
    }
  }
  return null;
}

function pyIncludePrefix(g: Graph, mod: Module, owner: string): string | null {
  for (const other of g.modules.values()) {
    if (other.language !== 'python') continue;
    for (const c of other.root.calls) {
      const chain = chainOf(c);
      if (chain[chain.length - 1] !== 'include_router' && chain[chain.length - 1] !== 'register_blueprint') continue;
      const a = argsOf(c);
      const first = a[0];
      const name = first?.k === 'ident' ? first.name : first?.k === 'member' ? first.chain[first.chain.length - 1] : null;
      if (!name) continue;
      const im = other.imports.find((i) => i.local === (first!.k === 'member' ? (first as any).chain[0] : name));
      const matches = im && (first!.k === 'member' ? mod.file.includes(im.local) : name === owner || mod.file.includes(im.source.replace(/\./g, '/')));
      if (!matches) continue;
      const obj = a.find((x) => x.k === 'obj');
      if (obj?.k === 'obj') {
        const p = literal(obj.props.prefix) ?? literal(obj.props.url_prefix);
        if (p) return p;
      }
    }
  }
  return null;
}

function instanceKey(r: Ref | null): string | null {
  if (r?.t === 'instance') return `${r.scope.file}:${r.site.line}`;
  return null;
}

function routerRoutes(g: Graph, add: (r: Omit<RouteRec, 'id'>) => void, gaps: Gap[], src: Sources): void {
  const instances = new Map<string, RouterInstance>();
  const getInst = (r: Extract<Ref, { t: 'instance' }>): RouterInstance => {
    const key = instanceKey(r)!;
    let inst = instances.get(key);
    if (!inst) {
      const chain = chainOf(r.site);
      const isRouter = /Router$/.test(chain[chain.length - 1]);
      const framework = r.pkg.startsWith('hono') || r.pkg.startsWith('@hono') ? 'Hono' : r.pkg === 'fastify' ? 'Fastify' : r.pkg.includes('koa') ? 'Koa' : 'Express';
      inst = { key, file: r.scope.file, line: r.site.line, isApp: !isRouter, framework, mounts: [], uses: [], routes: [] };
      instances.set(key, inst);
    }
    return inst;
  };

  for (const mod of g.modules.values()) {
    if (mod.language !== 'js') continue;
    for (const unit of mod.units.values()) {
      for (const site of unit.calls) {
        const chain = chainOf(site);
        if (chain.length < 2) continue;
        const owner = g.member([chain[0]], unit, 0);
        let inst: RouterInstance | null = null;
        let certainty: Certainty = 'seen';
        if (owner?.t === 'instance') inst = getInst(owner);
        else if (owner?.t === 'param' && /^(app|router|server|fastify|instance|api)$/i.test(chain[0]) && anyServer(g, mod.file)) {
          const key = `param:${mod.file}`;
          inst = instances.get(key) ?? { key, file: mod.file, line: site.line, isApp: true, framework: serverName(g, mod.file), mounts: [], uses: [], routes: [] };
          instances.set(key, inst);
          certainty = 'inferred';
        }
        if (!inst) continue;
        site.parts.slice(1).forEach((part, i) => {
          const a = part.args;
          if (!a) return;
          if (VERBS.has(part.name) && a.length >= 2) {
            const path = literal(a[0]);
            if (path === null) return;
            const last = a[a.length - 1];
            const handler = g.handlerUnit(last, unit);
            const mw = a.slice(1, -1).map(valueName).filter(Boolean) as string[];
            inst!.routes.push({ method: part.name === 'all' ? 'ANY' : part.name.toUpperCase(), path, line: site.line, handler, mw, file: mod.file, certainty });
          } else if (part.name === 'route' && a[0] && i === 0) {
            const path = literal(a[0]);
            if (path !== null && a.length === 1) {
              site.parts.slice(2).forEach((p) => {
                if (p.args && VERBS.has(p.name)) {
                  const last = p.args[p.args.length - 1];
                  inst!.routes.push({ method: p.name.toUpperCase(), path, line: site.line, handler: last ? g.handlerUnit(last, unit) : null, mw: [], file: mod.file, certainty });
                }
              });
            } else if (path !== null && a[1]) {
              const child = g.evaluate(a[1], unit);
              if (child?.t === 'instance') getInst(child).mounts.push({ parent: inst!.key, prefix: path });
            }
          } else if (part.name === 'use' || part.name === 'register') {
            let prefix = '';
            const rest = [...a];
            if (rest[0] && literal(rest[0]) !== null) prefix = literal(rest.shift())!;
            if (part.name === 'register' && rest[1]?.k === 'obj') prefix = literal(rest[1].props.prefix) ?? prefix;
            for (const x of rest) {
              const child = g.evaluate(x, unit);
              if (child?.t === 'instance') getInst(child).mounts.push({ parent: inst!.key, prefix });
              else {
                const nm = valueName(x);
                if (nm) inst!.uses.push({ prefix, name: nm, line: site.line, file: mod.file });
              }
            }
          }
        });
      }
    }
  }

  const prefixes = (inst: RouterInstance, seen = new Set<string>()): string[] => {
    if (seen.has(inst.key)) return [''];
    seen.add(inst.key);
    if (!inst.mounts.length) return [''];
    const out: string[] = [];
    for (const m of inst.mounts) {
      const parent = instances.get(m.parent);
      for (const p of parent ? prefixes(parent, seen) : ['']) out.push(join(p, m.prefix));
    }
    return out;
  };
  const inherited = (inst: RouterInstance, seen = new Set<string>()): RouterInstance['uses'] => {
    if (seen.has(inst.key)) return [];
    seen.add(inst.key);
    const out = [...inst.uses];
    for (const m of inst.mounts) {
      const parent = instances.get(m.parent);
      if (parent) out.push(...inherited(parent, seen));
    }
    return out;
  };

  for (const inst of instances.values()) {
    if (!inst.isApp && !inst.mounts.length && inst.routes.length) {
      gaps.push({ kind: 'unmounted-router', text: `A router in ${inst.file} defines ${inst.routes.length} route(s) but nothing mounts it, so they may not be reachable.`, evidence: src.evidence(inst.file, inst.line) });
    }
    for (const r of inst.routes) {
      for (const prefix of prefixes(inst)) {
        const full = normPath(join(prefix, r.path));
        const hints: RouteRec['authHints'] = [];
        for (const m of r.mw) if (AUTH_MW.test(m)) hints.push({ how: m, line: r.line, file: r.file });
        for (const u of inherited(inst)) {
          if (!AUTH_MW.test(u.name)) continue;
          const applies = !u.prefix || full.startsWith(u.prefix.replace(/\*.*$/, '').replace(/\/$/, ''));
          const sameFile = u.file === r.file;
          if (applies && (!sameFile || u.line < r.line)) hints.push({ how: u.name, line: u.line, file: u.file });
        }
        const validator = r.mw.find((m) => /valid|schema/i.test(m));
        add({ method: r.method, path: full, file: r.file, line: r.line, kind: 'route', framework: inst.framework, handler: r.handler, authHints: hints, certainty: r.certainty, validatedBy: validator ? { how: validator, line: r.line, file: r.file } : undefined });
      }
    }
  }
}

/** node:http, Bun.serve and Deno.serve: the routing is plain if-statements. */
function plainServers(g: Graph, add: (r: Omit<RouteRec, 'id'>) => void): void {
  for (const mod of g.modules.values()) {
    const isServer = [...mod.units.values()].some((u) => u.calls.some((c) => /(^|\.)(createServer|Bun\.serve|Deno\.serve)(\.|$)/.test(chainOf(c).join('.'))));
    if (!isServer) continue;
    for (const u of mod.units.values()) {
      for (const p of u.pathChecks) {
        add({ method: p.method ?? 'ANY', path: p.path, file: mod.file, line: p.line, kind: 'route', framework: 'Node server', handler: u, authHints: [], certainty: 'seen', range: [p.line, p.endLine] });
      }
    }
  }
}

function anyServer(g: Graph, file: string): boolean {
  return g.uses(file, 'express') || g.uses(file, 'fastify') || g.uses(file, 'hono') || g.uses(file, 'koa');
}

function serverName(g: Graph, file: string): string {
  return g.uses(file, 'hono') ? 'Hono' : g.uses(file, 'fastify') ? 'Fastify' : g.uses(file, 'koa') ? 'Koa' : 'Express';
}

function valueName(v: Value): string | null {
  if (v.k === 'ident') return v.name;
  if (v.k === 'member') return v.chain.join('.');
  if (v.k === 'call') return chainOf(v.call).join('.');
  return null;
}

function trpcRoutes(g: Graph, add: (r: Omit<RouteRec, 'id'>) => void): void {
  for (const mod of g.modules.values()) {
    for (const unit of mod.units.values()) {
      for (const site of unit.calls) {
        const chain = chainOf(site);
        const last = chain[chain.length - 1];
        if (last !== 'createTRPCRouter' && last !== 'router') continue;
        if (!g.uses(mod.file, '@trpc/server')) continue;
        const obj = argsOf(site)[0];
        if (obj?.k !== 'obj') continue;
        for (const [key, value] of Object.entries(obj.props)) {
          if (value.k !== 'call') continue;
          const c = chainOf(value.call);
          const end = c[c.length - 1];
          if (end !== 'query' && end !== 'mutation') continue;
          const fn = argsOf(value.call)[0];
          const handler = fn ? g.handlerUnit(fn, unit) : null;
          const root = c[0];
          add({
            method: end === 'query' ? 'QUERY' : 'MUTATION', path: key, file: mod.file, line: value.call.line, kind: 'route', framework: 'tRPC', handler,
            authHints: /protected|authed|admin|private/i.test(root) ? [{ how: root, line: value.call.line, file: mod.file }] : [],
            certainty: 'seen',
            validatedBy: c.includes('input') ? { how: 'input()', line: value.call.line, file: mod.file } : undefined,
          });
        }
      }
    }
  }
}

function cliCommands(g: Graph, add: (r: Omit<RouteRec, 'id'>) => void): void {
  // "claim": "tsx src/cli.ts" is a command too, even with no bin entry.
  for (const m of g.manifests) {
    for (const [name, cmd] of Object.entries(m.scripts)) {
      if (/^(dev|start|serve|server|build|test|lint|typecheck|format|prepare|preview|postinstall|deploy|worker)|eval|bench|:/.test(name)) continue;
      const hit = String(cmd).match(/^(?:tsx|ts-node|node|bun(?: run)?)\s+(?:--[^\s]+\s+)*([^\s]+\.(?:ts|tsx|js|mjs|cjs))/);
      if (!hit) continue;
      const file = g.resolve(m.file, `./${hit[1].replace(/^\.\//, '')}`);
      if (file.kind !== 'file') continue;
      add({ method: 'RUN', path: name, file: file.file, line: 1, kind: 'command', framework: 'Command line', handler: g.modules.get(file.file)?.root ?? null, authHints: [], certainty: 'seen' });
    }
  }
  for (const mod of g.modules.values()) {
    if (mod.language === 'python' && mod.notable.some((n) => n.detail === 'main') && !/(^|\/)(tests?|eval)\//.test(mod.file)) {
      add({ method: 'RUN', path: mod.file.split('/').pop() ?? mod.file, file: mod.file, line: 1, kind: 'command', framework: 'Python script', handler: mod.root, authHints: [], certainty: 'seen' });
    }
  }
  for (const m of g.manifests) {
    const bin = m.json.bin;
    if (!bin) continue;
    const entries: Array<[string, string]> = typeof bin === 'string' ? [[m.name ?? 'cli', bin]] : Object.entries(bin);
    for (const [name, target] of entries) {
      const file = g.resolve(m.file, `./${String(target).replace(/^\.\//, '').replace(/^dist\//, 'src/')}`);
      if (file.kind !== 'file') continue;
      add({ method: 'RUN', path: name, file: file.file, line: 1, kind: 'command', framework: 'Command line', handler: g.modules.get(file.file)?.root ?? null, authHints: [], certainty: 'seen' });
    }
  }
}

function markCrons(g: Graph, routes: RouteRec[]): void {
  for (const [path, f] of g.files) {
    if (!/(^|\/)vercel\.json$/.test(path)) continue;
    const json = parseLooseJson(f.content);
    for (const c of json?.crons ?? []) {
      for (const r of routes) if (r.path === c.path) r.kind = 'cron';
    }
  }
}

function resolveComponent(g: Graph, value: Value, scope: Unit): Unit | null {
  if (value.k === 'jsx') {
    const ref = g.lookup(scope, value.name);
    if (ref?.t === 'unit') return ref.unit;
    return null;
  }
  return g.handlerUnit(value, scope);
}

export function findScreens(g: Graph): ScreenRec[] {
  const out: ScreenRec[] = [];
  const seen = new Set<string>();
  const add = (s: Omit<ScreenRec, 'id'>): void => {
    if (seen.has(`${s.path}|${s.file}`)) return;
    seen.add(`${s.path}|${s.file}`);
    out.push({ ...s, id: `screen:${s.path}:${s.file}` });
  };
  const entryOf = (mod: Module): Unit | null => {
    const def = mod.exports.find((e) => e.name === 'default');
    return def?.value ? g.handlerUnit(def.value, mod.root) : null;
  };

  for (const mod of g.modules.values()) {
    const f = mod.file;
    const base = f.split('/').pop() ?? '';
    if (/^page\.(tsx|jsx|js|ts|mdx)$/.test(base) && /(^|\/)app\//.test(f) && g.uses(f, 'next')) {
      const path = nextRoutePath(f, /(^|\/)app\//);
      add({ path, file: f, name: humanName(path, f), render: mod.directive === 'use client' ? 'browser' : 'server', framework: 'Next.js', entry: entryOf(mod), line: 1 });
    } else if (/(^|\/)pages\//.test(f) && !/(^|\/)pages\/api\//.test(f) && !/(^|\/)_(app|document|error)\./.test(f) && /\.(tsx|jsx|js)$/.test(f) && g.uses(f, 'next')) {
      const path = pagesPath(f, /(^|\/)pages\//);
      add({ path, file: f, name: humanName(path, f), render: 'browser', framework: 'Next.js', entry: entryOf(mod), line: 1 });
    } else if (/(^|\/)app\//.test(f) && g.uses(f, 'expo-router') && /\.(tsx|jsx)$/.test(f) && !/_layout\.|\+[a-z]/.test(base) && !/\/(components|lib|hooks)\//.test(f)) {
      const path = pagesPath(f, /(^|\/)app\//).replace(/\/\([^)]+\)/g, '') || '/';
      add({ path, file: f, name: humanName(path, f), render: 'native', framework: 'Expo Router', entry: entryOf(mod), line: 1 });
    } else if (/\+page\.svelte$/.test(base)) {
      const path = nextRoutePath(f, /(^|\/)src\/routes\//);
      add({ path, file: f, name: humanName(path, f), render: 'browser', framework: 'SvelteKit', entry: mod.root, line: 1 });
    } else if (/(^|\/)pages\//.test(f) && /\.vue$/.test(f) && g.uses(f, 'nuxt')) {
      const path = pagesPath(f, /(^|\/)pages\//);
      add({ path, file: f, name: humanName(path, f), render: 'browser', framework: 'Nuxt', entry: mod.root, line: 1 });
    } else if (/(^|\/)src\/pages\//.test(f) && /\.astro$/.test(f)) {
      const path = pagesPath(f, /(^|\/)src\/pages\//);
      add({ path, file: f, name: humanName(path, f), render: 'server', framework: 'Astro', entry: mod.root, line: 1 });
    }

    if (mod.language === 'python' && mod.imports.some((i) => i.source === 'streamlit' || i.source === 'gradio')) {
      add({ path: '/', file: f, name: 'Home', render: 'server', framework: mod.imports.some((i) => i.source === 'streamlit') ? 'Streamlit' : 'Gradio', entry: mod.root, line: 1 });
    }

    // React Router, in JSX or as objects, and React Navigation.
    for (const u of mod.units.values()) {
      for (const j of u.jsx) {
        if (j.name === 'Route' || j.name.endsWith('.Route')) {
          const path = literal(j.props.path);
          const el = j.props.element ?? j.props.component ?? j.props.Component;
          if (path === null || !el) continue;
          const entry = resolveComponent(g, el, u);
          add({ path: path.startsWith('/') ? path : `/${path}`, file: entry?.file ?? f, name: humanName(path, f), render: 'browser', framework: 'React Router', entry, line: j.line });
        }
        if (/\.Screen$/.test(j.name)) {
          const name = literal(j.props.name);
          const el = j.props.component;
          if (name === null || !el) continue;
          const entry = resolveComponent(g, el, u);
          add({ path: `/${name}`, file: entry?.file ?? f, name, render: 'native', framework: 'React Navigation', entry, line: j.line });
        }
      }
      for (const c of u.calls) {
        const name = chainOf(c).pop();
        if (name === 'createBrowserRouter' || name === 'createHashRouter' || name === 'useRoutes') {
          const a = argsOf(c)[0];
          if (a?.k === 'arr') routeObjects(g, a, u, '', add, f);
        }
      }
    }
  }

  if (!out.length) spaFallback(g, add);
  return out;
}

function routeObjects(g: Graph, arr: Extract<Value, { k: 'arr' }>, scope: Unit, prefix: string, add: (s: Omit<ScreenRec, 'id'>) => void, file: string): void {
  for (const item of arr.items) {
    if (item.k !== 'obj') continue;
    const rawPath = literal(item.props.path);
    const path = rawPath === null ? prefix || '/' : join(prefix, rawPath);
    const el = item.props.element ?? item.props.Component ?? item.props.component;
    if (el && (rawPath !== null || item.props.index)) {
      const entry = resolveComponent(g, el, scope);
      add({ path, file: entry?.file ?? file, name: humanName(path, file), render: 'browser', framework: 'React Router', entry, line: 1 });
    }
    if (item.props.children?.k === 'arr') routeObjects(g, item.props.children, scope, path, add, file);
  }
}

/** Single page apps with no router: find what createRoot renders. */
function spaFallback(g: Graph, add: (s: Omit<ScreenRec, 'id'>) => void): void {
  for (const mod of g.modules.values()) {
    if (mod.language !== 'js') continue;
    const renders = mod.root.calls.some((c) => {
      const chain = chainOf(c);
      return chain[chain.length - 1] === 'render' && (chain.includes('createRoot') || chain.includes('ReactDOM') || chain[0] === 'root' || chain[0] === 'render');
    });
    if (!renders) continue;
    const j = mod.root.jsx.map((x) => g.lookup(mod.root, x.name)).find((r) => r?.t === 'unit');
    if (j?.t === 'unit') {
      add({ path: '/', file: j.unit.file, name: 'Home', render: 'browser', framework: 'React', entry: j.unit, line: j.unit.line });
    }
  }
  // Plain HTML with a module script.
  for (const [path, f] of g.files) {
    if (!/\.html$/.test(path) || /(^|\/)(dist|coverage|docs?)\//.test(path)) continue;
    const m = f.content.match(/<script[^>]+src=["']([^"']+\.(?:ts|tsx|js|jsx|mjs))["']/);
    const script = m ? g.resolve(path, m[1].startsWith('/') ? `.${m[1]}` : m[1]) : null;
    const scriptFile = script?.kind === 'file' ? script.file : undefined;
    const mod = scriptFile ? g.modules.get(scriptFile) : undefined;
    if (mod && mod.root.jsx.length) continue;
    const web = base(path);
    add({ path: web === 'index' ? '/' : `/${web}`, file: scriptFile ?? path, name: humanName(web === 'index' ? '/' : `/${web}`, path), render: 'browser', framework: 'HTML', entry: mod?.root ?? null, line: 1 });
  }
}

function base(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.html$/, '');
}

/** Every unit that renders as part of a screen. */
export function screenClosure(g: Graph, entry: Unit | null): Unit[] {
  if (!entry) return [];
  const seen = new Set<string>();
  const out: Unit[] = [];
  const stack = [entry];
  while (stack.length && out.length < 800) {
    const u = stack.pop()!;
    if (seen.has(u.id)) continue;
    seen.add(u.id);
    out.push(u);
    for (const c of g.childrenOf(u.id)) stack.push(c);
    for (const j of u.jsx) {
      const ref = jsxTarget(g, j.name, u);
      if (ref) stack.push(ref);
    }
    // A module script pulls in what it imports.
    if (u.kind === 'module') {
      const mod = g.modules.get(u.file);
      for (const im of mod?.imports ?? []) {
        const r = g.resolve(u.file, im.source);
        if (r.kind === 'file') {
          const m = g.modules.get(r.file);
          if (m) stack.push(m.root);
        }
      }
    }
  }
  return out;
}

function jsxTarget(g: Graph, name: string, scope: Unit): Unit | null {
  if (!/^[A-Z]/.test(name)) return null;
  const ref = name.includes('.') ? g.member(name.split('.'), scope, 0) : g.lookup(scope, name);
  if (ref?.t === 'unit') return ref.unit;
  return null;
}

export function evidenceFor(src: Sources, file: string, line: number, endLine?: number): Evidence {
  return src.evidence(file, line, endLine ?? line);
}

export function isCallSite(x: unknown): x is CallSite {
  return !!x && typeof x === 'object' && 'parts' in (x as any);
}

export { joinPath };
