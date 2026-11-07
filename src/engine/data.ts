import type { Sources } from './files';
import type { Graph } from './graph';
import { argsOf, chainOf, literal } from './model';
import type { Table, Service } from './types';

const SENSITIVE = /password|passwd|secret|token|ssn|credit|card|dob|birth|phone|address|email|salary|medical|health|iban|passport/i;

function field(name: string, type?: string): Table['fields'][number] {
  return { name, type, sensitive: SENSITIVE.test(name) && !/_at$|verified|hash$/i.test(name) ? true : undefined };
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/** Read the shape of your data from the places people actually define it. */
export function findTables(g: Graph, src: Sources): Table[] {
  const tables = new Map<string, Table>();
  const put = (t: Table): void => {
    const key = t.name.toLowerCase();
    const prev = tables.get(key);
    if (!prev || prev.fields.length < t.fields.length) tables.set(key, { ...t, rls: prev?.rls ?? t.rls });
  };

  for (const [path, f] of g.files) {
    if (path.endsWith('.prisma')) {
      for (const m of f.content.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
        const fields = m[2].split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//') && !l.startsWith('@@'))
          .map((l) => l.split(/\s+/)).filter((p) => p.length >= 2 && /^[a-zA-Z_]/.test(p[0])).map((p) => field(p[0], p[1]));
        const line = lineOf(f.content, m.index ?? 0);
        put({ name: m[1], source: 'Prisma schema', fields, evidence: src.evidence(path, line, line + fields.length + 1, 0), rls: null, readers: [], writers: [] });
      }
    }
    if (path.endsWith('.sql')) {
      for (const m of f.content.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\.)?"?(\w+)"?\s*\(([\s\S]*?)\n\s*\)\s*;/gi)) {
        const fields = m[2].split('\n').map((l) => l.trim().replace(/,$/, '')).filter((l) => l && !/^(constraint|primary|foreign|unique|check|--)/i.test(l))
          .map((l) => l.split(/\s+/)).map((p) => field(p[0].replace(/"/g, ''), p[1]));
        const line = lineOf(f.content, m.index ?? 0);
        put({ name: m[1], source: 'SQL migration', fields, evidence: src.evidence(path, line, line + 6, 0), rls: null, readers: [], writers: [] });
      }
    }
  }

  for (const mod of g.modules.values()) {
    for (const u of mod.units.values()) {
      for (const c of u.calls) {
        const chain = chainOf(c);
        const last = chain[chain.length - 1];
        // drizzle: pgTable('users', { ... })
        if (/^(pgTable|sqliteTable|mysqlTable)$/.test(last)) {
          const a = argsOf(c);
          const name = literal(a[0]);
          if (name && a[1]?.k === 'obj') {
            put({ name, source: 'Drizzle schema', fields: Object.keys(a[1].props).map((n) => field(n)), evidence: src.evidence(mod.file, c.line, c.endLine, 0), rls: null, readers: [], writers: [] });
          }
        }
        // mongoose: new Schema({ ... }) assigned to a model name
        if (c.isNew && last === 'Schema') {
          const a = argsOf(c)[0];
          if (a?.k === 'obj') {
            const name = mod.file.split('/').pop()!.replace(/\.[a-z]+$/, '');
            put({ name, source: 'Mongoose schema', fields: Object.keys(a.props).map((n) => field(n)), evidence: src.evidence(mod.file, c.line, c.endLine, 0), rls: null, readers: [], writers: [] });
          }
        }
      }
    }
  }

  // Row level security is read from migrations, per table.
  const sqlText = [...g.files.entries()].filter(([p]) => p.endsWith('.sql')).map(([, f]) => f.content).join('\n');
  if (sqlText) {
    for (const t of tables.values()) {
      if (t.source !== 'SQL migration') continue;
      const re = new RegExp(`alter\\s+table\\s+(?:"?public"?\\.)?"?${t.name}"?\\s+enable\\s+row\\s+level\\s+security`, 'i');
      t.rls = re.test(sqlText);
    }
  }
  return [...tables.values()].slice(0, 80);
}

export function linkTables(tables: Table[], services: Service[]): void {
  const find = (name: string): Table | undefined => {
    const n = name.toLowerCase();
    return tables.find((t) => t.name.toLowerCase() === n || `${t.name.toLowerCase()}s` === n || t.name.toLowerCase() === `${n}s`);
  };
  for (const s of services) {
    if (s.kind !== 'database') continue;
    for (const op of s.operations) {
      if (!op.target) continue;
      const t = find(op.target);
      if (!t) continue;
      const list = op.access === 'write' ? t.writers : t.readers;
      if (!list.includes(op.evidence.file)) list.push(op.evidence.file);
    }
  }
}
