import type { Evidence, FileFact, Journey, Option, Question, Risk, Route, Screen, Service, Tech } from './types';

/**
 * Questions are made from facts about this project, so the right answer is
 * always provable and the wrong answers are real names from the same repo.
 * That is what stops this being a generic quiz.
 */
interface Input {
  screens: Screen[];
  routes: Route[];
  services: Service[];
  journeys: Journey[];
  risks: Risk[];
  stack: Tech[];
  files: FileFact[];
  envNames: string[];
}

function pick<T>(items: T[], n: number, seed: number): T[] {
  const copy = [...items];
  const out: T[] = [];
  let s = seed;
  while (copy.length && out.length < n) {
    s = (s * 9301 + 49297) % 233280;
    out.push(copy.splice(s % copy.length, 1)[0]);
  }
  return out;
}

function shuffle<T>(items: T[], seed: number): T[] {
  return pick(items, items.length, seed);
}

function opts(right: string[], wrong: string[], seed: number, mono = false): { options: Option[]; answer: string[] } {
  const all = shuffle([...right.map((t) => ({ t, ok: true })), ...wrong.map((t) => ({ t, ok: false }))], seed);
  const options = all.map((a, i) => ({ id: `o${i}`, text: a.t, mono }));
  return { options, answer: options.filter((_, i) => all[i].ok).map((o) => o.id) };
}

export function buildQuestions(i: Input): Question[] {
  const out: Question[] = [];
  let n = 0;
  const add = (q: Omit<Question, 'id'>): void => {
    if (q.options.length < 2) return;
    out.push({ ...q, id: `q${++n}` });
  };
  const { routes, services, journeys, risks, stack, screens, files, envNames } = i;
  const web = routes.filter((r) => r.kind !== 'command');

  // Where does a click land?
  const j1 = journeys.find((j) => (j.trigger === 'click' || j.trigger === 'submit') && j.routeIds.length);
  if (j1) {
    const route = routes.find((r) => r.id === j1.routeIds[0]);
    if (route) {
      const others = [...new Set(web.filter((r) => r.file !== route.file).map((r) => r.file))];
      const wrong = pick(others, 3, 7);
      if (wrong.length < 2) wrong.push(...pick(files.filter((f) => f.role === 'logic' || f.role === 'component').map((f) => f.path), 3 - wrong.length, 11));
      add({
        topic: 'Flow', ask: `${j1.title}. Which file on your server handles it first?`, ...opts([route.file], wrong, 3, true),
        multi: false, explain: `The screen sends ${route.method === 'ANY' ? 'a request' : `a ${route.method}`} to ${route.path}, and ${route.file} is what answers it.`,
        evidence: [route.evidence], concept: 'api-route',
      });
    }
  }

  // What does it touch?
  const j2 = journeys.find((j) => j.serviceIds.length >= 1 && j !== j1) ?? j1;
  if (j2?.serviceIds.length) {
    const right = j2.serviceIds.map((s) => services.find((x) => x.id === s)?.name).filter(Boolean) as string[];
    const wrong = services.filter((s) => !j2.serviceIds.includes(s.id)).map((s) => s.name);
    const fill = ['Redis', 'Stripe', 'Firebase', 'OpenAI', 'A background queue'].filter((x) => !right.includes(x) && !wrong.includes(x));
    const dist = [...pick(wrong, 3, 5), ...pick(fill, 3, 2)].slice(0, Math.max(2, 4 - right.length));
    add({
      topic: 'Flow', ask: `${j2.title}. Which outside services does that reach?`, ...opts(right, dist, 13),
      multi: right.length > 1, explain: `Traced from the code: ${right.join(', ')}.`,
      evidence: j2.steps.filter((s) => s.serviceId).map((s) => s.evidence!).filter(Boolean).slice(0, 3),
    });
  }

  // Who can knock?
  const openRoutes = web.filter((r) => r.auth.status === 'none' && r.kind !== 'cron');
  const lockedRoutes = web.filter((r) => r.auth.status === 'checked' || r.auth.status === 'middleware');
  if (openRoutes.length && lockedRoutes.length) {
    const right = pick(openRoutes, 2, 3).map(rname);
    const wrong = pick(lockedRoutes, 3, 9).map(rname);
    add({
      topic: 'Security', ask: 'Which of these can be called by someone who is not logged in, as far as the code shows?', ...opts(right, wrong, 17, true),
      multi: true, explain: 'The selected routes have no login check that I can see. The others check first or sit behind middleware.',
      evidence: pick(openRoutes, 2, 3).map((r) => r.evidence), concept: 'auth',
    });
  } else if (web.length && !lockedRoutes.length) {
    add({
      topic: 'Security', ask: `Your project has ${web.length} way${web.length === 1 ? '' : 's'} in from the internet. How many check who is calling?`,
      ...opts(['None that I can see'], ['All of them', 'Only the ones that write data', 'They are protected by HTTPS'], 19),
      multi: false, explain: 'No handler shows a login check. HTTPS encrypts the connection, but it says nothing about who is on the other end. Being public may be fine for your app. It should be a decision, not an accident.',
      evidence: web.slice(0, 2).map((r) => r.evidence), concept: 'auth',
    });
  }

  // Failure.
  const failing = journeys.find((j) => !j.failure.caught && j.failure.evidence);
  if (failing) {
    add({
      topic: 'Failure', ask: `${failing.title}. What happens if the outside call in that path fails?`,
      ...opts(['Nothing catches the error, so the person sees a broken screen or a generic error'], ['It retries three times automatically', 'The app shows a friendly message from a try/catch on this path', 'The request is queued and sent later'], 23),
      multi: false, explain: failing.failure.text, evidence: [failing.failure.evidence!],
    });
  }

  // Blast radius.
  const big = [...services].filter((s) => s.screens.length || s.routes.length).sort((a, b) => b.routes.length + b.screens.length - (a.routes.length + a.screens.length))[0];
  if (big && screens.length > 1 && big.screens.length) {
    const hit = big.screens.map((id) => screens.find((s) => s.id === id)?.path).filter(Boolean) as string[];
    const safe = screens.filter((s) => !big.screens.includes(s.id)).map((s) => s.path);
    if (safe.length) {
      add({
        topic: 'Dependencies', ask: `${big.name} goes down for an hour. Which screen keeps working?`, ...opts(pick(safe, 1, 5), pick(hit, 3, 7), 29, true),
        multi: false, explain: `${big.name} is reached from: ${hit.slice(0, 5).join(', ')}. The screen you are looking for reaches it on no path I can trace.`,
        evidence: big.operations.slice(0, 2).map((o) => o.evidence),
      });
    }
  }

  // Secrets.
  const secrets = envNames.filter((e) => /KEY|SECRET|TOKEN|PASSWORD|URL/.test(e));
  if (secrets.length >= 2) {
    const right = pick(secrets, Math.min(3, secrets.length), 3);
    const fake = ['STRIPE_SECRET_KEY', 'REDIS_URL', 'SESSION_SECRET', 'SENDGRID_API_KEY', 'AWS_SECRET_ACCESS_KEY'].filter((x) => !envNames.includes(x));
    add({
      topic: 'Setup', ask: 'Your app is moving to a new host. Which of these must you set for it to run?', ...opts(right, pick(fake, 2, 3), 31, true),
      multi: true, explain: 'These names are read from the environment in your code. The two others are common names that do not appear in this project.', evidence: [],
      concept: 'env',
    });
  }

  // Stack: what is it for?
  const known = stack.filter((t) => t.plain && !t.ghost && t.importedBy > 0 && (t.kind !== 'tooling'));
  const t1 = known.find((t) => t.kind === 'validation') ?? known.find((t) => t.kind === 'database') ?? known.find((t) => t.kind === 'framework');
  if (t1) {
    const wrong = known.filter((t) => t.id !== t1.id && t.plain).map((t) => firstSentence(t.plain));
    add({
      topic: 'Stack', ask: `In one sentence, what does ${t1.name} do in your project?`, ...opts([firstSentence(t1.plain)], pick(wrong, 3, 4), 37),
      multi: false, explain: `${t1.plain} It is imported by ${t1.importedBy} file${t1.importedBy === 1 ? '' : 's'} here.`, evidence: t1.evidence.slice(0, 2),
    });
  }

  // Browser or server.
  const browserDb = services.find((s) => s.kind === 'database' && s.from.includes('browser'));
  if (browserDb) {
    add({
      topic: 'Security', ask: `Which sentence is true about ${browserDb.name} in your app?`,
      ...opts([`The browser talks to ${browserDb.name} directly, so its access rules are what protect your data`], [`All ${browserDb.name} calls go through your server first`, `${browserDb.name} can only be reached from your host`, 'Your API key keeps strangers out'], 41),
      multi: false, explain: 'At least one call runs in browser code. Anyone can run the same call from their own console.',
      evidence: browserDb.operations.filter((o) => o.from === 'browser').slice(0, 2).map((o) => o.evidence), concept: 'rls',
    });
  } else {
    const secretKeyService = services.find((s) => s.from.includes('server') && s.envVars.length);
    if (secretKeyService) {
      add({
        topic: 'Security', ask: `Where does the code that uses your ${secretKeyService.name} credentials run?`,
        ...opts(['On the server, never in the visitor\'s browser'], ['In the visitor\'s browser', 'In both', 'Inside the database'], 43),
        multi: false, explain: `The calls I traced to ${secretKeyService.name} run in server code, which is why ${secretKeyService.envVars[0]} can stay secret.`,
        evidence: secretKeyService.operations.slice(0, 2).map((o) => o.evidence),
      });
    }
  }

  // Top risk.
  const top = risks.find((r) => r.severity === 'high' && r.evidence.length);
  if (top) {
    add({
      topic: 'Risk', ask: 'If someone asked you what the biggest risk in this app is, what is the honest answer from the code?',
      ...opts([top.title], pick(['The site might load slowly', 'The colours may not match the brand', 'A framework might release a new version', 'Someone might dislike the design'], 3, 9), 47),
      multi: false, explain: top.why, evidence: top.evidence.slice(0, 2), concept: top.concept,
    });
  }

  // Part of the code.
  const hub = [...files].filter((f) => f.role === 'logic' || f.role === 'component').sort((a, b) => b.importedBy - a.importedBy)[0];
  if (hub && hub.importedBy >= 3) {
    const wrong = files.filter((f) => f !== hub && (f.role === 'logic' || f.role === 'component') && f.importedBy <= 1).map((f) => f.path);
    add({
      topic: 'Parts', ask: 'Which file would break the most other files if you changed it carelessly?', ...opts([hub.path], pick(wrong, 3, 3), 53, true),
      multi: false, explain: `${hub.path} is imported by ${hub.importedBy} other files, more than any other in this role.`, evidence: [],
    });
  }

  return out;
}

function rname(r: Route): string {
  return r.kind === 'action' ? `${r.path} (server action)` : `${r.method === 'ANY' ? '' : `${r.method} `}${r.path}`;
}

function firstSentence(s: string): string {
  const m = s.match(/^[^.]*\./);
  return m ? m[0] : s;
}

export type { Evidence };
