import { catalogById, catalogFor, serviceForEnv, serviceForHost } from './catalog';
import type { CatalogEntry } from './catalog';
import type { Graph, Ref } from './graph';
import { argsOf, chainOf, literal } from './model';
import type { CallSite, Unit, Value } from './model';
import type { RouteRec } from './surfaces';

const WRITE = /^(insert|insertOne|insertMany|update|updateOne|updateMany|upsert|delete|deleteOne|deleteMany|remove|create|createMany|save|destroy|set|add|put|push|send|store|findOneAndUpdate|findByIdAndUpdate|findOneAndDelete|findByIdAndDelete|bulkWrite|setDoc|addDoc|updateDoc|deleteDoc|hset|incr|expire|rpush|lpush|sadd|zadd|del|uploadBytes|upload|commit|transfer|sendTransaction)$/;
const READ = /^(select|find|findMany|findFirst|findUnique|findOne|findById|findAll|get|getAll|count|aggregate|query|list|exists|fetch|retrieve|getDoc|getDocs|hget|hgetall|lrange|smembers|mget|scan|all|single|maybeSingle|download|createSignedUrl|getPublicUrl)$/;
const AUTH_NAMES = /^(requireAuth|requireUser|requireSession|requireAdmin|requireLogin|ensureAuth|ensureAuthenticated|ensureUser|assertAuth|assertUser|assertAdmin|checkAuth|verifyAuth|verifyToken|verifyJwt|verifyJWT|verifySession|verifyIdToken|getSession|getServerSession|getCurrentUser|currentUser|getAuthUser|getAuthSession|authenticate|isAuthenticated|auth|getUser|getToken|validateSession|validateRequest|getServerUser|getUserOrThrow|getLoggedInUser|getAuth|protect)$/;
const ENFORCING = /^(require|ensure|assert|protect|verify)/i;
 /** Rate limiting is a guard too. Its own bookkeeping is not "changing data". */
const LIMIT_NAMES = /(rate.?limit|ratelimit|limiter|throttle|quota|^demoLimited$|Limited$|checkLimit|enforceLimit|withinBudget|checkBudget)/i;
const AUTH_LIBS = /^(next-auth|@auth\/|@clerk\/|better-auth|@auth0\/|jsonwebtoken|jose|lucia|firebase-admin)/;

export type Where = 'browser' | 'server';

export type Ev =
  | { t: 'enter'; unit: Unit; site?: CallSite; where: Where }
  | { t: 'http'; method: string; url: string; site: CallSite; unit: Unit; route?: RouteRec; external?: { host: string; entry: CatalogEntry | null }; where: Where; caught: boolean }
  | { t: 'svc'; entry: CatalogEntry; access: 'read' | 'write' | 'call'; label: string; target?: string; model?: string; site: CallSite; unit: Unit; where: Where; caught: boolean }
  | { t: 'auth'; how: string; site: CallSite; unit: Unit; enforced: boolean; where: Where }
  | { t: 'validate'; how: string; site: CallSite; unit: Unit; where: Where }
  | { t: 'limit'; how: string; site: CallSite; unit: Unit; where: Where }
  | { t: 'system'; what: string; access: 'read' | 'write' | 'call'; site: CallSite; unit: Unit; where: Where; caught: boolean };

export function isEffect(e: Ev): boolean {
  return e.t === 'http' || e.t === 'svc' || e.t === 'system';
}

interface Ctx {
  where: Where;
  caught: boolean;
  depth: number;
  stack: Set<string>;
  bind: Map<string, Value>;
  bindScope?: Unit;
  budget: { left: number };
  range?: [number, number];
}

export function normalizeUrl(raw: string): { path: string; host?: string } | null {
  const s = raw.trim();
  const abs = s.match(/^(?:https?:)?\/\/([^/?#]+)([^?#]*)/);
  if (abs) {
    const host = abs[1];
    if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/.test(host) && !host.endsWith(':11434')) {
      return { path: abs[2] || '/' };
    }
    return { path: abs[2] || '/', host };
  }
  let p = s.split(/[?#]/)[0];
  p = p.replace(/^(:p)+/, '');
  if (!p) return null;
  if (!p.startsWith('/')) {
    if (/^[a-z0-9_-]+(\/|$)/i.test(p)) p = `/${p}`;
    else return null;
  }
  return { path: p };
}

export function matchRoutePath(routePath: string, url: string): boolean {
  const a = routePath.split('/').filter(Boolean);
  const b = url.replace(/\/$/, '').split('/').filter(Boolean);
  for (let i = 0; i < a.length; i++) {
    const seg = a[i];
    if (seg.endsWith('*') && (seg.startsWith(':') || seg === '*')) return true;
    if (i >= b.length) return false;
    if (seg.startsWith(':')) continue;
    if (b[i] === ':p') continue;
    if (seg !== b[i].replace(/:p$/, '')) return false;
  }
  return a.length === b.length;
}

export class Tracer {
  private routesByKey: RouteRec[];

  constructor(public g: Graph, routes: RouteRec[]) {
    this.routesByKey = routes;
  }

  findRoute(method: string, url: string): RouteRec | undefined {
    const candidates = this.routesByKey.filter((r) => r.kind !== 'action' && r.kind !== 'command' && matchRoutePath(r.path, url));
    if (!candidates.length) return undefined;
    const exact = candidates.find((r) => r.method === method);
    if (exact) return exact;
    return candidates.find((r) => r.method === 'ANY') ?? undefined;
  }

  trace(unit: Unit, where: Where, bind?: Map<string, Value>, range?: [number, number]): Ev[] {
    return this.walk(unit, { where, caught: false, depth: 0, stack: new Set(), bind: bind ?? new Map(), budget: { left: 400 }, range });
  }

  traceRoute(r: RouteRec): Ev[] {
    return r.handler ? this.trace(r.handler, 'server', undefined, r.range) : [];
  }

  traceValue(v: Value, scope: Unit, where: Where): Ev[] {
    const ctx: Ctx = { where, caught: false, depth: 0, stack: new Set(), bind: new Map(), budget: { left: 400 } };
    if (v.k === 'call') return this.site(v.call, this.g.unit(v.call.unit) ?? scope, ctx);
    if (v.k === 'member' || v.k === 'ident') {
      const special = this.hookMethod(v, scope, ctx);
      if (special) return special;
    }
    const unit = this.g.handlerUnit(v, scope);
    if (!unit) return [];
    const inner = this.walk(unit, ctx);
    return inner.some(isEffect) ? [{ t: 'enter', unit, where }, ...inner] : [];
  }

  private hookMethod(v: Value, scope: Unit, ctx: Ctx): Ev[] | null {
    if (v.k !== 'member' || v.chain.length !== 2 || !/^(mutate|mutateAsync|trigger|refetch)$/.test(v.chain[1])) return null;
    const fn = this.mutationFn(v.chain[0], scope);
    return fn ? this.walk(fn, ctx) : null;
  }

  private mutationFn(local: string, scope: Unit): Unit | null {
    let cur: Unit | undefined = scope;
    while (cur) {
      const v = cur.locals.get(local);
      if (v?.k === 'call') {
        const name = chainOf(v.call).pop() ?? '';
        if (/^(useMutation|useSWRMutation)$/.test(name)) {
          const a = argsOf(v.call);
          const opt = a.find((x) => x.k === 'obj');
          const target = opt?.k === 'obj' ? opt.props.mutationFn : a[a.length - 1];
          if (target) return this.g.handlerUnit(target, cur);
        }
      }
      cur = this.g.parentOf(cur);
    }
    return null;
  }

  private walk(unit: Unit, ctx: Ctx): Ev[] {
    if (ctx.stack.has(unit.id) || ctx.depth > 14 || ctx.budget.left <= 0) return [];
    ctx.budget.left--;
    const mod = this.g.modules.get(unit.file);
    const where: Where = unit.directive === 'use server' || mod?.directive === 'use server' ? 'server' : ctx.where;
    const inner: Ctx = { ...ctx, where, depth: ctx.depth + 1, stack: new Set(ctx.stack).add(unit.id), range: undefined };
    const range = ctx.range;

    const items: Array<{ line: number; site?: CallSite; fn?: string }> = [
      ...unit.calls.map((site) => ({ line: site.line, site })),
      ...unit.inline.map((fn) => ({ line: this.g.unit(fn)?.line ?? unit.line, fn })),
    ].filter((i) => !range || (i.line >= range[0] && i.line <= range[1])).sort((a, b) => a.line - b.line);

    const out: Ev[] = [];
    for (const item of items) {
      if (item.site) out.push(...this.site(item.site, unit, inner));
      else if (item.fn) {
        const f = this.g.unit(item.fn);
        if (f) out.push(...this.walk(f, inner));
      }
    }
    return out;
  }

  /** What one call site amounts to. */
  private site(site: CallSite, unit: Unit, ctx: Ctx): Ev[] {
    const chain = chainOf(site);
    const last = chain[chain.length - 1];
    const name = chain.join('.');
    const args = argsOf(site);
    const caught = ctx.caught || site.inTry || chain.includes('catch');
    const where = ctx.where;

    // Network calls written by hand.
    if ((name === 'fetch' || name === 'window.fetch' || name === 'globalThis.fetch' || name === '$fetch' || name === 'useFetch' || name.startsWith('fetch.') || (chain[0] === 'fetch' && chain.length > 1)) && !this.shadowed(unit, 'fetch')) {
      const opts = this.bound(site.parts[0].args?.[1] ?? args[1], ctx);
      return [this.http(site.parts[0].args?.[0] ?? args[0], opts, unit, site, ctx, caught)];
    }
    if (/(^|\.)(useSWR|useSWRImmutable)$/.test(name)) {
      if (literal(args[0]) !== null) return [this.http(args[0], undefined, unit, site, ctx, caught)];
      return [];
    }
    if (/(^|\.)(useQuery|useSuspenseQuery|useInfiniteQuery)$/.test(name)) {
      const opt = args.find((a) => a.k === 'obj');
      const fnValue = opt?.k === 'obj' ? opt.props.queryFn : args[1];
      if (fnValue) {
        const f = this.g.handlerUnit(fnValue, unit);
        if (f) return this.walk(f, ctx);
      }
      return [];
    }
    if (/^(useChat|useCompletion)$/.test(last)) {
      const ref = this.g.member([chain[0]], unit, 0);
      if (ref?.t === 'ext') {
        const opt = args.find((a) => a.k === 'obj');
        const api = opt?.k === 'obj' ? opt.props.api : undefined;
        const fallback: Value = { k: 'str', v: last === 'useChat' ? '/api/chat' : '/api/completion' };
        return [this.http(api ?? fallback, { k: 'obj', props: { method: { k: 'str', v: 'POST' } } }, unit, site, ctx, caught)];
      }
    }
    if (chain.length === 2 && /^(mutate|mutateAsync|trigger)$/.test(last)) {
      const fn = this.mutationFn(chain[0], unit);
      if (fn) return this.walk(fn, ctx);
    }

    const rootRef = this.g.member([chain[0]], unit, 0);
    const full = chain.length > 1 ? this.g.member(chain, unit, 0) : rootRef;

    // helper('/x').json() or getClient().from('t'): the first link is a real call to our own code.
    if (chain.length > 1 && site.parts[0].args && rootRef?.t === 'unit') {
      const head: CallSite = { ...site, parts: [site.parts[0]] };
      const events = this.site(head, unit, ctx);
      const made = this.g.evalCall(head, unit, 0);
      if (made?.t === 'svc') events.push(...this.serviceCall(made.entry, made.pkg, made.target, site, unit, ctx, caught, false));
      return events;
    }

    // A function handed in as an argument: follow it.
    if (rootRef?.t === 'param' && ctx.bind.has(chain[0]) && ctx.bindScope) {
      const bound = ctx.bind.get(chain[0])!;
      const target = this.g.handlerUnit(bound, ctx.bindScope);
      if (target) return this.walk(target, { ...ctx, caught });
    }

    // fetch handed in as a parameter, a common way to make code testable.
    if (chain.length === 1 && rootRef?.t === 'param' && (rootRef.type === 'typeof fetch' || /^fetch$/i.test(rootRef.type ?? '') || rootRef.unit.paramTypes.get(chain[0]) === 'typeof fetch')) {
      return [this.http(args[0], this.bound(args[1], ctx), unit, site, ctx, caught)];
    }

    // Instances of HTTP clients, such as axios.create().
    const httpExt = rootRef?.t === 'ext' && /^(axios|ky|got|node-fetch|undici|superagent|requests|httpx|aiohttp)/.test(rootRef.pkg);
    if (httpExt || rootRef?.t === 'instance') {
      if (rootRef?.t === 'instance' && !/^(axios|ky|got|httpx|requests)/.test(rootRef.pkg)) return [];
      if (/^(get|post|put|patch|delete|head)$/.test(last)) {
        const opts: Value = { k: 'obj', props: { method: { k: 'str', v: last.toUpperCase() } } };
        return [this.http(args[0], opts, unit, site, ctx, caught)];
      }
      if (chain.length === 1) return [this.http(args[0], args[1], unit, site, ctx, caught)];
      if (last === 'create' || last === 'extend' || last === 'interceptors') return [];
    }

    // Supabase functions are invoked by name.
    if (chain.includes('functions') && last === 'invoke' && rootRef?.t === 'svc' && literal(args[0])) {
      return [this.http({ k: 'str', v: `/functions/v1/${literal(args[0])}` }, { k: 'obj', props: { method: { k: 'str', v: 'POST' } } }, unit, site, ctx, caught)];
    }

    // Node's own powers.
    if (rootRef?.t === 'ext' && rootRef.pkg.startsWith('node:')) {
      const sys = systemEffect(rootRef.pkg, last);
      if (sys) return [{ t: 'system', what: sys.what, access: sys.access, site, unit, where, caught }];
      return [];
    }

    // Services.
    const svc = (rootRef?.t === 'svc' ? rootRef : full?.t === 'svc' ? full : null) as Extract<Ref, { t: 'svc' }> | null;
    if (svc) return this.serviceCall(svc.entry, svc.pkg, svc.target, site, unit, ctx, caught, false);
    const ext = full?.t === 'ext' ? full : rootRef?.t === 'ext' ? rootRef : null;
    if (ext) {
      const authLib = AUTH_LIBS.test(ext.pkg) && AUTH_NAMES.test(last);
      if (authLib || (ext.pkg === 'jsonwebtoken' && last === 'verify') || (ext.pkg === 'jose' && last === 'jwtVerify')) {
        return [{ t: 'auth', how: name, site, unit, enforced: this.isGuarded(site, unit) || ENFORCING.test(last), where }];
      }
      const entry = catalogFor(ext.pkg);
      if (entry?.id === 'zod' || entry?.kind === 'validation') {
        if (/^(parse|safeParse|parseAsync|safeParseAsync|validate|validateAsync|assert)$/.test(last)) return [{ t: 'validate', how: entry.name, site, unit, where }];
        return [];
      }
      if (entry?.service) return this.serviceCall(entry, ext.pkg, undefined, site, unit, ctx, caught, true);
      return [];
    }

    // Rate limit packages.
    if (ext0(rootRef, full) && /ratelimit|rate-limit|rate-limiter/i.test(ext0(rootRef, full)!)) {
      return [{ t: 'limit', how: name, site, unit, where }];
    }

    // Our own functions.
    if (full?.t === 'unit') {
      const target = full.unit;
      if (LIMIT_NAMES.test(target.name.split('.').pop() ?? '')) return [{ t: 'limit', how: `${target.name}()`, site, unit, where }];
      if (/^(parse|safeParse|parseAsync|safeParseAsync)$/.test(target.name)) return [];
      if (/^(validate|sanitize|sanitise|parse[A-Z].*(Body|Input|Request|Payload)|check[A-Z].*(Input|Body))/.test(target.name.split('.').pop() ?? '')) {
        return [{ t: 'validate', how: `${target.name}()`, site, unit, where }];
      }
      const authName = AUTH_NAMES.test(target.name.split('.').pop() ?? '');
      const bind = this.bindArgs(target, site, ctx);
      const inner = this.walk(target, { ...ctx, caught, bind, bindScope: unit });
      if (authName) {
        const hasGuard = target.guards.length > 0 || ENFORCING.test(target.name);
        const ev: Ev = { t: 'auth', how: name, site, unit, enforced: hasGuard || this.isGuarded(site, unit), where: ctx.where };
        const rest = inner.filter((e) => e.t !== 'auth');
        return [ev, ...rest];
      }
      const interesting = inner.some((e) => e.t !== 'enter');
      return interesting ? [{ t: 'enter', unit: target, site, where: ctx.where }, ...inner] : [];
    }

    // Validation on a schema object in this file.
    if (/^(parse|safeParse|parseAsync|safeParseAsync)$/.test(last) && chain.length >= 2 && /schema|validator|body|input|payload/i.test(chain[chain.length - 2])) {
      return [{ t: 'validate', how: chain.slice(0, -1).join('.'), site, unit, where }];
    }

    if (LIMIT_NAMES.test(last) && last !== 'limit') return [{ t: 'limit', how: name, site, unit, where }];

    // A name we could not resolve but that says what it is.
    if (chain.length === 1 && AUTH_NAMES.test(last) && last !== 'auth') {
      return [{ t: 'auth', how: last, site, unit, enforced: this.isGuarded(site, unit) || ENFORCING.test(last), where }];
    }
    return [];
  }

  private serviceCall(entry: CatalogEntry, pkg: string, target: string | undefined, site: CallSite, unit: Unit, ctx: Ctx, caught: boolean, direct: boolean): Ev[] {
    const chain = chainOf(site);
    const last = chain[chain.length - 1];
    const where = ctx.where;
    const names = chain.slice(1);
    if (direct && /^(create|new|init|setup|configure|get.*Client|drizzle|connect)/i.test(last) && !/^(createChatCompletion|createCompletion|createMessage)$/.test(last) && chain.length === 1) return [];
    if (site.isNew) return [];

    // Log-in checks on a service: supabase.auth.getUser(), clerk's auth().
    if (chain.includes('auth') || entry.kind === 'auth') {
      if (/^(getUser|getSession|getClaims|auth|currentUser|getToken|verifyIdToken|getServerSession)$/.test(last)) {
        return [{ t: 'auth', how: chain.join('.'), site, unit, enforced: this.isGuarded(site, unit), where }];
      }
      if (/^(signIn|signInWithPassword|signUp|signOut|signInWithOAuth|signInWithOtp|resetPasswordForEmail|updateUser)$/.test(last)) {
        return [{ t: 'svc', entry, access: 'write', label: `${last.replace(/([A-Z])/g, ' $1').toLowerCase()}`, site, unit, where, caught }];
      }
    }

    if (entry.id === 'vercel-ai' && !/^(generate|stream|embed)/.test(last)) return [];
    if (entry.kind === 'ai') {
      if (direct && !/^(generate|stream|embed|chat|create)/.test(last)) return [];
      if (!direct && !/(create|generate|stream|send|invoke|run|complete|chat|parse|embed|predict|call)/i.test(last)) return [];
      const opt = argsOf(site).find((a) => a.k === 'obj');
      let model: string | undefined;
      let real = entry;
      if (opt?.k === 'obj') {
        const m = opt.props.model;
        model = literal(m) ?? undefined;
        if (m?.k === 'call') {
          model = literal(argsOf(m.call)[0]) ?? undefined;
          const r = this.g.member([chainOf(m.call)[0]], this.g.unit(m.call.unit) ?? unit, 0);
          const e = r?.t === 'ext' ? catalogFor(r.pkg) : r?.t === 'svc' ? r.entry : null;
          if (e && e.kind === 'ai') real = e;
        }
      }
      return [{ t: 'svc', entry: real, access: 'call', label: chain.join('.'), model, site, unit, where, caught }];
    }

    if (entry.kind === 'monitoring' || entry.kind === 'analytics') {
      if (!/^(capture|captureException|captureMessage|track|identify|event|init)$/.test(last)) return [];
      return [{ t: 'svc', entry, access: 'call', label: chain.join('.'), site, unit, where, caught }];
    }

    const hasWrite = names.some((n) => WRITE.test(n)) || (chain.length === 1 && WRITE.test(last));
    const hasRead = names.some((n) => READ.test(n)) || (chain.length === 1 && READ.test(last));
    if (entry.kind === 'database') {
      const db = this.dbOp(entry, chain, site, unit, target);
      if (!db) return [];
      return [{ t: 'svc', entry, access: db.access, label: chain.join('.'), target: db.target, site, unit, where, caught }];
    }
    if (/^(then|catch|finally|toString|map|filter)$/.test(last) && !names.some((n) => WRITE.test(n) || READ.test(n))) return [];
    if (!hasWrite && !hasRead && names.length < 1 && !direct) return [];
    return [{ t: 'svc', entry, access: hasWrite ? 'write' : hasRead ? 'read' : 'call', label: chain.join('.'), target, site, unit, where, caught }];
  }

  private dbOp(entry: CatalogEntry, chain: string[], site: CallSite, unit: Unit, target: string | undefined): { access: 'read' | 'write'; target?: string } | null {
    const all = site.parts;
    const firstArg = (name: string): Value | undefined => all.find((p) => p.name === name)?.args?.[0];
    // Raw SQL anywhere in the chain.
    for (const p of all) {
      for (const a of p.args ?? []) {
        const text = literal(a);
        if (text && /^\s*(select|insert|update|delete|with)\b/i.test(text)) {
          const verb = text.trim().split(/\s+/)[0].toLowerCase();
          const t = text.match(/\b(?:from|into|update)\s+["'`]?([a-zA-Z_][\w.]*)/i)?.[1];
          return { access: verb === 'select' || verb === 'with' ? 'read' : 'write', target: t };
        }
      }
    }
    const names = chain.slice(1);
    const write = names.find((n) => WRITE.test(n));
    const read = names.find((n) => READ.test(n));
    if (!write && !read) return null;
    let t = target;
    const from = firstArg('from') ?? firstArg('table') ?? firstArg('collection') ?? firstArg('model');
    if (from) t = literal(from) ?? nameOf(from) ?? t;
    if (!t && write) {
      const w = firstArg(write);
      if (w) t = nameOf(w) ?? undefined;
    }
    if (!t && entry.id === 'prisma' && chain.length >= 3) t = chain[1];
    if (!t && chain[1] === 'query' && chain.length >= 4) t = chain[2];
    if (!t && /^[A-Z]/.test(chain[0])) t = chain[0];
    if (entry.id === 'firebase') {
      for (const p of all) {
        for (const a of p.args ?? []) {
          if (a.k === 'call' && /^(collection|doc)$/.test(chainOf(a.call).pop() ?? '')) {
            const lit = argsOf(a.call).map(literal).find(Boolean);
            if (lit) t = lit;
          }
        }
      }
    }
    void unit;
    return { access: write ? 'write' : 'read', target: t };
  }

  private shadowed(unit: Unit, name: string): boolean {
    const ref = this.g.lookup(unit, name);
    return !!ref && ref.t !== 'ext' && ref.t !== 'param';
  }

  private bound(v: Value | undefined, ctx: Ctx): Value | undefined {
    if (v?.k === 'ident' && ctx.bind.has(v.name)) return ctx.bind.get(v.name);
    return v;
  }

  private bindArgs(target: Unit, site: CallSite, ctx: Ctx): Map<string, Value> {
    const bind = new Map<string, Value>();
    const args = argsOf(site);
    target.params.forEach((p, i) => {
      const a = args[i];
      if (!a) return;
      const bound = a.k === 'ident' ? ctx.bind.get(a.name) : undefined;
      bind.set(p, bound ?? a);
    });
    return bind;
  }

  private urlOf(v: Value | undefined, unit: Unit, ctx: Ctx): string | null {
    if (!v) return null;
    if (v.k === 'str') return v.v;
    if (v.k === 'tpl') {
      const param = v.idents.find((i) => ctx.bind.has(i));
      if (param) {
        const lit = this.urlOf(ctx.bind.get(param), unit, { ...ctx, bind: new Map() });
        if (lit !== null) {
          // `${BASE}/x/${path}` keeps the static part.
          const staticPart = v.v.replace(/:p/g, '');
          return staticPart && !lit.startsWith(staticPart) ? `${staticPart.replace(/\/$/, '')}/${lit.replace(/^\//, '')}` : lit;
        }
      }
      return v.v;
    }
    if (v.k === 'ident') {
      if (ctx.bind.has(v.name)) return this.urlOf(ctx.bind.get(v.name), unit, { ...ctx, bind: new Map() });
      const ref = this.g.lookup(unit, v.name);
      if (ref?.t === 'val') return literal(ref.value);
    }
    if (v.k === 'member') {
      const ref = this.g.member(v.chain, unit, 0);
      if (ref?.t === 'val') return literal(ref.value);
    }
    if (v.k === 'call' && chainOf(v.call).join('.') === 'URL') return literal(argsOf(v.call)[0]);
    return null;
  }

  private http(urlV: Value | undefined, optsV: Value | undefined, unit: Unit, site: CallSite, ctx: Ctx, caught: boolean): Ev {
    const raw = this.urlOf(urlV, unit, ctx);
    const method = (optsV?.k === 'obj' ? literal(optsV.props.method) : null)?.toUpperCase() ?? 'GET';
    const where = ctx.where;
    if (raw === null) return { t: 'http', method, url: '(built at runtime)', site, unit, where, caught };
    const n = normalizeUrl(raw);
    if (!n) return { t: 'http', method, url: raw.includes(':p') ? '(built at runtime)' : raw, site, unit, where, caught };
    if (n.host) {
      const entry = serviceForHost(n.host);
      if (entry?.kind === 'ai') return { t: 'svc', entry, access: 'call', label: `${method} ${n.host}${n.path}`, site, unit, where, caught };
      return { t: 'http', method, url: `${n.host}${n.path}`, site, unit, where, caught, external: { host: n.host, entry } };
    }
    const route = this.findRoute(method, n.path);
    if (!route && raw.startsWith(':p')) {
      const mod = this.g.modules.get(unit.file);
      for (const e of mod?.env ?? []) {
        const entry = serviceForEnv(e.name);
        if (entry) return { t: 'svc', entry, access: entry.kind === 'ai' ? 'call' : method === 'GET' ? 'read' : 'write', label: `${method} ${n.path}`, site, unit, where, caught };
      }
    }
    return { t: 'http', method, url: n.path, site, unit, route, where, caught };
  }

  /** Is the value of this call used in an if-then-exit? */
  private isGuarded(site: CallSite, unit: Unit): boolean {
    const names = new Set<string>();
    for (const [name, v] of unit.locals) {
      if (holdsCall(v, site)) names.add(name);
    }
    if (!names.size) return false;
    const derived = new Set(names);
    for (const [name, v] of unit.locals) {
      if (v.k === 'member' && names.has(v.chain[0])) derived.add(name);
    }
    return unit.guards.some((g) => g.idents.some((i) => derived.has(i)));
  }
}

function ext0(a: Ref | null, b: Ref | null): string | null {
  if (b?.t === 'ext') return b.pkg;
  if (a?.t === 'ext') return a.pkg;
  return null;
}

function holdsCall(v: Value, site: CallSite): boolean {
  if (v.k === 'call') return v.call === site;
  if (v.k === 'pick') return holdsCall(v.from, site);
  return false;
}

function nameOf(v: Value): string | null {
  if (v.k === 'ident') return v.name;
  if (v.k === 'member') return v.chain[v.chain.length - 1];
  return null;
}

function systemEffect(pkg: string, last: string): { what: string; access: 'read' | 'write' | 'call' } | null {
  if (pkg === 'node:child_process') {
    if (/^(exec|execSync|spawn|spawnSync|fork|execFile|execFileSync)$/.test(last)) return { what: 'runs a program on the machine', access: 'call' };
    return null;
  }
  if (pkg === 'node:fs' || pkg === 'node:fs/promises') {
    if (/^(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|rm|rmSync|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|createWriteStream)$/.test(last)) return { what: 'writes to a file on disk', access: 'write' };
    if (/^(readFile|readFileSync|readdir|readdirSync|createReadStream)$/.test(last)) return { what: 'reads a file from disk', access: 'read' };
  }
  return null;
}

export function genericService(host: string): CatalogEntry {
  return { id: `host:${host}`, name: host, kind: 'other', match: [], plain: 'An outside server your code calls directly. I found the address but do not know this service, so check what you send it.', service: true };
}

export { catalogById };
