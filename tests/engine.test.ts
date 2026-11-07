import { describe, expect, it } from 'vitest';
import { analyse } from '../src/engine';
import { findSecrets, maskSecrets } from '../src/engine/files';
import { matchRoutePath, normalizeUrl } from '../src/engine/trace';
import { checkAgainstFacts } from '../src/ui/narrationClient';
import type { VirtualFile } from '../src/engine/types';

const pkg = (deps: Record<string, string>): VirtualFile => ({ path: 'package.json', content: JSON.stringify({ name: 'demo', dependencies: deps }) });
const f = (path: string, content: string): VirtualFile => ({ path, content });

describe('routes are proven, not string matched', () => {
  it('does not mistake cache.get for a route, and follows a mounted router', () => {
    const r = analyse([
      pkg({ express: '^4.0.0' }),
      f('server.js', `
        const express = require('express');
        const users = require('./users');
        const cache = new Map();
        const app = express();
        cache.get('/not/a/route', () => 1);
        app.use('/api', users);
        app.listen(3000);
      `),
      f('users.js', `
        const express = require('express');
        const router = express.Router();
        router.get('/users/:id', (req, res) => res.json({}));
        module.exports = router;
      `),
    ]);
    expect(r.routes.map((x) => `${x.method} ${x.path}`)).toEqual(['GET /api/users/:id']);
  });

  it('reports an unmounted router as a gap instead of a route path', () => {
    const r = analyse([
      pkg({ express: '^4.0.0' }),
      f('orphan.js', `
        const { Router } = require('express');
        const r = Router();
        r.post('/ghost', (req, res) => res.end());
      `),
    ]);
    expect(r.gaps.some((g) => g.kind === 'unmounted-router')).toBe(true);
  });

  it('turns Next.js folders into addresses, ignoring route groups', () => {
    const r = analyse([
      pkg({ next: '15.0.0' }),
      f('app/(shop)/items/[id]/route.ts', 'export async function GET() { return new Response("ok"); }'),
      f('app/(shop)/items/[id]/page.tsx', 'export default function P() { return <div/>; }'),
    ]);
    expect(r.routes[0].path).toBe('/items/:id');
    expect(r.screens[0].path).toBe('/items/:id');
  });

  it('reads Hono inside a factory function', () => {
    const r = analyse([
      pkg({ hono: '4.0.0' }),
      f('server/app.ts', `
        import { Hono } from 'hono';
        export function createApp() {
          const app = new Hono();
          app.post('/api/x', (c) => c.json({}));
          return app;
        }
      `),
    ]);
    expect(r.routes.map((x) => x.path)).toEqual(['/api/x']);
  });
});

describe('hand-written servers', () => {
  it('reads routes out of if statements and keeps their effects apart', () => {
    const r = analyse([
      pkg({ openai: '4.0.0' }),
      f('server.ts', `
        import { createServer } from 'node:http';
        import OpenAI from 'openai';
        const openai = new OpenAI();
        createServer(async (req, res) => {
          const url = new URL(req.url, 'http://x');
          if (req.method === 'POST' && url.pathname === '/api/kit') {
            await openai.chat.completions.create({ model: 'm', messages: [] });
          }
          if (url.pathname === '/api/status') res.end('ok');
        }).listen(3000);
      `),
    ]);
    expect(r.routes.map((x) => `${x.method} ${x.path}`).sort()).toEqual(['ANY /api/status', 'POST /api/kit']);
    expect(r.routes.find((x) => x.path === '/api/kit')?.services).toContain('openai');
    expect(r.routes.find((x) => x.path === '/api/status')?.services).toEqual([]);
  });
});

describe('rate limits count as a guard', () => {
  it('does not cry wolf about AI cost when a limiter is on the path', () => {
    const files = (guard: string) => [
      pkg({ next: '15.0.0', openai: '4.0.0' }),
      f('lib/limit.ts', 'export async function rateLimit(req) { return false; }'),
      f('app/api/x/route.ts', `
        import OpenAI from 'openai';
        import { rateLimit } from '../../../lib/limit';
        const openai = new OpenAI();
        export async function POST(req) {
          ${guard}
          return Response.json(await openai.chat.completions.create({ model: 'm', messages: [] }));
        }
      `),
    ];
    expect(analyse(files('')).risks.find((x) => x.rule === 'open-ai-cost')).toBeDefined();
    expect(analyse(files('await rateLimit(req);')).risks.find((x) => x.rule === 'open-ai-cost')).toBeUndefined();
  });
});

describe('import resolution', () => {
  it('follows tsconfig aliases, re-exports and .js extensions pointing at .ts', () => {
    const r = analyse([
      pkg({ next: '15.0.0', '@supabase/supabase-js': '2.0.0' }),
      f('tsconfig.json', '{ // comment\n "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }'),
      f('src/lib/db.ts', `import { createClient } from '@supabase/supabase-js';\nexport const db = createClient('a', 'b');`),
      f('src/lib/index.ts', `export { db } from './db.js';`),
      f('src/app/api/items/route.ts', `import { db } from '@/lib';\nexport async function POST() { await db.from('items').insert({}); return new Response(); }`),
    ]);
    const route = r.routes[0];
    expect(route.services).toContain('supabase');
    expect(route.writes).toBe(true);
    expect(r.services[0].operations[0].target).toBe('items');
  });

  it('sees through classes, typed parameters and injected fetch', () => {
    const r = analyse([
      pkg({ hono: '4.0.0' }),
      f('db.ts', `
        import { DatabaseSync } from 'node:sqlite';
        export class Store {
          private db: DatabaseSync;
          constructor() { this.db = new DatabaseSync(':memory:'); }
          all() { return this.db.prepare('SELECT * FROM things').all(); }
        }
      `),
      f('app.ts', `
        import { Hono } from 'hono';
        import type { Store } from './db';
        interface Options { store: Store }
        export function createApp({ store }: Options) {
          const app = new Hono();
          app.get('/things', (c) => c.json(store.all()));
          return app;
        }
      `),
    ]);
    expect(r.routes[0].services).toContain('sqlite');
    expect(r.services[0].operations[0].target).toBe('things');
  });
});

describe('journeys cross the browser and server boundary', () => {
  const files = [
    pkg({ next: '15.0.0', openai: '4.0.0' }),
    f('lib/api.ts', 'export function api(path: string, options?: RequestInit) { return fetch(`/api${path}`, options); }'),
    f('components/Ask.tsx', `
      'use client';
      import { api } from '../lib/api';
      export function Ask() {
        async function go() { await api('/ask', { method: 'POST' }); }
        return <button onClick={go}>Ask the model</button>;
      }
    `),
    f('app/page.tsx', `import { Ask } from '../components/Ask';\nexport default function P() { return <Ask />; }`),
    f('app/api/ask/route.ts', `
      import OpenAI from 'openai';
      const openai = new OpenAI();
      export async function POST() {
        const r = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [] });
        return Response.json(r);
      }
    `),
  ];

  it('names the journey with the real button text and reaches the service', () => {
    const r = analyse(files);
    const j = r.journeys[0];
    expect(j.title).toContain('Ask the model');
    expect(j.serviceIds).toContain('openai');
    expect(j.steps.map((s) => s.kind)).toEqual(expect.arrayContaining(['trigger', 'network', 'server', 'service']));
    expect(j.steps.find((s) => s.kind === 'service')?.title).toContain('gpt-4o-mini');
  });

  it('sees a call to your own helper even when a method is chained on its result', () => {
    const r = analyse([
      pkg({ next: '15.0.0' }),
      f('lib/api.ts', `export const post = (u, b) => fetch(u, { method: 'POST', body: JSON.stringify(b) });\nexport async function ask(q) { return (await post('/api/ask', { q })).json(); }`),
      f('app/page.tsx', `'use client';\nimport { ask } from '../lib/api';\nexport default function P() { return <button onClick={() => ask('x')}>Ask</button>; }`),
      f('app/api/ask/route.ts', 'export async function POST() { return new Response("ok"); }'),
    ]);
    expect(r.routes[0].calledBy).toHaveLength(1);
  });

  it('says plainly when nothing catches a failure', () => {
    expect(analyse(files).journeys[0].failure.caught).toBe(false);
  });

  it('shows a gap instead of inventing where a dynamic URL goes', () => {
    const r = analyse([
      pkg({ next: '15.0.0' }),
      f('app/page.tsx', `
        'use client';
        export default function P({ u }) {
          return <button onClick={() => fetch(u)}>Go</button>;
        }
      `),
    ]);
    expect(r.journeys[0].steps.some((s) => s.kind === 'gap')).toBe(true);
    expect(r.routes).toHaveLength(0);
  });
});

describe('auth is judged by what the code does', () => {
  const route = (body: string): VirtualFile[] => [
    pkg({ next: '15.0.0', 'next-auth': '5.0.0', '@supabase/supabase-js': '2.0.0' }),
    f('lib/db.ts', `import { createClient } from '@supabase/supabase-js';\nexport const db = createClient('a', 'b');`),
    f('app/api/x/route.ts', `
      import { getServerSession } from 'next-auth';
      import { db } from '../../../lib/db';
      export async function POST() {
        ${body}
        await db.from('things').delete();
        return new Response();
      }
    `),
  ];

  it('counts a check that stops the request', () => {
    const r = analyse(route(`const session = await getServerSession(); if (!session) return new Response(null, { status: 401 });`));
    expect(r.routes[0].auth.status).toBe('checked');
    expect(r.risks.find((x) => x.rule === 'open-write')).toBeUndefined();
  });

  it('does not count a lookup that stops nobody', () => {
    const r = analyse(route(`const session = await getServerSession(); console.log(session);`));
    expect(r.routes[0].auth.status).toBe('read-only');
    expect(r.risks.find((x) => x.rule === 'auth-not-enforced')).toBeDefined();
  });

  it('flags no check at all', () => {
    const r = analyse(route(''));
    expect(r.routes[0].auth.status).toBe('none');
    expect(r.risks.find((x) => x.rule === 'open-write')).toBeDefined();
  });

  it('accepts Next middleware only where its matcher applies', () => {
    const files = [
      ...route(''),
      f('middleware.ts', `
        import { auth } from 'next-auth';
        export default auth;
        export const config = { matcher: ['/api/x'] };
      `),
    ];
    expect(analyse(files).routes[0].auth.status).toBe('middleware');
    const other = files.map((x) => (x.path === 'middleware.ts' ? { ...x, content: x.content.replace('/api/x', '/admin/:path*') } : x));
    expect(analyse(other).routes[0].auth.status).toBe('none');
  });
});

describe('risks', () => {
  it('treats a Supabase anon key as public and a service role key as a leak', () => {
    const read = (name: string) => f('components/C.tsx', `'use client';\nexport const k = process.env.${name};\nexport default function C() { return <div />; }`);
    const ok = analyse([pkg({ next: '15.0.0' }), read('NEXT_PUBLIC_SUPABASE_ANON_KEY')]);
    expect(ok.risks.find((x) => x.rule === 'public-secret')).toBeUndefined();
    const bad = analyse([pkg({ next: '15.0.0' }), read('NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY')]);
    expect(bad.risks.find((x) => x.rule === 'public-secret')).toBeDefined();
  });

  it('reports hardcoded keys without ever repeating them', () => {
    const key = `sk-${'a1B2c3D4'.repeat(4)}`;
    const r = analyse([pkg({}), f('lib/x.ts', `export const key = "${key}";`)]);
    const risk = r.risks.find((x) => x.rule === 'hardcoded-secret');
    expect(risk).toBeDefined();
    expect(JSON.stringify(r)).not.toContain(key);
  });

  it('flags glued SQL but not tagged templates', () => {
    const r = analyse([
      pkg({ pg: '8.0.0' }),
      f('a.ts', 'export const q = (db, id) => db.query(`SELECT * FROM users WHERE id = ${id}`);'),
      f('b.ts', 'export const s = (sql, id) => sql`SELECT * FROM users WHERE id = ${id}`;'),
    ]);
    const risk = r.risks.find((x) => x.rule === 'sql-injection');
    expect(risk?.evidence.map((e) => e.file)).toEqual(['a.ts']);
  });

  it('reads row level security per table from migrations', () => {
    const r = analyse([
      pkg({ '@supabase/supabase-js': '2.0.0' }),
      f('supabase/migrations/1.sql', `create table public.a (\n  id uuid\n);\ncreate table public.b (\n  id uuid\n);\nalter table public.a enable row level security;\n`),
      f('lib/s.ts', `import { createClient } from '@supabase/supabase-js';\nexport const s = createClient('a', 'b');\nexport const go = () => s.from('b').select();`),
      f('app.ts', `import { go } from './lib/s';\ngo();`),
    ]);
    expect(r.tables.find((t) => t.name === 'a')?.rls).toBe(true);
    expect(r.tables.find((t) => t.name === 'b')?.rls).toBe(false);
  });
});

describe('small pieces', () => {
  it('matches dynamic segments both ways', () => {
    expect(matchRoutePath('/api/items/:id', '/api/items/:p')).toBe(true);
    expect(matchRoutePath('/api/items/:id', '/api/items/42')).toBe(true);
    expect(matchRoutePath('/api/items/:id', '/api/items')).toBe(false);
    expect(matchRoutePath('/api/:rest*', '/api/a/b/c')).toBe(true);
  });

  it('normalises URLs without treating localhost as outside', () => {
    expect(normalizeUrl('https://api.stripe.com/v1/x?y=1')).toEqual({ path: '/v1/x', host: 'api.stripe.com' });
    expect(normalizeUrl('http://localhost:3000/api/x')).toEqual({ path: '/api/x' });
    expect(normalizeUrl(':p/api/x?y=:p')).toEqual({ path: '/api/x' });
  });

  it('masks every secret shape it detects', () => {
    const lines = [
      `const a = "ghp_${'x1Y2'.repeat(10)}"`,
      `password: "hunter2hunter2"`,
      `postgres://admin:s3cret@db.example.com/app`,
    ];
    for (const l of lines) {
      expect(maskSecrets(l)).toMatch(/hidden/);
      expect(maskSecrets(l)).not.toMatch(/x1Y2x1Y2|hunter2hunter2|s3cret/);
    }
    expect(findSecrets('const k = "sk-your-key-here-placeholder-value"')).toHaveLength(0);
  });

  it('drops narration sentences that name things not in the facts', () => {
    const facts = 'Project: lunchbox. Screens: /menu. Outside services: Supabase.';
    const out = checkAgainstFacts('People open /menu and it reads Supabase. Then it calls Redis through src/cache.ts.', facts);
    expect(out.text).toContain('/menu');
    expect(out.dropped).toHaveLength(1);
  });
});
