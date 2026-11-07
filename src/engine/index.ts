import { catalogFor, serviceForEnv } from './catalog';
import type { CatalogEntry } from './catalog';
import { findTables, linkTables } from './data';
import { findRisks, isPublicEnv, looksSecret } from './risks';
import { isGenerated, JS_EXT, languageOf, parseLooseJson, PY_EXT, roleOf, SFC_EXT, Sources } from './files';
import { buildJourneys, findMiddleware, routeFacts } from './flows';
import { Graph } from './graph';
import type { Module } from './model';
import { extractScript, parseJs } from './parseJs';
import { buildQuestions } from './quiz';
import { describeProject, summarise } from './summary';
import { findRoutes, findScreens } from './surfaces';
import { genericService, isEffect, Tracer } from './trace';
import type { Ev } from './trace';
import type { Coverage, EnvVar, Evidence, FileFact, Gap, Operation, Report, Route, Screen, Service, ServiceKind, Tech, VirtualFile } from './types';

export interface AnalyseOptions {
  name?: string;
  /** Every path in the project, including ones that were not read. */
  allPaths?: string[];
  /** Paths git tracks, when known. */
  tracked?: string[];
  github?: Report['project']['github'];
  /** Parser for Python, injected so the browser can lazy-load its WASM. */
  parsePython?: (file: string, source: string) => Module;
  now?: () => number;
}

export function analyse(input: VirtualFile[], opts: AnalyseOptions = {}): Report {
  const now = opts.now ?? (() => Date.now());
  const started = now();
  const files = new Map(input.map((f) => [f.path, f]));
  const src = new Sources(files);
  const g = new Graph(files);
  const gaps: Gap[] = [];
  const skippedLangs = new Map<string, number>();

  for (const f of input) {
    if (isGenerated(f)) continue;
    let mod: Module | undefined;
    if (JS_EXT.test(f.path)) mod = parseJs(f.path, f.content);
    else if (SFC_EXT.test(f.path)) mod = parseJs(f.path, extractScript(f.content));
    else if (PY_EXT.test(f.path) && opts.parsePython) {
      try {
        mod = opts.parsePython(f.path, f.content);
      } catch {
        gaps.push({ kind: 'parse-error', text: `I could not read ${f.path}.` });
      }
    }
    if (!mod) {
      const lang = languageOf(f.path);
      if (['Go', 'Rust', 'Ruby', 'PHP', 'Java', 'Kotlin', 'Swift', 'C#', 'C++', 'C', 'Dart', 'Arduino'].includes(lang)) {
        skippedLangs.set(lang, (skippedLangs.get(lang) ?? 0) + 1);
      }
      continue;
    }
    if (mod.parseError) gaps.push({ kind: 'parse-error', text: `I could not parse ${f.path}, so anything inside it is missing from this report.` });
    g.add(mod);
  }
  g.link();

  const routeRecs = findRoutes(g, gaps, src);
  const screenRecs = findScreens(g);
  const tr = new Tracer(g, routeRecs);
  const middleware = findMiddleware(g, tr);
  const { journeys } = buildJourneys(g, tr, screenRecs, routeRecs, src);

  // Every event from every starting point feeds the service inventory.
  const facts = new Map(routeRecs.map((r) => [r.id, routeFacts(r, tr, middleware, src)]));
  const serviceMap = new Map<string, Service>();
  const ensureService = (entry: CatalogEntry): Service => {
    let s = serviceMap.get(entry.id);
    if (!s) {
      s = { id: entry.id, name: entry.name, kind: entry.kind as ServiceKind, plain: entry.plain, from: [], operations: [], screens: [], routes: [], envVars: [] };
      serviceMap.set(entry.id, s);
    }
    return s;
  };
  const opKeys = new Set<string>();
  const addOp = (s: Service, op: Operation): void => {
    if (!s.from.includes(op.from)) s.from.push(op.from);
    const key = `${op.evidence.file}:${op.evidence.line}:${op.label}`;
    if (opKeys.has(key) || s.operations.length >= 60) return;
    opKeys.add(key);
    s.operations.push(op);
  };
  const feed = (ev: Ev): void => {
    if (ev.t === 'svc') {
      const s = ensureService(ev.entry);
      addOp(s, { label: ev.label, access: ev.access, target: ev.target, from: ev.where, evidence: src.evidence(ev.unit.file, ev.site.line, ev.site.endLine) });
    } else if (ev.t === 'http' && ev.external) {
      const entry = ev.external.entry ?? genericService(ev.external.host);
      const s = ensureService(entry);
      s.host = ev.external.host;
      addOp(s, { label: `${ev.method} ${ev.url}`, access: ev.method === 'GET' ? 'read' : 'write', from: ev.where, evidence: src.evidence(ev.unit.file, ev.site.line, ev.site.endLine) });
    }
  };
  for (const f of facts.values()) f.events.forEach(feed);
  // Also walk screens: browser-side effects live here.
  for (const screen of screenRecs) {
    if (!screen.entry) continue;
    tr.trace(screen.entry, screen.render === 'server' ? 'server' : 'browser').forEach(feed);
  }
  for (const mod of g.modules.values()) {
    for (const u of mod.units.values()) {
      for (const t of u.triggers) tr.traceValue(t.handler, u, 'browser').forEach(feed);
    }
  }

  const stack = buildStack(g, src);
  const env = buildEnv(g, src, browserFiles(g, screenRecs));
  for (const e of env) {
    const entry = serviceForEnv(e.name);
    if (!entry) continue;
    const s = serviceMap.get(entry.id);
    if (s && !s.envVars.includes(e.name)) s.envVars.push(e.name);
  }
  // A service declared but not traced is still worth showing on the map, flagged by having no operations.
  for (const t of stack) {
    if (!t.runtime || t.ghost || serviceMap.has(t.id)) continue;
    const entry = catalogFor(t.packages[0]);
    if (entry?.service) ensureService(entry);
  }

  const routeById = new Map<string, Route>();
  const routes: Route[] = routeRecs.map((r) => {
    const f = facts.get(r.id)!;
    const route: Route = {
      id: r.id, method: r.method, path: r.path, file: r.file, kind: r.kind, handler: r.handler?.name,
      evidence: src.evidence(r.file, r.line, r.handler ? Math.min(r.handler.endLine, r.line + 14) : r.line),
      framework: r.framework, auth: f.auth, validates: f.validates, writes: f.writes, limited: f.limited, services: f.services,
      calledBy: [], certainty: r.certainty, app: appOf(g, r.file),
    };
    routeById.set(r.id, route);
    return route;
  });
  const screens: Screen[] = screenRecs.map((s) => ({
    id: s.id, path: s.path, file: s.file, name: s.name, render: s.render, framework: s.framework,
    evidence: src.evidence(s.file, s.entry?.line ?? 1, s.entry ? Math.min(s.entry.endLine, s.entry.line + 8) : 1), app: appOf(g, s.file),
  }));

  for (const j of journeys) {
    for (const rid of j.routeIds) {
      const r = routeById.get(rid);
      if (r && j.screen && !r.calledBy.includes(j.screen)) r.calledBy.push(j.screen);
    }
    for (const sid of j.serviceIds) {
      const s = serviceMap.get(sid);
      if (!s) continue;
      if (j.screen && !s.screens.includes(j.screen)) s.screens.push(j.screen);
    }
  }
  for (const r of routes) {
    for (const sid of r.services) {
      const s = serviceMap.get(sid);
      if (!s) continue;
      if (!s.routes.includes(r.id)) s.routes.push(r.id);
      for (const screen of r.calledBy) if (!s.screens.includes(screen)) s.screens.push(screen);
    }
  }
  const services = [...serviceMap.values()].sort((a, b) => b.routes.length + b.screens.length - (a.routes.length + a.screens.length));

  const tables = findTables(g, src);
  linkTables(tables, services);

  const fileFacts = buildFiles(g, input, screens, routes, opts.allPaths);

  const allPaths = opts.allPaths ?? input.map((f) => f.path);
  const risks = findRisks({
    g, src, routes, services, journeys, tables, stack, env, allPaths, files: input,
    tracked: opts.tracked ? new Set(opts.tracked) : undefined,
  });

  const questions = buildQuestions({ screens, routes, services, journeys, risks, stack, files: fileFacts, envNames: env.map((e) => e.name) });

  // Gaps the reader should see.
  for (const mod of g.modules.values()) {
    for (const d of mod.dynamicImports) {
      if (d.source === null && gaps.length < 60) gaps.push({ kind: 'dynamic-import', text: `${mod.file} loads a file chosen while the app runs. I cannot follow that.`, evidence: src.evidence(mod.file, d.line) });
    }
    for (const im of mod.imports) {
      const r = g.resolve(mod.file, im.source);
      if (r.kind === 'missing' && gaps.length < 60) gaps.push({ kind: 'unresolved-import', text: `${mod.file} imports ${im.source}, which I could not find.`, evidence: src.evidence(mod.file, im.line) });
    }
  }
  for (const [lang, count] of skippedLangs) {
    gaps.push({ kind: 'language', text: `${count} ${lang} file${count === 1 ? ' is' : 's are'} listed but not traced. I can only follow JavaScript, TypeScript and Python.` });
  }
  for (const j of journeys) {
    for (const s of j.steps) {
      if (s.kind === 'gap' && gaps.length < 80) gaps.push({ kind: 'unmatched-call', text: s.title, evidence: s.evidence });
    }
  }

  const coverage = buildCoverage(input, g, skippedLangs, now() - started);
  const project = describeProject(g, src, opts, screens, routes, input);
  const partial = { project, stack, screens, routes, services, journeys, risks, tables, env, gaps, coverage, files: fileFacts };

  return {
    schema: 1,
    generatedAt: new Date(now()).toISOString(),
    ...partial,
    questions,
    summary: summarise(partial),
  };
}

function appOf(g: Graph, file: string): string | undefined {
  const m = g.manifestFor(file);
  return m && m.dir ? m.dir : undefined;
}

function buildStack(g: Graph, src: Sources): Tech[] {
  const usage = new Map<string, Set<string>>();
  const firstUse = new Map<string, Evidence>();
  for (const mod of g.modules.values()) {
    for (const im of mod.imports) {
      if (im.typeOnly) continue;
      const r = g.resolve(mod.file, im.source);
      if (r.kind !== 'package') continue;
      const set = usage.get(r.name) ?? new Set();
      set.add(mod.file);
      usage.set(r.name, set);
      if (!firstUse.has(r.name)) firstUse.set(r.name, src.evidence(mod.file, im.line, im.line, 0));
    }
  }
  const scriptsText = g.manifests.map((m) => Object.values(m.scripts).join(' ')).join(' ');
  const configText = [...g.files.entries()].filter(([p]) => /\.config\.|rc\.|tsconfig|\.json$/.test(p) && !/package\.json$/.test(p)).map(([, f]) => f.content.slice(0, 4000)).join('\n');

  const techs = new Map<string, Tech>();
  const fromManifest = (pkg: string, ev: Evidence, dev: boolean): void => {
    const entry = catalogFor(pkg);
    const id = entry?.id ?? `pkg:${pkg}`;
    const uses = usage.get(pkg)?.size ?? 0;
    const existing = techs.get(id);
    const inScripts = scriptsText.includes(pkg) || scriptsText.includes(pkg.split('/').pop() ?? pkg);
    const inConfig = configText.includes(pkg);
    if (existing) {
      if (!existing.packages.includes(pkg)) existing.packages.push(pkg);
      existing.importedBy += uses;
      existing.ghost = existing.ghost && uses === 0 && !inScripts && !inConfig;
      existing.devOnly = existing.devOnly && dev;
      if (firstUse.get(pkg) && existing.evidence.length < 3) existing.evidence.push(firstUse.get(pkg)!);
      return;
    }
    techs.set(id, {
      id, name: entry?.name ?? pkg, kind: entry?.kind ?? 'library', plain: entry?.plain ?? '', analogy: entry?.analogy,
      packages: [pkg], importedBy: uses, ghost: uses === 0 && !inScripts && !inConfig && !isImplicit(pkg),
      runtime: !!entry?.service && !dev, evidence: [ev, ...(firstUse.get(pkg) ? [firstUse.get(pkg)!] : [])], devOnly: dev,
    });
  };

  for (const m of g.manifests) {
    const lineOf = (pkg: string): number => {
      const i = m.rawLines.findIndex((l) => l.includes(`"${pkg}"`));
      return i === -1 ? 1 : i + 1;
    };
    for (const pkg of Object.keys(m.deps)) fromManifest(pkg, src.evidence(m.file, lineOf(pkg), lineOf(pkg), 0), false);
    for (const pkg of Object.keys(m.devDeps)) fromManifest(pkg, src.evidence(m.file, lineOf(pkg), lineOf(pkg), 0), true);
  }
  // Python manifests.
  for (const [path, f] of g.files) {
    if (/(^|\/)requirements[^/]*\.txt$/.test(path)) {
      f.content.split('\n').forEach((raw, i) => {
        const pkg = raw.split('#')[0].trim().split(/[=<>~!\[; ]/)[0];
        if (pkg && !pkg.startsWith('-')) fromManifest(pkg, src.evidence(path, i + 1, i + 1, 0), false);
      });
    }
    if (/(^|\/)pyproject\.toml$/.test(path)) {
      const block = f.content.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
      if (block) {
        for (const m of block[1].matchAll(/["']([A-Za-z0-9_.-]+)/g)) {
          const line = f.content.slice(0, f.content.indexOf(m[0])).split('\n').length;
          fromManifest(m[1], src.evidence(path, line, line, 0), false);
        }
      }
    }
  }
  const order = (t: Tech): number => (t.plain ? 0 : 1) * 100 + (t.ghost ? 40 : 0) + (t.devOnly ? 20 : 0) - Math.min(t.importedBy, 19);
  return [...techs.values()].sort((a, b) => order(a) - order(b));
}

function isImplicit(pkg: string): boolean {
  return /^(react-dom|typescript|@types\/|autoprefixer|postcss|tailwindcss|eslint|prettier|next$|vite$|tsx$|@tailwindcss|server-only|client-only|tslib|pg$|sqlite3$|@prisma\/client$|prisma$|uvicorn|gunicorn)/.test(pkg);
}

/** Files that end up in a browser bundle. */
function browserFiles(g: Graph, screens: ReturnType<typeof findScreens>): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const mod of g.modules.values()) if (mod.directive === 'use client') stack.push(mod.file);
  for (const s of screens) if (s.render === 'browser' && s.entry) stack.push(s.entry.file);
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const mod = g.modules.get(f);
    for (const im of mod?.imports ?? []) {
      if (im.typeOnly) continue;
      const r = g.resolve(f, im.source);
      if (r.kind === 'file' && g.modules.get(r.file)?.directive !== 'use server') stack.push(r.file);
    }
  }
  return seen;
}

function buildEnv(g: Graph, src: Sources, browser: Set<string>): EnvVar[] {
  const map = new Map<string, EnvVar>();
  const documented = new Set<string>();
  for (const [p, f] of g.files) {
    if (/\.env\.(example|sample|template)$|\.env\.local\.example$/.test(p)) {
      for (const m of f.content.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]+)\s*=/gm)) documented.add(m[1]);
    }
  }
  for (const mod of g.modules.values()) {
    if (/(^|\/)(tests?|__tests__)\/|\.(test|spec)\./.test(mod.file)) continue;
    for (const e of mod.env) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(e.name) || /^(NODE_ENV|PORT|CI|HOME|PATH|TZ|DEV|PROD|MODE|BASE_URL|SSR)$/.test(e.name)) continue;
      const inBrowser = browser.has(mod.file);
      let v = map.get(e.name);
      if (!v) {
        v = { name: e.name, exposure: isPublicEnv(e.name) ? 'browser' : inBrowser ? 'both' : 'server', reads: [], documented: documented.has(e.name), looksSecret: looksSecret(e.name) };
        map.set(e.name, v);
      }
      if (inBrowser && v.exposure === 'server') v.exposure = 'both';
      if (v.reads.length < 4) v.reads.push(src.evidence(mod.file, e.line, e.line, 1));
    }
  }
  return [...map.values()].sort((a, b) => Number(b.looksSecret) - Number(a.looksSecret) || a.name.localeCompare(b.name));
}

function buildFiles(g: Graph, input: VirtualFile[], screens: Screen[], routes: Route[], _all?: string[]): FileFact[] {
  const screenFiles = new Map(screens.map((s) => [s.file, s]));
  const routeFiles = new Map<string, Route[]>();
  for (const r of routes) routeFiles.set(r.file, [...(routeFiles.get(r.file) ?? []), r]);

  const reachable = reachableFiles(g, screens, routes);
  const out: FileFact[] = [];
  for (const f of input) {
    const mod = g.modules.get(f.path);
    const lines = f.content.split('\n').length;
    const importedBy = g.importers.get(f.path)?.size ?? 0;
    let role = roleOf(f.path);
    const screen = screenFiles.get(f.path);
    const routeList = routeFiles.get(f.path);
    let plain = '';
    if (role === 'test') plain = 'An automated test. It never runs for your users.';
    else if (screen) {
      role = 'screen';
      plain = `The screen people see at ${screen.path}.`;
    } else if (routeList) {
      role = 'route';
      const r = routeList[0];
      plain = r.kind === 'action' ? `Server actions: ${routeList.map((x) => x.path).slice(0, 4).join(', ')}.` : r.kind === 'command' ? `The command ${r.path}.` : `Answers ${routeList.map((x) => (x.method === 'ANY' ? x.path : `${x.method} ${x.path}`)).slice(0, 3).join(', ')} on your server.`;
    } else if (mod) {
      const hasJsx = [...mod.units.values()].some((u) => u.jsx.length > 0);
      if (role === 'other' || role === 'script' || role === 'data') {
        if (role === 'other') role = hasJsx ? 'component' : 'logic';
      }
      plain = hasJsx ? `A piece of interface used by ${importedBy} file${importedBy === 1 ? '' : 's'}.` : importedBy ? `Shared code used by ${importedBy} file${importedBy === 1 ? '' : 's'}.` : 'Code that nothing else imports.';
    } else {
      plain = ({ config: 'Settings for a tool or service.', docs: 'Writing for people.', style: 'How things look.', data: 'Defines the shape of your data.', asset: 'An image or other asset.', script: 'A helper script you run by hand.', other: '' } as Record<string, string>)[role] ?? '';
    }
    const unreached = !!mod && role !== 'test' && role !== 'script' && role !== 'config' && !reachable.has(f.path) && importedBy === 0 && !screen && !routeList;
    out.push({
      path: f.path, role, lines, plain, importedBy,
      imports: mod?.imports.length ?? 0, ownWords: mod?.ownWords,
      exports: mod?.exports.map((e) => e.name).slice(0, 8) ?? [], unreached, language: languageOf(f.path),
    });
  }
  return out;
}

function reachableFiles(g: Graph, screens: Screen[], routes: Route[]): Set<string> {
  const stack = [...screens.map((s) => s.file), ...routes.map((r) => r.file)];
  for (const m of g.manifests) {
    for (const k of ['main', 'module']) if (typeof m.json[k] === 'string') stack.push(m.json[k]);
  }
  const seen = new Set<string>();
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const mod = g.modules.get(f);
    for (const im of [...(mod?.imports ?? []), ...(mod?.dynamicImports ?? [])]) {
      if (!('source' in im) || !im.source) continue;
      const r = g.resolve(f, im.source);
      if (r.kind === 'file') stack.push(r.file);
    }
  }
  return seen;
}

function buildCoverage(input: VirtualFile[], g: Graph, skipped: Map<string, number>, durationMs: number): Coverage {
  const langs = new Map<string, { files: number; lines: number; traced: boolean }>();
  let loc = 0;
  for (const f of input) {
    const name = languageOf(f.path);
    const lines = f.content.split('\n').length;
    const isCode = !['Markdown', 'JSON', 'YAML', 'TOML', 'Other', 'CSS', 'HTML'].includes(name);
    if (isCode) loc += lines;
    const l = langs.get(name) ?? { files: 0, lines: 0, traced: false };
    l.files++;
    l.lines += lines;
    if (g.modules.has(f.path)) l.traced = true;
    langs.set(name, l);
  }
  void skipped;
  return {
    files: input.length, linesOfCode: loc, analysed: g.modules.size,
    languages: [...langs.entries()].filter(([n]) => n !== 'Other').map(([name, v]) => ({ name, files: v.files, lines: v.lines, depth: v.traced ? 'traced' as const : 'listed' as const })).sort((a, b) => b.lines - a.lines).slice(0, 8),
    durationMs,
  };
}

export { parseLooseJson, isEffect };
export type { Report, VirtualFile } from './types';
