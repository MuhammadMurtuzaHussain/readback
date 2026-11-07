import { findSecrets, LOCKFILES } from './files';
import type { Sources } from './files';
import type { Graph } from './graph';
import type { Module } from './model';
import type { EnvVar, Evidence, Journey, Risk, Route, Service, Table, Tech, VirtualFile } from './types';

const PUBLIC_ENV = /^(NEXT_PUBLIC_|VITE_|PUBLIC_|REACT_APP_|EXPO_PUBLIC_|NUXT_PUBLIC_|GATSBY_)/;
/** Keys that are meant to be public, and saying so stops a false alarm. */
const SAFE_PUBLIC = /ANON|PUBLISHABLE|PUBLIC_KEY|SITE_KEY|MEASUREMENT|POSTHOG|SENTRY_DSN|FIREBASE_(API_KEY|AUTH_DOMAIN|PROJECT_ID|STORAGE_BUCKET|APP_ID|MESSAGING_SENDER_ID)|MAPBOX|GOOGLE_MAPS|URL$|HOST$/;
const SECRETY = /SECRET|PRIVATE|SERVICE_ROLE|PASSWORD|API_?KEY|TOKEN|ACCESS_KEY|CREDENTIAL|WEBHOOK/;

export function looksSecret(name: string): boolean {
  if (/PUBLISHABLE|ANON|PUBLIC_KEY/.test(name)) return false;
  return SECRETY.test(name);
}

export function isPublicEnv(name: string): boolean {
  return PUBLIC_ENV.test(name);
}

interface Input {
  g: Graph;
  src: Sources;
  routes: Route[];
  services: Service[];
  journeys: Journey[];
  tables: Table[];
  stack: Tech[];
  env: EnvVar[];
  allPaths: string[];
  files: VirtualFile[];
  tracked?: Set<string>;
}

export function findRisks(i: Input): Risk[] {
  const out: Risk[] = [];
  const { g, src, routes, services, tables, env, allPaths, files } = i;
  let n = 0;
  const add = (r: Omit<Risk, 'id'>): void => {
    out.push({ ...r, id: `risk${++n}` });
  };

  // 1. Doors with no lock.
  const open = routes.filter((r) => r.kind !== 'command' && r.kind !== 'webhook' && r.kind !== 'cron' && r.auth.status === 'none');
  const openWrites = open.filter((r) => r.writes);
  if (openWrites.length) {
    add({
      rule: 'open-write', severity: 'high',
      title: openWrites.length === 1 ? `${label(openWrites[0])} changes data and I can see no login check` : `${openWrites.length} routes change data and I can see no login check`,
      why: 'These are doors on the internet. If nothing checks who is knocking, anyone who finds the address can change your data, with no need for your app.',
      check: 'Open a private browser window with no login and send the request. Does it work?',
      caveat: 'If this app only ever runs on your own computer, or a proxy or helper I could not follow protects it, this is a false alarm. Decide by testing, not by assuming.',
      fixPrompt: `These routes change data with no visible login check:\n${openWrites.slice(0, 8).map((r) => `- ${r.method} ${r.path} (${r.file}:${r.evidence.line})`).join('\n')}\n\nFor each one, tell me who should be allowed to call it. Then add a check at the top of the handler that returns 401 when nobody is logged in and 403 when the user does not own the record. Do not change anything else.`,
      certainty: 'inferred', evidence: openWrites.slice(0, 8).map((r) => r.evidence), concept: 'auth',
    });
  }
  const readOnlyAuth = routes.filter((r) => r.auth.status === 'read-only' && r.writes);
  if (readOnlyAuth.length) {
    add({
      rule: 'auth-not-enforced', severity: 'high',
      title: `${readOnlyAuth.length === 1 ? label(readOnlyAuth[0]) : `${readOnlyAuth.length} routes`} looks up the user but may not stop strangers`,
      why: 'The code asks who is logged in, but I could not find it turning away a visitor when the answer is nobody. It can still continue with an empty user.',
      check: 'Read the lines after the lookup. Is there an early return when the user is missing?',
      caveat: 'The check might live somewhere I could not follow.',
      fixPrompt: `In ${readOnlyAuth.slice(0, 5).map((r) => `${r.file}:${r.evidence.line}`).join(', ')}, the handler reads the current user. Add an early return with a 401 if there is no user, before any data is changed.`,
      certainty: 'inferred', evidence: readOnlyAuth.slice(0, 6).map((r) => r.auth.evidence ?? r.evidence), concept: 'auth',
    });
  }

  // 2. Money on an open door.
  const paidAi = (id: string): boolean => {
    const s = services.find((x) => x.id === id);
    return s?.kind === 'ai' && s.id !== 'ollama';
  };
  const llmRoutes = routes.filter((r) => r.services.some(paidAi) && !r.limited && (r.auth.status === 'none' || r.auth.status === 'read-only'));
  if (llmRoutes.length) {
    add({
      rule: 'open-ai-cost', severity: 'high',
      title: `Anyone can make you pay: ${llmRoutes.length === 1 ? `${label(llmRoutes[0])} spends` : `${llmRoutes.length} routes spend`} AI credit with no login check`,
      why: 'Every call to this route costs you real money. A simple loop from one stranger could run up your bill overnight.',
      check: 'Set a hard spending limit on your AI provider today. Then look at whether this route needs a login or a rate limit.',
      caveat: 'I recognise common rate limit names and packages. A limit with an unusual name, or one set at your host, would not show up here.',
      fixPrompt: `${llmRoutes.slice(0, 5).map((r) => `${r.method} ${r.path}`).join(', ')} call a paid AI model and have no login check. Add a per-user or per-IP rate limit, and cap the size of the input. Show me what the limit is before you add it.`,
      certainty: 'inferred', evidence: llmRoutes.slice(0, 6).map((r) => r.evidence), concept: 'rate-limit',
    });
  }

  // 3. Secrets.
  const badPublic = env.filter((e) => isPublicEnv(e.name) && SECRETY.test(e.name) && !SAFE_PUBLIC.test(e.name));
  if (badPublic.length) {
    add({
      rule: 'public-secret', severity: 'high',
      title: `${badPublic.map((e) => e.name).slice(0, 3).join(', ')} ${badPublic.length === 1 ? 'is' : 'are'} sent to every visitor's browser`,
      why: 'Names starting with NEXT_PUBLIC_ or VITE_ are copied into the JavaScript your site sends out. Anyone can open it and read the value. If this is a real secret, treat it as already leaked.',
      check: 'Open your live site, view the page source files, and search for the first few characters of the key.',
      fixPrompt: `${badPublic.map((e) => e.name).join(', ')} are exposed to the browser. Move the call that uses them to a server route, rename the variable without the public prefix, then tell me which keys I must rotate.`,
      certainty: 'seen', evidence: badPublic.flatMap((e) => e.reads.slice(0, 2)), concept: 'env',
    });
  }
  const hard: Evidence[] = [];
  const labels = new Set<string>();
  for (const f of files) {
    if (/(^|\/)\.env\.(example|sample|template)$|\.test\.|\.spec\.|(^|\/)(fixtures?|examples?|tests?|docs?)\//i.test(f.path) || /\.(md|mdx|lock)$/.test(f.path)) continue;
    for (const h of findSecrets(f.content)) {
      labels.add(h.label);
      if (hard.length < 8) hard.push(src.evidence(f.path, h.line, h.line, 0));
    }
  }
  if (hard.length) {
    add({
      rule: 'hardcoded-secret', severity: 'high',
      title: `A ${[...labels][0]} looks like it is written into the code`,
      why: 'Anything committed to a repository stays in its history, even after you delete the line. If this repository is or ever was public, assume the key is gone.',
      check: 'I have hidden the value here. Open the file, and if it is real, rotate it with the provider first, then remove it.',
      fixPrompt: 'Move the hardcoded secret in these files into an environment variable and add it to .env.example with a blank value:\n' + hard.map((e) => `- ${e.file}:${e.line}`).join('\n'),
      certainty: 'seen', evidence: hard, concept: 'env',
    });
  }
  const envFiles = allPaths.filter((p) => /(^|\/)\.env(\.[a-z]+)?$/.test(p) && !/\.(example|sample|template)$/.test(p));
  const gitignore = files.find((f) => f.path === '.gitignore')?.content ?? '';
  const ignored = /(^|\n)\s*\.env/.test(gitignore);
  const committed = i.tracked ? envFiles.filter((p) => i.tracked!.has(p)) : !ignored && envFiles.length ? envFiles : [];
  if (committed.length) {
    add({
      rule: 'env-committed', severity: 'high',
      title: `${committed[0]} is committed to the repository`,
      why: 'That file normally holds your real keys. Committing it publishes them to everyone who can see the repository, and they stay in the history.',
      check: 'Run git ls-files | grep .env in your project.',
      fixPrompt: 'Remove .env from git tracking with git rm --cached, add it to .gitignore, and list every key in it so I can rotate them.',
      certainty: i.tracked ? 'seen' : 'inferred', evidence: [],
    });
  } else if (envFiles.length === 0 && env.some((e) => e.looksSecret) && !ignored && gitignore !== '') {
    add({
      rule: 'env-not-ignored', severity: 'medium',
      title: '.gitignore does not list .env',
      why: 'Your code reads secrets from the environment, and nothing stops a future .env file being committed by accident.',
      check: 'Add .env* to .gitignore.',
      fixPrompt: 'Add .env, .env.local and .env.*.local to .gitignore, keeping .env.example tracked.',
      certainty: 'seen', evidence: [src.head('.gitignore', 6)],
    });
  }

  // 4. Supabase row level security.
  const noRls = tables.filter((t) => t.rls === false);
  const sb = services.find((s) => s.id === 'supabase');
  if (noRls.length && sb) {
    add({
      rule: 'rls-off', severity: 'high',
      title: `${noRls.length === 1 ? `The ${noRls[0].name} table has` : `${noRls.length} tables have`} no row level security in your migrations`,
      why: 'Supabase gives your browser a public key on purpose. Row level security is what stops that key reading or changing everyone else\'s rows. Without it, your public key is a master key.',
      check: 'Open the Supabase dashboard, go to Authentication then Policies, and look for tables marked RLS disabled.',
      caveat: 'I only read migration files in this repository. RLS turned on by hand in the dashboard does not show up here.',
      fixPrompt: `Write a migration that enables row level security on: ${noRls.map((t) => t.name).join(', ')}. Then propose a policy per table so each user can only see and change their own rows, and explain each one in a sentence.`,
      certainty: 'inferred', evidence: noRls.slice(0, 6).map((t) => t.evidence), concept: 'rls',
    });
  }
  const browserDb = services.filter((s) => s.kind === 'database' && s.from.includes('browser') && s.id !== 'convex');
  for (const s of browserDb) {
    const writes = s.operations.filter((o) => o.from === 'browser' && o.access === 'write');
    if (!writes.length) continue;
    add({
      rule: 'browser-db-write', severity: 'medium',
      title: `The browser writes directly to ${s.name}`,
      why: 'There is no server of yours in the middle, so your database\'s own access rules are the only check. Anything your screen can do, a visitor can do from their browser console.',
      check: 'Confirm every table touched here has rules that limit people to their own rows.',
      fixPrompt: `These browser calls write straight to ${s.name}:\n${writes.slice(0, 6).map((w) => `- ${w.evidence.file}:${w.evidence.line}`).join('\n')}\nCheck the access rules that cover each one and tell me whether a logged-in user could change someone else's data.`,
      certainty: 'seen', evidence: writes.slice(0, 6).map((w) => w.evidence), concept: 'rls',
    });
  }

  // 5. Webhooks.
  const hooks = routes.filter((r) => r.kind === 'webhook');
  const unverified = hooks.filter((r) => !verifiesSignature(g, r));
  if (unverified.length) {
    add({
      rule: 'webhook-unsigned', severity: 'high',
      title: `${label(unverified[0])} accepts webhooks and I cannot see it checking a signature`,
      why: 'A webhook address is public. Without checking the signature, anyone can send a fake "payment succeeded" and your app will believe it.',
      check: 'Look for constructEvent, verifySignature or a comparison against a signing secret in this handler.',
      caveat: 'I look for common names only, so a custom check could be missed.',
      fixPrompt: `Add signature verification to ${unverified.map((r) => `${r.path} (${r.file})`).join(', ')} using the provider's official method, and reject anything that fails with a 400 before doing any work.`,
      certainty: 'inferred', evidence: unverified.slice(0, 4).map((r) => r.evidence), concept: 'webhook',
    });
  }

  // 6. Dangerous code.
  const notable = (kind: Module['notable'][number]['kind']): Evidence[] => {
    const ev: Evidence[] = [];
    for (const mod of g.modules.values()) {
      if (/(^|\/)(tests?|__tests__|e2e)\/|\.(test|spec)\./.test(mod.file)) continue;
      for (const x of mod.notable) if (x.kind === kind && ev.length < 8) ev.push(src.evidence(mod.file, x.line));
    }
    return ev;
  };
  const sql = notable('sql-interpolated');
  if (sql.length) {
    add({
      rule: 'sql-injection', severity: 'high',
      title: 'SQL is built by joining strings together',
      why: 'If any of those pieces comes from a person, they can write their own SQL into it and read or delete anything. This is the oldest attack on the web, and it still works.',
      check: 'Check where each inserted value comes from.',
      fixPrompt: 'Rewrite these queries to use parameters instead of string interpolation:\n' + sql.map((e) => `- ${e.file}:${e.line}`).join('\n'),
      certainty: 'seen', evidence: sql, concept: 'sql-injection',
    });
  }
  const html = [...notable('dangerous-html'), ...notable('inner-html')];
  if (html.length) {
    add({
      rule: 'raw-html', severity: 'medium',
      title: 'Raw HTML is inserted into the page',
      why: 'If that HTML contains anything a person typed, or anything a model wrote, it can run as code in other people\'s browsers and steal their sessions.',
      check: 'Trace where the HTML comes from. If it is your own static text, this is fine.',
      fixPrompt: 'For each of these, either render as plain text, or sanitise with DOMPurify first:\n' + html.map((e) => `- ${e.file}:${e.line}`).join('\n'),
      certainty: 'seen', evidence: html, concept: 'xss',
    });
  }
  const evalUse = notable('eval');
  if (evalUse.length) {
    add({
      rule: 'eval', severity: 'high', title: 'The code runs text as code with eval',
      why: 'If that text can be influenced by a person or a model, they get to run anything your app can run.',
      check: 'Find where the string comes from and whether it can be replaced with a normal function.',
      fixPrompt: 'Replace each eval or new Function with an explicit function or a safe parser:\n' + evalUse.map((e) => `- ${e.file}:${e.line}`).join('\n'),
      certainty: 'seen', evidence: evalUse,
    });
  }
  const cors = notable('cors-wildcard');
  if (cors.length) {
    add({
      rule: 'cors-wildcard', severity: 'medium', title: 'Any website can call this server from a visitor\'s browser',
      why: 'Access-Control-Allow-Origin set to * tells browsers that every site is allowed. For public read-only data that is fine. For anything tied to a logged-in person it is not.',
      check: 'List which origins actually need access.',
      fixPrompt: 'Replace the wildcard CORS origin with an explicit list from an environment variable.',
      certainty: 'seen', evidence: cors, concept: 'cors',
    });
  }
  const ls = notable('local-storage-token');
  if (ls.length) {
    add({
      rule: 'token-localstorage', severity: 'medium', title: 'A login token is kept in localStorage',
      why: 'Any script on your page can read localStorage. One bad dependency or injected script can walk away with your users\' sessions.',
      check: 'See whether an httpOnly cookie would work instead.',
      fixPrompt: 'Move this token from localStorage to an httpOnly, secure, sameSite cookie set by the server.',
      certainty: 'seen', evidence: ls,
    });
  }
  const todo = notable('todo-security');
  if (todo.length) {
    add({
      rule: 'todo-security', severity: 'low', title: 'Comments say a security job was left for later',
      why: 'Your code contains a note admitting something is unfinished. Coding assistants leave these behind and nobody comes back to them.',
      check: 'Read each note and decide if it is still true.',
      fixPrompt: 'Here are TODO comments about security. For each, tell me whether it is still needed and fix the ones that are:\n' + todo.map((e) => `- ${e.file}:${e.line}`).join('\n'),
      certainty: 'seen', evidence: todo,
    });
  }

  // 7. Input validation.
  const unvalidated = routes.filter((r) => r.writes && !r.validates && r.method !== 'GET' && r.kind !== 'command' && r.kind !== 'webhook');
  if (unvalidated.length) {
    add({
      rule: 'no-validation', severity: 'medium',
      title: `${unvalidated.length === 1 ? label(unvalidated[0]) : `${unvalidated.length} routes`} save incoming data without checking its shape`,
      why: 'TypeScript types disappear when the app runs. Whatever arrives over the network is exactly what the sender chose to send, including extra fields or the wrong kind of data.',
      check: 'Send a request with a missing field and an extra field. What ends up in the database?',
      caveat: 'I recognise Zod, Joi, Yup, Valibot and handwritten schema.parse calls. Manual if-checks are not counted.',
      fixPrompt: `Add a Zod schema to validate the input of:\n${unvalidated.slice(0, 8).map((r) => `- ${r.method} ${r.path} (${r.file})`).join('\n')}\nReturn a 400 with a clear message when it fails.`,
      certainty: 'inferred', evidence: unvalidated.slice(0, 6).map((r) => r.evidence), concept: 'validation',
    });
  }

  // 8. Client code expects a server secret.
  const emptyInBrowser = env.filter((e) => e.exposure === 'both' && !isPublicEnv(e.name) && !/^NODE_ENV$/.test(e.name));
  if (emptyInBrowser.length) {
    add({
      rule: 'env-empty-in-browser', severity: 'low',
      title: `${emptyInBrowser[0].name} is read in code that also runs in the browser`,
      why: 'Without a public prefix, this value does not exist in the browser, so it silently reads as undefined there. It can work on your laptop and fail for users.',
      check: 'Make sure this file only runs on the server, or give the value a safe public version.',
      fixPrompt: `${emptyInBrowser.map((e) => e.name).join(', ')} is read in code bundled for the browser. Move the read to server-only code.`,
      certainty: 'inferred', evidence: emptyInBrowser.flatMap((e) => e.reads.slice(0, 2)).slice(0, 4), concept: 'env',
    });
  }

  // 9. Project hygiene.
  const hasTests = allPaths.some((p) => /\.(test|spec)\.[a-z]+$|(^|\/)tests?\/|test_.*\.py$/.test(p));
  if (!hasTests && g.modules.size > 8) {
    add({
      rule: 'no-tests', severity: 'medium', title: 'There are no automated tests',
      why: 'When a coding assistant changes something, a test is what tells you it did not break something else. Without tests, every change is a guess you check by clicking around.',
      check: 'Pick the one flow that would hurt most if it broke, and start there.',
      fixPrompt: 'Write a test for the most important flow in this app. Explain what it proves and what would make it fail.',
      certainty: 'seen', evidence: [],
    });
  }
  if (!allPaths.some((p) => LOCKFILES.test(p)) && allPaths.includes('package.json')) {
    add({
      rule: 'no-lockfile', severity: 'low', title: 'There is no lockfile',
      why: 'Without one, every install can pull slightly different code than you tested with.',
      check: 'Run your package manager once and commit the lockfile it creates.',
      fixPrompt: 'Generate and commit a lockfile.',
      certainty: 'seen', evidence: [],
    });
  }
  const ghosts = i.stack.filter((t) => t.ghost && !t.devOnly && (t.kind !== 'tooling' && t.kind !== 'testing' && t.kind !== 'build'));
  if (ghosts.length >= 2) {
    add({
      rule: 'ghost-deps', severity: 'low', title: `${ghosts.length} installed packages are never imported`,
      why: 'Assistants often install things they then stop using. Each one is extra code you ship, update and trust for nothing. Some are needed indirectly, so check before removing.',
      check: `Start with: ${ghosts.slice(0, 5).map((g2) => g2.packages[0]).join(', ')}.`,
      fixPrompt: `Check whether these packages are used anywhere, including config files: ${ghosts.map((g2) => g2.packages[0]).join(', ')}. Remove the ones that are not.`,
      certainty: 'inferred', evidence: ghosts.slice(0, 4).flatMap((g2) => g2.evidence.slice(0, 1)),
    });
  }

  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

function label(r: Route): string {
  return r.kind === 'action' ? `the server action ${r.path}` : `${r.method === 'ANY' ? '' : `${r.method} `}${r.path}`;
}

function verifiesSignature(g: Graph, r: Route): boolean {
  const mod = g.modules.get(r.file);
  if (!mod) return true;
  const text = g.files.get(r.file)?.content ?? '';
  return /constructEvent|verifySignature|verifyWebhook|validateWebhook|timingSafeEqual|svix|webhooks\.verify|signature/i.test(text);
}
