import type { Evidence, Journey, Question, Report, Risk, Step } from '../../engine/types';

/**
 * The film is assembled from report facts only, in a fixed order, so it says
 * nothing the rest of the report does not. Every scene carries `say`: the
 * words for its caption and, if the viewer turns it on, for the voice.
 */
export interface NodeItem {
  label: string;
  sub?: string;
  open?: boolean;
  method?: string;
}

export type Scene =
  | { kind: 'title'; chapter: string; say: string; title: string; sub?: string; ms: number }
  | { kind: 'lines'; chapter: string; say: string; lines: string[]; ms: number }
  | { kind: 'nodes'; chapter: string; say: string; heading: string; items: NodeItem[]; more: number; ms: number }
  | { kind: 'outage'; chapter: string; say: string; service: string; screens: NodeItem[]; routes: NodeItem[]; hitScreens: number; hitRoutes: number; ms: number }
  | { kind: 'step'; chapter: string; say: string; journey: Journey; index: number; step: Step; ms: number }
  | { kind: 'failure'; chapter: string; say: string; journey: Journey; ms: number }
  | { kind: 'risk'; chapter: string; say: string; risk: Risk; index: number; total: number; ms: number }
  | { kind: 'question'; chapter: string; say: string; question: Question; ms: number; thinkMs: number }
  | { kind: 'end'; chapter: string; say: string; risks: number; questions: number; journeys: number; ms: number };

/** Time to read a caption at a calm pace, with a floor so nothing flashes past. */
export function readingMs(text: string, floor = 2600): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(floor, Math.round(words * 300 + 700));
}

function sentence(parts: Report['summary'][number]['parts']): string {
  return parts.map((p) => (typeof p === 'string' ? p : p.text)).join('').replace(/\s+/g, ' ').trim();
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The journey worth watching: a person doing something that reaches the outside. */
export function pickJourney(r: Report): Journey | undefined {
  const human = r.journeys.filter((j) => j.trigger === 'click' || j.trigger === 'submit');
  const ranked = [...(human.length ? human : r.journeys)].sort((a, b) => {
    const reach = (j: Journey): number => (j.routeIds.length ? 2 : 0) + j.serviceIds.length + (j.writes ? 1 : 0);
    return reach(b) - reach(a) || b.score - a.score;
  });
  return ranked.find((j) => j.steps.length >= 3 && j.steps.length <= 10) ?? ranked[0];
}

export function buildScenes(r: Report): Scene[] {
  const scenes: Scene[] = [];
  const name = r.project.name;
  const web = r.routes.filter((x) => x.kind !== 'command');
  const live = r.services.filter((s) => s.operations.length);

  // Opening.
  const sub = r.project.readmeLine ?? r.project.description;
  scenes.push({ kind: 'title', chapter: 'Readback', title: name, sub, say: `This is ${name}, read back from its own code.`, ms: 3800 });

  // What it is.
  const lines = r.summary.map((s) => sentence(s.parts)).filter(Boolean).slice(0, 4);
  if (lines.length) scenes.push({ kind: 'lines', chapter: 'What it is', lines, say: lines.join(' '), ms: readingMs(lines.join(' '), 5000) });

  // What people see.
  if (r.screens.length) {
    const items = r.screens.slice(0, 8).map((s) => ({ label: s.path, sub: s.render === 'server' ? 'built on your server' : s.render === 'native' ? 'on the phone' : 'in the browser' }));
    const say = `People see ${plural(r.screens.length, 'screen')}. ${r.screens.length === 1 ? 'That is' : 'These are'} the only parts of the app anyone looks at.`;
    scenes.push({ kind: 'nodes', chapter: 'What people see', heading: 'Screens', items, more: r.screens.length - items.length, say, ms: readingMs(say, 4200) });
  }

  // The doors.
  if (web.length) {
    const open = web.filter((x) => x.kind !== 'webhook' && x.kind !== 'cron' && (x.auth.status === 'none' || x.auth.status === 'read-only'));
    const items = [...web].sort((a, b) => Number(open.includes(b)) - Number(open.includes(a))).slice(0, 8).map((x) => ({
      label: x.kind === 'action' ? `${x.path}()` : x.path,
      method: x.method === 'ANY' || x.method === 'ACTION' ? undefined : x.method,
      open: open.includes(x),
      sub: open.includes(x) ? 'no login check seen' : x.kind === 'webhook' ? 'webhook' : x.auth.status === 'checked' || x.auth.status === 'middleware' ? 'checks who is asking' : undefined,
    }));
    const say = open.length
      ? `Your server has ${plural(web.length, 'door')} on the internet. On ${open.length === web.length ? 'every one of them' : plural(open.length, 'of them', 'of them')}, I can see no login check.`
      : `Your server has ${plural(web.length, 'door')} on the internet, and each one checks who is asking.`;
    scenes.push({ kind: 'nodes', chapter: 'What your server does', heading: 'Doors on the internet', items, more: web.length - items.length, say, ms: readingMs(say, 4800) });
  }

  // What it stands on, then take the biggest one away.
  if (live.length) {
    const items = live.slice(0, 6).map((s) => ({ label: s.name, sub: s.kind === 'ai' ? 'AI model' : s.kind }));
    const say = `It stands on ${live.length === 1 ? live[0].name : `${live.slice(0, -1).map((s) => s.name).slice(0, 4).join(', ')} and ${live[live.length - 1].name}`}. ${live.length === 1 ? 'That is' : 'Those are'} other people's computers.`;
    scenes.push({ kind: 'nodes', chapter: 'What it depends on', heading: 'Outside services', items, more: live.length - items.length, say, ms: readingMs(say, 4200) });

    const big = [...live].sort((a, b) => b.screens.length + b.routes.length - (a.screens.length + a.routes.length))[0];
    if (big && (big.screens.length || big.routes.length)) {
      const screens = r.screens.slice(0, 8).map((s) => ({ label: s.path, open: big.screens.includes(s.id) }));
      const routes = web.slice(0, 8).map((x) => ({ label: x.path, method: x.method === 'ANY' ? undefined : x.method, open: big.routes.includes(x.id) }));
      const parts = [big.screens.length ? `${big.screens.length} of ${plural(r.screens.length, 'screen')}` : '', big.routes.length && web.length ? `${big.routes.length} of ${plural(web.length, 'route')}` : ''].filter(Boolean);
      const say = `If ${big.name} goes down, ${parts.join(' and ')} lose something they need.`;
      scenes.push({ kind: 'outage', chapter: 'What breaks', service: big.name, screens, routes, hitScreens: big.screens.length, hitRoutes: big.routes.length, say, ms: readingMs(say, 5200) });
    }
  }

  // One journey, step by step.
  const j = pickJourney(r);
  if (j) {
    const steps = j.steps.filter((s) => s.kind !== 'more').slice(0, 9);
    steps.forEach((step, index) => {
      const say = index === 0 ? `Follow one thing. ${step.title}` : step.title;
      scenes.push({ kind: 'step', chapter: j.title, journey: j, index, step, say, ms: readingMs(step.title, 2600) + (step.evidence ? 400 : 0) });
    });
    scenes.push({ kind: 'failure', chapter: 'If it fails', journey: j, say: j.failure.text, ms: readingMs(j.failure.text, 4200) });
  }

  // What could bite.
  const risks = r.risks.filter((x) => x.severity === 'high').slice(0, 2);
  const shown = risks.length ? risks : r.risks.slice(0, 2);
  shown.forEach((risk, index) => {
    const why = risk.why.split(/(?<=\.)\s/)[0];
    scenes.push({ kind: 'risk', chapter: 'What could bite you', risk, index, total: shown.length, say: `${risk.title}. ${why}`, ms: readingMs(`${risk.title}. ${why}`, 5200) });
  });

  // One question, with time to think.
  const q = r.questions.find((x) => x.topic === 'Flow') ?? r.questions[0];
  if (q) scenes.push({ kind: 'question', chapter: 'Read it back', question: q, say: q.ask, ms: 11000, thinkMs: 6000 });

  scenes.push({
    kind: 'end', chapter: 'Your turn', risks: r.risks.length, questions: r.questions.length, journeys: r.journeys.length,
    say: `That was ${name} in ${plural(scenes.length, 'scene')}. Everything you saw links to the code it came from.`, ms: 0,
  });
  return scenes;
}

/** Where a step sits on the stage, left to right. */
export function laneOf(step: Step): 0 | 1 | 2 {
  return step.where === 'browser' ? 0 : step.where === 'server' ? 1 : 2;
}

export function totalMs(scenes: Scene[]): number {
  return scenes.reduce((s, x) => s + x.ms, 0);
}

export type { Evidence };
