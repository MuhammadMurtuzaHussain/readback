import type { Sources } from './files';
import type { Graph } from './graph';
import type { Trigger, Unit } from './model';
import { screenClosure } from './surfaces';
import type { RouteRec, ScreenRec } from './surfaces';
import { genericService, isEffect, Tracer } from './trace';
import type { Ev, Where } from './trace';
import type { AuthState, Journey, Step } from './types';

const short = (file: string): string => file.split('/').slice(-2).join('/');

function fnName(u: Unit): string | null {
  const n = u.name.replace(/@.*$/, '');
  if (n === 'anonymous' || n === 'on load' || /^on[A-Z].* handler$/.test(n)) return null;
  if (n === 'default') return `The main function in ${short(u.file)}`;
  return `${n}() in ${short(u.file)}`;
}

function serviceVerb(e: Extract<Ev, { t: 'svc' }>): string {
  const n = e.entry.name;
  if (e.entry.kind === 'database') {
    const t = e.target ? `the ${e.target} table in ${n}` : n;
    if (e.access === 'read') return `It reads from ${t}.`;
    if (/(^|\.)(delete|deleteOne|deleteMany|remove|destroy|del|deleteDoc|findByIdAndDelete|findOneAndDelete)(\.|$)/.test(e.label)) return `It deletes from ${t}.`;
    if (/(^|\.)(update|updateOne|updateMany|upsert|updateDoc|findOneAndUpdate|findByIdAndUpdate)(\.|$)/.test(e.label)) return `It updates ${t}.`;
    return `It saves to ${t}.`;
  }
  if (e.entry.kind === 'ai' && /^GET /.test(e.label)) return `It checks whether ${n} is reachable.`;
  if (e.entry.kind === 'ai') return `It sends text to ${n}${e.model ? ` (${e.model})` : ''} and waits for the reply.`;
  if (e.entry.kind === 'email') return `It sends an email through ${n}.`;
  if (e.entry.kind === 'payments') return `It talks to ${n} about a payment (${e.label}).`;
  if (e.entry.kind === 'storage') return e.access === 'read' ? `It reads a file from ${n}.` : `It stores a file in ${n}.`;
  if (e.entry.kind === 'messaging') return `It sends a message through ${n}.`;
  if (e.entry.kind === 'monitoring' || e.entry.kind === 'analytics') return `It reports to ${n}.`;
  if (e.entry.kind === 'auth') return `It asks ${n} to ${e.label}.`;
  return `It calls ${n} (${e.label}).`;
}

function serviceNote(e: Extract<Ev, { t: 'svc' }>, where: Where): string | undefined {
  if (e.entry.id === 'ollama') return 'This runs on your own machine, so there is no per-call bill, but that machine has to be on.';
  if (e.entry.kind === 'ai' && !/^GET /.test(e.label)) return 'Each call costs money and can take several seconds. What you send leaves your server.';
  if (e.entry.kind === 'database' && where === 'browser') return 'This runs in the visitor\'s browser, so their browser is talking to your database directly. Access rules are the only protection.';
  if (e.entry.kind === 'database' && e.access === 'write') return 'This is the moment something becomes permanent.';
  return undefined;
}

export function stepsFrom(events: Ev[], src: Sources): Step[] {
  const steps: Step[] = [];
  const ev = (file: string, line: number, end?: number) => src.evidence(file, line, end ?? line);
  for (const e of events) {
    switch (e.t) {
      case 'enter': {
        const nm = fnName(e.unit);
        if (!nm) break;
        steps.push({
          kind: e.where === 'browser' ? 'browser' : 'server',
          title: `${nm} runs ${e.where === 'browser' ? 'in their browser' : 'on your server'}.`,
          where: e.where,
          evidence: ev(e.unit.file, e.unit.line, Math.min(e.unit.endLine, e.unit.line + 12)),
          certainty: 'seen',
        });
        break;
      }
      case 'http': {
        if (e.external) {
          const entry = e.external.entry;
          steps.push({
            kind: 'service',
            title: `It calls ${entry?.name ?? e.external.host} directly (${e.method} ${e.url.length > 60 ? e.external.host : e.url}).`,
            where: 'outside',
            evidence: ev(e.site.unit.split('#')[0], e.site.line, e.site.endLine),
            certainty: 'seen',
            serviceId: entry?.id ?? genericService(e.external.host).id,
          });
        } else if (e.route) {
          if (e.where === 'browser') {
            steps.push({
              kind: 'network',
              title: `The browser sends a ${e.method} request to ${e.route.path}.`,
              note: 'The request crosses the internet here. Anyone can send this same request without using your screen.',
              where: 'browser',
              concept: 'request',
              evidence: ev(e.site.unit.split('#')[0], e.site.line, e.site.endLine),
              certainty: 'seen',
            });
          } else {
            steps.push({ kind: 'network', title: `Your server calls its own address ${e.method} ${e.url}.`, where: 'server', concept: 'request', evidence: ev(e.site.unit.split('#')[0], e.site.line, e.site.endLine), certainty: 'seen' });
          }
          steps.push({
            kind: 'server',
            title: `${e.route.method === 'ANY' ? 'The handler' : `The ${e.route.method} handler`} in ${short(e.route.file)} picks it up on your server.`,
            where: 'server',
            concept: 'api-route',
            evidence: ev(e.route.file, e.route.line, e.route.handler ? Math.min(e.route.handler.endLine, e.route.line + 12) : e.route.line),
            certainty: e.route.certainty,
          });
        } else {
          steps.push({
            kind: 'gap',
            title: e.url === '(built at runtime)'
              ? 'It sends a request to an address built while the app runs, so I cannot tell where it goes.'
              : `It sends a ${e.method} to ${e.url}, but I could not find the code that answers it.`,
            note: 'This could be another service, a dynamic address, or a route that no longer exists.',
            where: e.where,
            evidence: ev(e.site.unit.split('#')[0], e.site.line, e.site.endLine),
            certainty: 'inferred',
          });
        }
        break;
      }
      case 'auth':
        steps.push({
          kind: 'auth',
          title: e.enforced ? `It checks who is asking (${e.how}) and stops if the answer is nobody.` : `It looks up who is asking (${e.how}), but I could not see it stop anyone.`,
          note: e.enforced ? undefined : 'Looking someone up is not the same as refusing them. Check what happens when the answer is empty.',
          where: 'server',
          concept: 'auth',
          evidence: ev(e.unit.file, e.site.line, e.site.endLine),
          certainty: e.enforced ? 'seen' : 'inferred',
        });
        break;
      case 'validate':
        steps.push({
          kind: 'validate',
          title: `It checks the shape of the incoming data with ${e.how}.`,
          where: e.where === 'browser' ? 'browser' : 'server',
          concept: 'validation',
          evidence: ev(e.unit.file, e.site.line, e.site.endLine),
          certainty: 'seen',
        });
        break;
      case 'limit':
        steps.push({ kind: 'validate', title: `It checks a rate limit (${e.how}).`, where: 'server', concept: 'rate-limit', evidence: ev(e.unit.file, e.site.line, e.site.endLine), certainty: 'inferred' });
        break;
      case 'svc':
        steps.push({
          kind: e.entry.kind === 'database' ? 'data' : 'service',
          title: serviceVerb(e),
          note: serviceNote(e, e.where),
          where: e.where === 'browser' ? 'browser' : 'server',
          evidence: ev(e.unit.file, e.site.line, e.site.endLine),
          certainty: 'seen',
          serviceId: e.entry.id,
          concept: e.entry.kind === 'database' && e.where === 'browser' ? 'rls' : undefined,
        });
        break;
      case 'system':
        steps.push({ kind: 'system', title: `It ${e.what}.`, where: e.where, evidence: ev(e.unit.file, e.site.line, e.site.endLine), certainty: 'seen' });
        break;
    }
  }
  return dedupeSteps(steps);
}

const MAX_STEPS = 14;

function dedupeSteps(steps: Step[]): Step[] {
  const titles = new Set<string>();
  const out: Step[] = [];
  for (const s of steps) {
    if (s.kind === 'system' && /reads a file/.test(s.title)) continue;
    if (titles.has(s.title)) continue;
    titles.add(s.title);
    out.push(s);
  }
  // Long chains of helper calls teach nothing: keep the ones next to something that happens.
  const trimmed = out.filter((s, i) => {
    if (s.kind !== 'browser' && s.kind !== 'server') return true;
    if (s.concept === 'api-route') return true;
    const next = out[i + 1];
    if (!next) return false;
    return next.kind !== 'browser' && next.kind !== 'server';
  });
  if (trimmed.length <= MAX_STEPS) return trimmed;
  // Over budget: helpers go first, everything that does something stays.
  const important = trimmed.filter((s) => (s.kind !== 'browser' && s.kind !== 'server') || s.concept === 'api-route');
  const kept = important.slice(0, MAX_STEPS);
  const hidden = trimmed.length - kept.length;
  if (hidden > 0) {
    kept.push({ kind: 'more', title: `${hidden} smaller step${hidden === 1 ? '' : 's'} left out to keep this readable.`, where: kept[kept.length - 1].where, certainty: 'seen' });
  }
  return kept;
}

function triggerTitle(t: Trigger, screen: ScreenRec): { title: string; step: string } {
  const on = screen.path;
  const label = t.label ? `“${t.label}”` : undefined;
  switch (t.event) {
    case 'click':
      return { title: label ? `Someone clicks ${label} on ${on}` : `Someone clicks a button on ${on}`, step: `Someone clicks ${label ?? 'a button'}.` };
    case 'submit':
      return { title: label ? `Someone submits ${label} on ${on}` : `Someone submits a form on ${on}`, step: `Someone submits the form${label ? ` with ${label}` : ''}.` };
    case 'change':
      return { title: `Someone changes ${label ?? 'a field'} on ${on}`, step: `Someone changes ${label ?? 'a field'}.` };
    case 'load':
      return { title: `${on} loads its data`, step: 'The screen appears and asks for its data without anyone clicking.' };
    case 'key':
      return { title: `Someone presses a key on ${on}`, step: 'Someone presses a key.' };
    default:
      return { title: `Someone uses “${t.label ?? t.rawEvent}” on ${on}`, step: `Someone uses “${t.label ?? t.rawEvent}”.` };
  }
}

export function failureOf(events: Ev[], src: Sources, command = false): Journey['failure'] {
  const effects = events.filter(isEffect) as Array<Extract<Ev, { t: 'http' | 'svc' | 'system' }>>;
  const open = effects.filter((e) => !e.caught);
  if (!effects.length) return { caught: true, text: 'Nothing here reaches the outside world.' };
  if (!open.length) return { caught: true, text: 'Every outside call in this path sits inside error handling, so a failure is at least noticed. Whether the person sees a useful message is worth checking.' };
  const e = open[open.length - 1];
  const what = e.t === 'svc' ? e.entry.name : e.t === 'http' ? (e.external?.entry?.name ?? e.url) : 'that step';
  const file = e.unit.file;
  return {
    caught: false,
    text: command
      ? `If ${what} fails here, nothing on this path catches the error, so the command stops with a stack trace.`
      : `If ${what} fails here, nothing on this path catches the error. The person would see a broken screen or a generic error.`,
    evidence: src.evidence(file, e.site.line, e.site.endLine),
  };
}

function signature(events: Ev[]): string {
  return events
    .filter((e) => e.t === 'http' || e.t === 'svc' || e.t === 'system')
    .map((e) => (e.t === 'http' ? `${e.method}${e.url}` : e.t === 'svc' ? `${e.entry.id}:${e.access}:${e.target ?? ''}` : (e as any).what))
    .join('|');
}

function collect(events: Ev[]): { routeIds: string[]; serviceIds: string[]; writes: boolean } {
  const routeIds = new Set<string>();
  const serviceIds = new Set<string>();
  let writes = false;
  for (const e of events) {
    if (e.t === 'http') {
      if (e.route) routeIds.add(e.route.id);
      if (e.external) serviceIds.add(e.external.entry?.id ?? genericService(e.external.host).id);
      if (e.method !== 'GET') writes = true;
    }
    if (e.t === 'svc') {
      serviceIds.add(e.entry.id);
      if (e.access === 'write') writes = true;
    }
  }
  return { routeIds: [...routeIds], serviceIds: [...serviceIds], writes };
}

function score(j: Omit<Journey, 'score'>): number {
  let s = 0;
  if (j.trigger === 'click' || j.trigger === 'submit') s += 30;
  if (j.writes) s += 30;
  if (j.routeIds.length) s += 15;
  s += j.serviceIds.length * 10;
  s += Math.min(j.steps.length, 8) * 2;
  if (j.steps.some((x) => x.kind === 'gap')) s -= 12;
  if (j.trigger === 'load') s -= 8;
  return s;
}

/** Expand matched HTTP events so the journey continues on the server. */
function withServerSide(tr: Tracer, events: Ev[], depth = 0): Ev[] {
  const out: Ev[] = [];
  for (const e of events) {
    out.push(e);
    if (e.t === 'http' && e.route?.handler && depth < 3) {
      out.push(...withServerSide(tr, tr.traceRoute(e.route), depth + 1));
    }
  }
  return out;
}

export function buildJourneys(g: Graph, tr: Tracer, screens: ScreenRec[], routes: RouteRec[], src: Sources): { journeys: Journey[]; reached: Set<string> } {
  const journeys: Journey[] = [];
  const seen = new Set<string>();
  const reached = new Set<string>();

  const push = (j: Omit<Journey, 'score'>, sig: string): void => {
    if (seen.has(sig)) return;
    seen.add(sig);
    journeys.push({ ...j, score: score(j) });
  };

  for (const screen of screens) {
    const closure = screenClosure(g, screen.entry);
    const defaultWhere: Where = 'browser';

    // Server-rendered pages do work before anything reaches the browser.
    if (screen.render === 'server' && screen.entry) {
      const events = withServerSide(tr, tr.trace(screen.entry, 'server'));
      if (events.some(isEffect)) {
        const meta = collect(events);
        const steps: Step[] = [
          { kind: 'trigger', title: `Someone opens ${screen.path}.`, where: 'outside', certainty: 'seen', evidence: src.evidence(screen.file, screen.entry.line, Math.min(screen.entry.endLine, screen.entry.line + 8)) },
          { kind: 'server', title: 'Your server runs this page before sending anything to their browser.', where: 'server', concept: 'server-component', certainty: 'seen' },
          ...stepsFrom(events, src),
        ];
        push({ id: `j${journeys.length}`, title: `Someone opens ${screen.path}`, trigger: 'load', screen: screen.id, ...meta, steps, failure: failureOf(events, src) }, `${screen.id}|load|${signature(events)}`);
        meta.routeIds.forEach((r) => reached.add(r));
      }
    }

    for (const unit of closure) {
      for (const t of unit.triggers) {
        const scope = g.unit(t.unit) ?? unit;
        const raw = tr.traceValue(t.handler, scope, unit.directive === 'use server' ? 'server' : defaultWhere);
        const events = withServerSide(tr, raw);
        if (!events.some(isEffect)) continue;
        const { title, step } = triggerTitle(t, screen);
        const meta = collect(events);
        const steps: Step[] = [
          { kind: 'trigger', title: step, where: 'browser', certainty: 'seen', evidence: src.evidence(unit.file, t.line) },
          ...stepsFrom(events, src),
        ];
        const trigger: Journey['trigger'] = t.event === 'click' ? 'click' : t.event === 'submit' ? 'submit' : t.event === 'load' ? 'load' : 'event';
        const sig = `${screen.path}|${t.event}|${t.label ?? ''}|${signature(events)}`;
        push({ id: `j${journeys.length}`, title, trigger, screen: screen.id, ...meta, steps, failure: failureOf(events, src) }, sig);
        meta.routeIds.forEach((r) => reached.add(r));
      }
    }
  }

  // Doors that are not reached from any screen still deserve a story.
  for (const r of routes) {
    if (reached.has(r.id) || !r.handler) continue;
    const events = withServerSide(tr, tr.traceRoute(r));
    if (!events.some(isEffect) && r.kind !== 'webhook') continue;
    const meta = collect(events);
    const label = r.kind === 'webhook' ? `A webhook arrives at ${r.path}` : r.kind === 'cron' ? `The scheduled job ${r.path} runs` : r.kind === 'command' ? `You run ${r.path}` : r.kind === 'action' ? `The server action ${r.path} runs` : `A request arrives at ${r.method === 'ANY' ? '' : `${r.method} `}${r.path}`;
    const first: Step = {
      kind: 'trigger',
      title: r.kind === 'webhook' ? `An outside service sends a request to ${r.path}.` : r.kind === 'cron' ? `A timer fires ${r.path}. Nobody clicks anything.` : r.kind === 'command' ? `Someone runs ${r.path} in a terminal.` : `A request arrives at ${r.path}.`,
      note: r.kind === 'route' ? 'No screen in this project calls this directly, as far as I can see.' : undefined,
      where: 'outside',
      certainty: r.certainty,
      concept: r.kind === 'webhook' ? 'webhook' : undefined,
      evidence: src.evidence(r.file, r.line, r.handler ? Math.min(r.handler.endLine, r.line + 12) : r.line),
    };
    const body = stepsFrom(events, src);
    const steps = r.kind === 'command' ? body.map((x) => ({ ...x, title: x.title.replace('on your server', 'on the machine running it') })) : body;
    push({ id: `j${journeys.length}`, title: label, trigger: r.kind === 'cron' ? 'schedule' : r.kind === 'command' ? 'command' : 'request', ...meta, routeIds: [...new Set([r.id, ...meta.routeIds])], steps: [first, ...steps], failure: failureOf(events, src, r.kind === 'command') }, `route|${r.id}`);
  }

  journeys.sort((a, b) => b.score - a.score);
  return { journeys: journeys.slice(0, 48), reached };
}

export interface RouteFacts {
  auth: AuthState;
  validates: boolean;
  writes: boolean;
  limited: boolean;
  services: string[];
  events: Ev[];
}

export function routeFacts(r: RouteRec, tr: Tracer, middleware: MiddlewareFact | null, src: Sources): RouteFacts {
  const events = tr.traceRoute(r);
  const services = new Set<string>();
  let writes = false;
  for (const e of events) {
    if (e.t === 'svc') {
      services.add(e.entry.id);
      // A cache is not a record of anything: losing it costs time, not data.
      if (e.access === 'write' && e.entry.id !== 'redis') writes = true;
    }
    if (e.t === 'http' && e.external) services.add(e.external.entry?.id ?? genericService(e.external.host).id);
    if (e.t === 'system' && e.access === 'write') writes = true;
  }
  const validates = !!r.validatedBy || events.some((e) => e.t === 'validate');
  const authEv = events.find((e) => e.t === 'auth') as Extract<Ev, { t: 'auth' }> | undefined;
  let auth: AuthState;
  if (r.kind === 'command') auth = { status: 'not-applicable' };
  else if (r.authHints.length) {
    const h = r.authHints[0];
    auth = { status: 'checked', how: h.how, evidence: src.evidence(h.file, h.line) };
  } else if (authEv?.enforced) auth = { status: 'checked', how: authEv.how, evidence: src.evidence(authEv.unit.file, authEv.site.line) };
  else if (middleware && middleware.covers(r.path)) auth = { status: 'middleware', how: middleware.how, evidence: src.evidence(middleware.file, middleware.line) };
  else if (authEv) auth = { status: 'read-only', how: authEv.how, evidence: src.evidence(authEv.unit.file, authEv.site.line) };
  else auth = { status: 'none' };
  const limited = events.some((e) => e.t === 'limit') || r.authHints.some((h) => /limit|throttle/i.test(h.how));
  return { auth, validates, writes, limited, services: [...services], events };
}

export interface MiddlewareFact {
  file: string;
  line: number;
  how: string;
  covers: (path: string) => boolean;
}

export function findMiddleware(g: Graph, tr: Tracer): MiddlewareFact | null {
  for (const mod of g.modules.values()) {
    if (!/(^|\/)(src\/)?(middleware|proxy)\.(ts|js)$/.test(mod.file) || !g.uses(mod.file, 'next')) continue;
    const def = mod.exports.find((e) => e.name === 'default' || e.name === 'middleware' || e.name === 'proxy');
    if (!def) continue;
    const handler = def.value ? g.handlerUnit(def.value, mod.root) : null;
    const events = handler ? tr.trace(handler, 'server') : [];
    const authEv = events.find((e) => e.t === 'auth') as Extract<Ev, { t: 'auth' }> | undefined;
    const importsAuth = mod.imports.find((i) => /clerk|next-auth|@auth\/|supabase|better-auth|auth0/.test(i.source));
    const wrapper = def.value?.k === 'call' ? def.value.call.parts.map((p) => p.name).join('.') : undefined;
    const how = authEv?.how ?? (wrapper && /auth|clerk/i.test(wrapper) ? wrapper : importsAuth ? importsAuth.source : undefined);
    if (!how) continue;
    const config = mod.exports.find((e) => e.name === 'config');
    const configValue = config?.value?.k === 'ident' ? mod.root.locals.get(config.value.name) : config?.value;
    const matcher = configValue?.k === 'obj' ? configValue.props.matcher : undefined;
    const patterns: string[] = matcher?.k === 'arr' ? matcher.items.map((i) => (i.k === 'str' ? i.v : '')).filter(Boolean) : matcher?.k === 'str' ? [matcher.v] : [];
    const regexes = patterns.map((p) => {
      try {
        return new RegExp(`^${p.replace(/:path\*/g, '.*').replace(/:[a-zA-Z]+/g, '[^/]+')}$`);
      } catch {
        return null;
      }
    }).filter(Boolean) as RegExp[];
    return {
      file: mod.file, line: def.line, how,
      covers: (path) => !patterns.length || regexes.some((r) => r.test(path.replace(/:[a-zA-Z]+\*?/g, 'x'))),
    };
  }
  return null;
}
