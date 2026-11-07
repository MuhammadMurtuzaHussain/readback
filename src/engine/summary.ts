import type { Sources } from './files';
import type { Graph } from './graph';
import type { AnalyseOptions } from './index';
import type { Evidence, Report, Route, Screen, Sentence, VirtualFile } from './types';

const SCRIPT_PLAIN: Record<string, string> = {
  dev: 'Starts the app on your own computer for development.',
  start: 'Starts the built app, the way a server would.',
  build: 'Prepares the app for release.',
  test: 'Runs the automated tests.',
  lint: 'Checks the code for likely mistakes.',
  typecheck: 'Checks that the data types line up.',
  deploy: 'Sends the app to your host.',
};

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function describeProject(g: Graph, src: Sources, opts: AnalyseOptions, screens: Screen[], routes: Route[], input: VirtualFile[]): Report['project'] {
  const root = g.manifests.find((m) => m.dir === '') ?? g.manifests[0];
  const readme = input.find((f) => /^readme\.md$/i.test(f.path));
  const name = opts.name ?? root?.name?.replace(/^@[^/]+\//, '') ?? 'this project';

  const deploys: Report['project']['deploys'] = [];
  const dep = (test: RegExp, label: string): void => {
    const f = [...g.files.keys()].find((p) => test.test(p));
    if (f) deploys.push({ name: label, evidence: src.head(f, 6) });
  };
  dep(/(^|\/)render\.ya?ml$/, 'Render');
  dep(/(^|\/)vercel\.(json|ts)$/, 'Vercel');
  dep(/(^|\/)netlify\.toml$/, 'Netlify');
  dep(/(^|\/)fly\.toml$/, 'Fly.io');
  dep(/(^|\/)railway\.(json|toml)$/, 'Railway');
  dep(/(^|\/)wrangler\.(toml|jsonc?)$/, 'Cloudflare');
  dep(/(^|\/)Dockerfile$/, 'Docker');
  dep(/(^|\/)\.github\/workflows\/.*deploy.*\.ya?ml$/, 'GitHub Actions');

  const apps = g.manifests.filter((m) => m.dir && /^(apps?|packages|services|web|mobile|desktop|server|client|frontend|backend)(\/|$)/.test(m.dir)).map((m) => m.dir);

  const web = routes.filter((r) => r.kind !== 'command');
  const commands = routes.filter((r) => r.kind === 'command');
  let shape: Report['project']['shape'] = 'unknown';
  if (apps.length >= 3) shape = 'monorepo';
  else if (screens.some((s) => s.render === 'native')) shape = 'mobile';
  else if (screens.length && web.length) shape = 'web-app';
  else if (g.manifests.some((m) => m.deps.electron || m.devDeps.electron)) shape = 'desktop';
  else if (screens.length) shape = 'site';
  else if (web.length) shape = 'api';
  else if (commands.length) shape = 'cli';
  else if (root?.json?.main || root?.json?.exports) shape = 'library';

  const run: Report['project']['run'] = [];
  const pm = g.files.has('pnpm-workspace.yaml') ? 'pnpm' : 'npm run';
  for (const key of ['dev', 'start', 'build', 'test']) {
    if (root?.scripts[key]) run.push({ name: key, command: `${pm} ${key}`, plain: SCRIPT_PLAIN[key] ?? '' });
  }

  let readmeLine: string | undefined;
  if (readme) {
    const line = readme.content.split('\n').map((l) => l.trim()).find((l) => l.length > 40 && /^[A-Za-z"“*]/.test(l) && !l.startsWith('[') && !/^\|/.test(l) && !/badge|shields\.io/i.test(l));
    if (line) readmeLine = line.replace(/\*\*/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').slice(0, 260);
  }

  return { name, description: root?.json?.description, readmeLine, github: opts.github, shape, apps, run, deploys };
}

const SHAPE_WORDS: Record<Report['project']['shape'], string> = {
  'web-app': 'a web app', site: 'a website', api: 'a server with no screens of its own', cli: 'a command line tool', library: 'a code library',
  mobile: 'a phone app', desktop: 'a desktop app', monorepo: 'a project made of several apps', unknown: 'a project',
};

type Partial = Omit<Report, 'schema' | 'generatedAt' | 'questions' | 'summary' | 'narration'>;

function evList(items: Array<{ evidence: Evidence }>): Evidence[] {
  return items.slice(0, 8).map((i) => i.evidence);
}

/** Sentences composed from facts. Every noun that matters is clickable. */
export function summarise(r: Partial): Sentence[] {
  const out: Sentence[] = [];
  const fw = r.stack.find((t) => t.kind === 'framework' && !t.ghost);

  const first: Sentence['parts'] = [`${r.project.name} is ${SHAPE_WORDS[r.project.shape]}`];
  if (fw) {
    first.push(' built on ', { text: fw.name, target: { type: 'evidence', evidence: fw.evidence, title: fw.name, body: fw.plain } });
  }
  first.push('.');
  out.push({ parts: first });

  const doors: Sentence['parts'] = [];
  if (r.screens.length) {
    doors.push('People see ', { text: plural(r.screens.length, 'screen'), target: { type: 'view', view: 'map' } });
  }
  const web = r.routes.filter((x) => x.kind !== 'command');
  if (web.length) {
    doors.push(r.screens.length ? ', and your server answers ' : 'Your server answers ', { text: plural(web.length, 'kind of request', 'kinds of request'), target: { type: 'view', view: 'map' } });
  }
  const cmds = r.routes.filter((x) => x.kind === 'command');
  if (cmds.length) doors.push(doors.length ? ', and it has ' : 'It has ', { text: plural(cmds.length, 'command'), target: { type: 'evidence', evidence: evList(cmds), title: 'Commands' } });
  if (doors.length) {
    doors.push('.');
    out.push({ parts: doors });
  }

  const svc = r.services.filter((s) => s.operations.length);
  if (svc.length) {
    const parts: Sentence['parts'] = ['It depends on '];
    svc.slice(0, 5).forEach((s, i) => {
      if (i) parts.push(i === Math.min(svc.length, 5) - 1 ? ' and ' : ', ');
      parts.push({ text: s.name, target: { type: 'evidence', evidence: s.operations.slice(0, 6).map((o) => o.evidence), title: s.name, body: s.plain } });
    });
    if (svc.length > 5) parts.push(`, plus ${svc.length - 5} more`);
    parts.push('.');
    out.push({ parts });
  } else {
    out.push({ parts: ['I found no calls to outside services.'] });
  }

  if (r.project.deploys.length) {
    out.push({ parts: ['It is set up to run on ', { text: r.project.deploys[0].name, target: { type: 'evidence', evidence: [r.project.deploys[0].evidence], title: r.project.deploys[0].name } }, '.'] });
  }

  const highs = r.risks.filter((x) => x.severity === 'high');
  if (highs.length) {
    out.push({ parts: ['There ', highs.length === 1 ? 'is ' : 'are ', { text: plural(highs.length, 'serious risk'), target: { type: 'view', view: 'risks' } }, ' you should look at before anyone else does.'] });
  } else if (r.risks.length) {
    out.push({ parts: ['I found ', { text: plural(r.risks.length, 'thing'), target: { type: 'view', view: 'risks' } }, ' worth checking, none of them urgent.'] });
  }
  return out;
}
