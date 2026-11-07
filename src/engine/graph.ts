import { catalogFor } from './catalog';
import type { CatalogEntry } from './catalog';
import { dirname, joinPath, normalize, parseLooseJson } from './files';
import { argsOf, chainOf, literal } from './model';
import type { CallSite, Module, Unit, Value } from './model';
import type { VirtualFile } from './types';

const NODE_BUILTIN = new Set(['fs', 'path', 'os', 'http', 'https', 'crypto', 'url', 'util', 'stream', 'events', 'child_process', 'buffer', 'net', 'tls', 'zlib', 'assert', 'readline', 'worker_threads', 'cluster', 'dns', 'perf_hooks', 'querystring', 'timers', 'module', 'vm', 'process', 'async_hooks', 'fs/promises', 'sqlite', 'test']);
const EXT_ORDER = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.mjs'];
const FACTORY_NAME = /^(create|new|init|setup|make|configure|build|get.*(Client|Instance|Connection|Db|Database|Pool)|drizzle|connect|Pool|Client|OpenAI|Anthropic|Stripe|Resend|model|getGenerativeModel|createClient)/i;
const BUILDER_LINK = /^(from|table|collection|db|database|schema|storage|bucket|auth|admin|model|models|rpc|getGenerativeModel|chat|completions|messages|beta|responses|query|mutate|prepare|cursor|Session|session|client)$/;

export type Ref =
  | { t: 'unit'; unit: Unit }
  | { t: 'ext'; pkg: string; name: string }
  | { t: 'svc'; entry: CatalogEntry; pkg: string; target?: string }
  | { t: 'instance'; site: CallSite; pkg: string; scope: Unit }
  | { t: 'obj'; props: Record<string, Value>; scope: Unit }
  | { t: 'val'; value: Value; scope: Unit }
  | { t: 'module'; file: string }
  | { t: 'param'; unit: Unit; index: number; type?: string }
  | { t: 'class'; file: string; name: string };

export interface Manifest {
  dir: string;
  file: string;
  name?: string;
  json: any;
  deps: Record<string, string>;
  devDeps: Record<string, string>;
  scripts: Record<string, string>;
  rawLines: string[];
}

interface Alias {
  base: string;
  prefix: string;
  suffix: string;
  targets: string[];
  hasStar: boolean;
}

export type Resolved =
  | { kind: 'file'; file: string }
  | { kind: 'package'; name: string; sub: string }
  | { kind: 'builtin'; name: string }
  | { kind: 'missing'; source: string };

export class Graph {
  modules = new Map<string, Module>();
  manifests: Manifest[] = [];
  private workspaces = new Map<string, Manifest>();
  private aliases: Alias[] = [];
  private fileSet: Set<string>;
  private children = new Map<string, Unit[]>();
  private resolveCache = new Map<string, Resolved>();
  importers = new Map<string, Set<string>>();

  constructor(public files: Map<string, VirtualFile>) {
    this.fileSet = new Set(files.keys());
    this.readManifests();
    this.readTsconfigs();
  }

  private readManifests(): void {
    for (const [path, f] of this.files) {
      if (!/(^|\/)package\.json$/.test(path)) continue;
      const json = parseLooseJson(f.content);
      if (!json) continue;
      const m: Manifest = {
        dir: dirname(path), file: path, name: json.name, json,
        deps: json.dependencies ?? {}, devDeps: json.devDependencies ?? {}, scripts: json.scripts ?? {},
        rawLines: f.content.split('\n'),
      };
      this.manifests.push(m);
      if (json.name) this.workspaces.set(json.name, m);
    }
    this.manifests.sort((a, b) => a.dir.length - b.dir.length);
  }

  private readTsconfigs(): void {
    for (const [path, f] of this.files) {
      if (!/(^|\/)(tsconfig|jsconfig)[^/]*\.json$/.test(path)) continue;
      const json = parseLooseJson(f.content);
      const paths = json?.compilerOptions?.paths;
      const dir = dirname(path);
      const baseUrl = joinPath(dir, json?.compilerOptions?.baseUrl ?? '.');
      if (paths) {
        for (const [pattern, targets] of Object.entries<any>(paths)) {
          const star = pattern.indexOf('*');
          this.aliases.push({
            base: dir,
            prefix: star === -1 ? pattern : pattern.slice(0, star),
            suffix: star === -1 ? '' : pattern.slice(star + 1),
            targets: (targets as string[]).map((t) => joinPath(baseUrl, t)),
            hasStar: star !== -1,
          });
        }
      } else if (json?.compilerOptions?.baseUrl) {
        this.aliases.push({ base: dir, prefix: '', suffix: '', targets: [`${baseUrl}/*`], hasStar: true });
      }
    }
    // Longest prefix wins, nearest config wins.
    this.aliases.sort((a, b) => b.base.length - a.base.length || b.prefix.length - a.prefix.length);
  }

  add(mod: Module): void {
    this.modules.set(mod.file, mod);
  }

  /** Call after all modules are added. */
  link(): void {
    for (const mod of this.modules.values()) {
      for (const u of mod.units.values()) {
        if (!u.parent) continue;
        const list = this.children.get(u.parent) ?? [];
        list.push(u);
        this.children.set(u.parent, list);
      }
      for (const im of mod.imports) {
        const r = this.resolve(mod.file, im.source);
        if (r.kind === 'file') {
          const set = this.importers.get(r.file) ?? new Set();
          set.add(mod.file);
          this.importers.set(r.file, set);
        }
      }
      for (const d of mod.dynamicImports) {
        if (!d.source) continue;
        const r = this.resolve(mod.file, d.source);
        if (r.kind === 'file') {
          const set = this.importers.get(r.file) ?? new Set();
          set.add(mod.file);
          this.importers.set(r.file, set);
        }
      }
      for (const e of [...mod.exports.map((x) => x.source).filter(Boolean) as string[], ...mod.starExports]) {
        const r = this.resolve(mod.file, e);
        if (r.kind === 'file') {
          const set = this.importers.get(r.file) ?? new Set();
          set.add(mod.file);
          this.importers.set(r.file, set);
        }
      }
    }
  }

  childrenOf(id: string): Unit[] {
    return this.children.get(id) ?? [];
  }

  private tryFile(p: string): string | null {
    const clean = normalize(p);
    if (this.fileSet.has(clean)) return clean;
    for (const ext of EXT_ORDER) {
      if (this.fileSet.has(clean + ext)) return clean + ext;
    }
    // Authors write './x.js' in TypeScript ESM.
    const swapped = clean.replace(/\.(m|c)?js$/, '');
    if (swapped !== clean) {
      for (const ext of ['.ts', '.tsx', '.mts', '.cts']) {
        if (this.fileSet.has(swapped + ext)) return swapped + ext;
      }
    }
    return null;
  }

  resolve(from: string, source: string): Resolved {
    const key = `${from}|${source}`;
    const hit = this.resolveCache.get(key);
    if (hit) return hit;
    const out = this.resolveUncached(from, source);
    this.resolveCache.set(key, out);
    return out;
  }

  private resolvePython(from: string, source: string): Resolved {
    const dots = source.match(/^\.+/)?.[0].length ?? 0;
    const rest = source.slice(dots).replace(/\./g, '/');
    const tryPy = (base: string): string | null => {
      for (const c of [`${base}.py`, `${base}/__init__.py`]) if (this.fileSet.has(c)) return c;
      return null;
    };
    if (dots) {
      let dir = dirname(from);
      for (let i = 1; i < dots; i++) dir = dirname(dir);
      const found = rest ? tryPy(joinPath(dir, rest)) : tryPy(joinPath(dir, '__init__')) ?? (this.fileSet.has(joinPath(dir, '__init__.py')) ? joinPath(dir, '__init__.py') : null);
      return found ? { kind: 'file', file: found } : { kind: 'missing', source };
    }
    let dir = dirname(from);
    for (;;) {
      const found = tryPy(joinPath(dir, rest));
      if (found) return { kind: 'file', file: found };
      if (!dir) break;
      dir = dirname(dir);
    }
    const src = tryPy(joinPath('src', rest));
    if (src) return { kind: 'file', file: src };
    return { kind: 'package', name: source.split('.')[0], sub: '' };
  }

  private resolveUncached(from: string, source: string): Resolved {
    if (from.endsWith('.py')) return this.resolvePython(from, source);
    if (source.startsWith('.') || source.startsWith('/')) {
      const found = this.tryFile(source.startsWith('/') ? source : joinPath(dirname(from), source));
      return found ? { kind: 'file', file: found } : { kind: 'missing', source };
    }
    for (const a of this.aliases) {
      if (a.base && !from.startsWith(`${a.base}/`)) continue;
      if (a.hasStar) {
        if (!source.startsWith(a.prefix) || !source.endsWith(a.suffix)) continue;
        if (a.prefix === '' && a.suffix === '' && !this.isLocalLooking(source)) continue;
        const middle = source.slice(a.prefix.length, source.length - a.suffix.length);
        for (const t of a.targets) {
          const found = this.tryFile(t.replace('*', middle));
          if (found) return { kind: 'file', file: found };
        }
      } else if (source === a.prefix) {
        for (const t of a.targets) {
          const found = this.tryFile(t);
          if (found) return { kind: 'file', file: found };
        }
      }
    }
    const bare = source.replace(/^node:/, '');
    if (source.startsWith('node:') || NODE_BUILTIN.has(bare)) return { kind: 'builtin', name: bare };
    const name = source.startsWith('@') ? source.split('/').slice(0, 2).join('/') : source.split('/')[0];
    const ws = this.workspaces.get(name);
    if (ws) {
      const sub = source.slice(name.length + 1);
      const main = this.workspaceEntry(ws, sub);
      if (main) return { kind: 'file', file: main };
    }
    return { kind: 'package', name, sub: source.slice(name.length + 1) };
  }

  private isLocalLooking(source: string): boolean {
    return !!this.tryFile(source) || !!this.tryFile(`src/${source}`);
  }

  private workspaceEntry(ws: Manifest, sub: string): string | null {
    if (sub) {
      return this.tryFile(joinPath(ws.dir, 'src', sub)) ?? this.tryFile(joinPath(ws.dir, sub));
    }
    const exp = ws.json.exports;
    const candidates: string[] = [];
    const push = (x: any): void => {
      if (typeof x === 'string') candidates.push(x);
      else if (x && typeof x === 'object') for (const k of ['.', 'import', 'types', 'default', 'require']) if (x[k]) push(x[k]);
    };
    push(exp);
    for (const k of ['source', 'module', 'main', 'types']) if (ws.json[k]) candidates.push(ws.json[k]);
    candidates.push('src/index', 'index');
    for (const c of candidates) {
      const f = this.tryFile(joinPath(ws.dir, c.replace(/^dist\//, 'src/').replace(/\.d\.ts$/, '')));
      if (f) return f;
    }
    return null;
  }

  /** The manifest closest to a file. */
  manifestFor(file: string): Manifest | undefined {
    let best: Manifest | undefined;
    for (const m of this.manifests) {
      if ((m.dir === '' || file.startsWith(`${m.dir}/`)) && (!best || m.dir.length >= best.dir.length)) best = m;
    }
    return best;
  }

  /** Is this package a dependency anywhere the file can see? */
  uses(file: string, pkg: string): boolean {
    for (const m of this.manifests) {
      if (m.dir !== '' && !file.startsWith(`${m.dir}/`)) continue;
      if (m.deps[pkg] || m.devDeps[pkg]) return true;
    }
    return false;
  }

  unit(id: string): Unit | undefined {
    const file = id.slice(0, id.indexOf('#'));
    return this.modules.get(file)?.units.get(id);
  }

  parentOf(u: Unit): Unit | undefined {
    return u.parent ? this.unit(u.parent) : undefined;
  }

  /** Resolve a name in the scope of a unit. */
  lookup(scope: Unit, name: string, depth = 0): Ref | null {
    if (depth > 12) return null;
    let cur: Unit | undefined = scope;
    while (cur) {
      if (cur.locals.has(name)) {
        const v = cur.locals.get(name)!;
        if (v.k === 'unknown') return null;
        return this.evaluate(v, cur, depth + 1);
      }
      const i = cur.params.indexOf(name);
      if (i !== -1) {
        const type = this.paramType(cur, name);
        const cls = type ? this.resolveType(cur.file, type, depth + 1) : null;
        return cls ?? { t: 'param', unit: cur, index: i, type };
      }
      cur = this.parentOf(cur);
    }
    const mod = this.modules.get(scope.file);
    const im = mod?.imports.find((x) => x.local === name);
    if (im) return this.followImport(scope.file, im.source, im.imported, depth + 1);
    return null;
  }

  private paramType(unit: Unit, name: string): string | undefined {
    const raw = unit.paramTypes.get(name);
    if (!raw) return undefined;
    if (!raw.includes('.')) return raw;
    const [iface, field] = raw.split('.');
    return this.interfaceField(unit.file, iface, field) ?? undefined;
  }

  private interfaceField(file: string, iface: string, field: string, depth = 0): string | null {
    if (depth > 4) return null;
    const mod = this.modules.get(file);
    const hit = mod?.interfaces.get(iface)?.get(field);
    if (hit) return hit;
    const im = mod?.imports.find((x) => x.local === iface);
    if (im) {
      const r = this.resolve(file, im.source);
      if (r.kind === 'file') return this.interfaceField(r.file, im.imported === 'default' ? iface : im.imported, field, depth + 1);
    }
    return null;
  }

  /** From a type name to a class we can look inside. */
  resolveType(file: string, type: string, depth = 0): Ref | null {
    if (depth > 8 || type.startsWith('typeof ')) return null;
    const mod = this.modules.get(file);
    if (!mod) return null;
    if (mod.classes.has(type)) return { t: 'class', file, name: type };
    const alias = mod.typeAliases.get(type);
    if (alias) return this.resolveType(file, alias, depth + 1);
    const im = mod.imports.find((x) => x.local === type);
    if (im) {
      const r = this.resolve(file, im.source);
      if (r.kind === 'file') return this.resolveType(r.file, im.imported === 'default' ? type : im.imported, depth + 1);
      if (r.kind === 'package' || r.kind === 'builtin') {
        const pkg = r.kind === 'builtin' ? `node:${r.name}` : r.name;
        const entry = catalogFor(pkg);
        if (entry?.service) return { t: 'svc', entry, pkg };
      }
    }
    return null;
  }

  private classMember(base: Extract<Ref, { t: 'class' }>, seg: string, depth: number): Ref | null {
    const mod = this.modules.get(base.file);
    if (!mod) return null;
    const key = `${base.name}.${seg}`;
    const field = mod.classFields.get(key);
    if (field) {
      const scope = mod.units.get(field.unit) ?? mod.root;
      return this.evaluate(field.value, scope, depth + 1);
    }
    const type = mod.classFieldTypes.get(key);
    if (type) {
      const r = this.resolveType(base.file, type, depth + 1);
      if (r) return r;
    }
    for (const u of mod.units.values()) if (u.name === key) return { t: 'unit', unit: u };
    return null;
  }

  private classOf(scope: Unit): string | undefined {
    let cur: Unit | undefined = scope;
    while (cur) {
      if (cur.className) return cur.className;
      cur = this.parentOf(cur);
    }
    return undefined;
  }

  followImport(from: string, source: string, imported: string, depth: number): Ref | null {
    const r = this.resolve(from, source);
    if (r.kind === 'file') {
      if (imported === '*') return { t: 'module', file: r.file };
      if (imported === 'module.exports') return this.exported(r.file, 'default', depth + 1) ?? { t: 'module', file: r.file };
      const hit = this.exported(r.file, imported, depth + 1);
      if (hit) return hit;
      if (from.endsWith('.py')) {
        const sub = this.resolve(from, source.endsWith('.') ? `${source}${imported}` : `${source}.${imported}`);
        if (sub.kind === 'file') return { t: 'module', file: sub.file };
      }
      return null;
    }
    const name = imported === 'module.exports' ? '*' : imported;
    if (r.kind === 'package') return { t: 'ext', pkg: r.sub ? `${r.name}/${r.sub}` : r.name, name };
    if (r.kind === 'builtin') return { t: 'ext', pkg: `node:${r.name}`, name };
    return null;
  }

  exported(file: string, name: string, depth = 0, seen = new Set<string>()): Ref | null {
    if (depth > 12) return null;
    const key = `${file}|${name}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const mod = this.modules.get(file);
    if (!mod) return null;
    const e = mod.exports.find((x) => x.name === name);
    if (e) {
      if (e.source) return this.followImport(file, e.source, e.imported ?? 'default', depth + 1);
      if (e.value) return this.evaluate(e.value, mod.root, depth + 1);
    }
    if (name === 'default') {
      const ce = mod.exports.find((x) => x.name === 'default');
      if (ce?.value) return this.evaluate(ce.value, mod.root, depth + 1);
    }
    for (const s of mod.starExports) {
      const r = this.resolve(file, s);
      if (r.kind === 'file') {
        const hit = this.exported(r.file, name, depth + 1, seen);
        if (hit) return hit;
      }
    }
    return null;
  }

  evaluate(v: Value, scope: Unit, depth = 0): Ref | null {
    if (depth > 12) return null;
    switch (v.k) {
      case 'fn': {
        const u = this.unit(v.unit);
        return u ? { t: 'unit', unit: u } : null;
      }
      case 'ident':
        return this.lookup(scope, v.name, depth + 1);
      case 'member':
        return this.member(v.chain, scope, depth + 1);
      case 'obj':
        return { t: 'obj', props: v.props, scope };
      case 'class':
        return { t: 'class', file: scope.file, name: v.name };
      case 'pick': {
        const base = this.evaluate(v.from, scope, depth + 1);
        if (!base) return null;
        if (base.t === 'obj') {
          const inner = base.props[v.key];
          return inner ? this.evaluate(inner, base.scope, depth + 1) : null;
        }
        return null;
      }
      case 'call':
        return this.evalCall(v.call, scope, depth + 1);
      case 'str':
      case 'tpl':
      case 'arr':
      case 'num':
      case 'bool':
      case 'jsx':
        return { t: 'val', value: v, scope };
      default:
        return null;
    }
  }

  member(chain: string[], scope: Unit, depth: number): Ref | null {
    if (depth > 14) return null;
    const cls = chain[0] === 'this' ? this.classOf(scope) : undefined;
    let base: Ref | null = cls ? { t: 'class', file: scope.file, name: cls } : this.lookup(scope, chain[0], depth + 1);
    for (let i = 1; i < chain.length; i++) {
      if (!base) return null;
      const seg = chain[i];
      if (base.t === 'module') base = this.exported(base.file, seg, depth + 1);
      else if (base.t === 'class') base = this.classMember(base, seg, depth + 1);
      else if (base.t === 'obj') {
        const inner = base.props[seg];
        base = inner ? this.evaluate(inner, base.scope, depth + 1) : null;
      } else if (base.t === 'ext') base = { t: 'ext', pkg: base.pkg, name: base.name === '*' || base.name === 'default' ? seg : `${base.name}.${seg}` };
      else if (base.t === 'svc') base = { ...base, target: base.target };
      else if (base.t === 'instance') return base;
      else return null;
    }
    return base;
  }

  /** What does calling this produce? */
  evalCall(site: CallSite, scope: Unit, depth: number): Ref | null {
    if (depth > 12) return null;
    const chain = chainOf(site);
    const owner = this.unit(site.unit) ?? scope;
    const root = this.member(chain.length > 1 ? chain.slice(0, -1) : chain, owner, depth + 1);
    const full = chain.length > 1 ? this.member(chain, owner, depth + 1) : root;
    const last = chain[chain.length - 1];

    if (site.isNew && root?.t === 'class') return root;
    if (full?.t === 'class') return full;
    if (full?.t === 'unit') {
      for (const r of full.unit.returns) {
        const out = this.evaluate(r, full.unit, depth + 1);
        if (out && out.t !== 'val') return out;
      }
      return null;
    }
    if (root?.t === 'svc' || full?.t === 'svc') {
      const svc = (root?.t === 'svc' ? root : full) as Extract<Ref, { t: 'svc' }>;
      if (BUILDER_LINK.test(last)) {
        const lit = literal(argsOf(site)[0]);
        return { ...svc, target: lit ?? svc.target };
      }
      return null;
    }
    const ext = full?.t === 'ext' ? full : root?.t === 'ext' ? root : null;
    if (ext) {
      const entry = catalogFor(ext.pkg);
      if (isRouterFactory(ext.pkg, chain, site)) return { t: 'instance', site, pkg: ext.pkg, scope: owner };
      if (/^(axios|ky|got)/.test(ext.pkg) && (last === 'create' || last === 'extend')) return { t: 'instance', site, pkg: ext.pkg, scope: owner };
      if (entry?.service && (site.isNew || FACTORY_NAME.test(last) || FACTORY_NAME.test(ext.name) || (owner.file.endsWith('.py') && /^[A-Z]/.test(last)))) {
        const lit = literal(argsOf(site)[0]);
        const target = /model$/i.test(last) ? (lit ?? undefined) : undefined;
        return { t: 'svc', entry, pkg: ext.pkg, target };
      }
      if (ext.pkg === 'node:sqlite' && site.isNew) {
        const e = catalogFor('node:sqlite')!;
        return { t: 'svc', entry: e, pkg: ext.pkg };
      }
    }
    return null;
  }

  /** Every function reachable by name from a Value, unwrapping wrappers like withAuth(handler). */
  handlerUnit(v: Value, scope: Unit): Unit | null {
    const ref = this.evaluate(v, scope);
    if (ref?.t === 'unit') return ref.unit;
    if (v.k === 'call') {
      for (const a of argsOf(v.call)) {
        const u = this.handlerUnit(a, scope);
        if (u) return u;
      }
    }
    if (v.k === 'ident') {
      let cur: Unit | undefined = scope;
      while (cur) {
        const local = cur.locals.get(v.name);
        if (local?.k === 'call') return this.handlerUnit(local, cur);
        cur = this.parentOf(cur);
      }
    }
    return null;
  }

  pickUnit(site: CallSite): Unit {
    return this.unit(site.unit)!;
  }
}

function isRouterFactory(pkg: string, chain: string[], site: CallSite): boolean {
  const last = chain[chain.length - 1];
  if (pkg === 'express') return last === 'express' || last === 'Router' || chain.length === 1;
  if (pkg === 'hono' || pkg.startsWith('hono/') || pkg === '@hono/zod-openapi') return site.isNew;
  if (pkg === 'fastify') return true;
  if (pkg === 'koa-router' || pkg === '@koa/router') return site.isNew;
  return false;
}
