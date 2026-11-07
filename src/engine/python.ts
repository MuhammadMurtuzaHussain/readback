import { newUnit } from './model';
import type { CallPart, CallSite, Decorator, Module, Unit, Value } from './model';

/**
 * Python is read through tree-sitter and mapped onto the same code model as
 * JavaScript, so every later stage is language-blind.
 *
 * tree-sitter is injected rather than imported because the browser and Node
 * have to load its WASM in different ways.
 */
export interface TSNode {
  type: string;
  text: string;
  startPosition: { row: number };
  endPosition: { row: number };
  namedChildren: TSNode[];
  children: TSNode[];
  childForFieldName(name: string): TSNode | null;
}

export type PyParse = (source: string) => TSNode;

interface Ctx {
  unit: Unit;
  mod: Module;
  inTry: boolean;
  className?: string;
  n: { v: number };
}

const line = (n: TSNode): number => n.startPosition.row + 1;
const endLine = (n: TSNode): number => n.endPosition.row + 1;

export function parsePython(file: string, source: string, parse: PyParse): Module {
  const root = newUnit(file, `${file}#module`, file.split('/').pop() ?? file, 1, source.split('\n').length, 'module');
  const mod: Module = {
    file, language: 'python', units: new Map([[root.id, root]]), root,
    imports: [], exports: [], starExports: [], dynamicImports: [], env: [], notable: [],
    lines: source.split('\n').length, interfaces: new Map(), typeAliases: new Map(), classFields: new Map(), classFieldTypes: new Map(), classes: new Set(),
  };
  const tree = parse(source);
  const ctx: Ctx = { unit: root, mod, inTry: false, n: { v: 0 } };
  const first = tree.namedChildren[0];
  if (first?.type === 'expression_statement' && first.namedChildren[0]?.type === 'string') {
    const doc = first.namedChildren[0].text.replace(/^[rbuRBU]*("""|'''|"|')|("""|'''|"|')$/g, '').replace(/\s+/g, ' ').trim();
    if (doc.length >= 12) mod.ownWords = doc.slice(0, 220);
  }
  for (const c of tree.namedChildren) stmt(c, ctx);

  // Everything at module level is importable.
  for (const name of root.locals.keys()) mod.exports.push({ name, value: { k: 'ident', name }, line: 1 });
  return mod;
}

function stmt(n: TSNode, ctx: Ctx): void {
  switch (n.type) {
    case 'import_statement':
      for (const c of n.namedChildren) {
        if (c.type === 'dotted_name') ctx.mod.imports.push({ local: c.text.split('.')[0], source: c.text, imported: '*', line: line(n), typeOnly: false });
        else if (c.type === 'aliased_import') {
          const name = c.childForFieldName('name')?.text ?? '';
          const alias = c.childForFieldName('alias')?.text ?? name;
          ctx.mod.imports.push({ local: alias, source: name, imported: '*', line: line(n), typeOnly: false });
        }
      }
      return;
    case 'import_from_statement': {
      const source = n.childForFieldName('module_name')?.text ?? '';
      const names: TSNode[] = [];
      for (const c of n.namedChildren) if (c !== n.childForFieldName('module_name') && (c.type === 'dotted_name' || c.type === 'aliased_import')) names.push(c);
      for (const c of names) {
        if (c.type === 'aliased_import') {
          const name = c.childForFieldName('name')?.text ?? '';
          ctx.mod.imports.push({ local: c.childForFieldName('alias')?.text ?? name, source, imported: name, line: line(n), typeOnly: false });
        } else {
          ctx.mod.imports.push({ local: c.text, source, imported: c.text, line: line(n), typeOnly: false });
        }
      }
      return;
    }
    case 'decorated_definition': {
      const decorators: Decorator[] = [];
      for (const d of n.namedChildren) {
        if (d.type !== 'decorator') continue;
        const e = d.namedChildren[0];
        if (e?.type === 'call') {
          const fn = e.childForFieldName('function');
          decorators.push({ name: fn?.text ?? '', args: args(e, ctx), line: line(d) });
        } else if (e) {
          decorators.push({ name: e.text, args: [], line: line(d) });
        }
      }
      const def = n.childForFieldName('definition');
      if (def?.type === 'function_definition') fn(def, ctx, decorators);
      else if (def?.type === 'class_definition') cls(def, ctx);
      return;
    }
    case 'function_definition':
      fn(n, ctx, []);
      return;
    case 'class_definition':
      cls(n, ctx);
      return;
    case 'expression_statement':
      for (const c of n.namedChildren) expr(c, ctx);
      return;
    case 'return_statement':
      for (const c of n.namedChildren) ctx.unit.returns.push(expr(c, ctx));
      return;
    case 'try_statement': {
      const body = n.childForFieldName('body');
      if (body) for (const c of body.namedChildren) stmt(c, { ...ctx, inTry: true });
      for (const c of n.namedChildren) if (c !== body) walkBlock(c, ctx);
      return;
    }
    case 'if_statement': {
      const cond = n.childForFieldName('condition');
      const cons = n.childForFieldName('consequence');
      if (cond?.text.replace(/\s/g, '').match(/^__name__==['"]__main__['"]$/)) {
        ctx.mod.notable.push({ kind: 'child-process', line: -1, detail: 'main' });
      }
      if (cond) expr(cond, ctx);
      if (cons && cons.namedChildren.some((c) => c.type === 'return_statement' || c.type === 'raise_statement')) {
        const idents = new Set<string>();
        identifiers(cond, idents);
        ctx.unit.guards.push({ line: line(n), idents: [...idents] });
      }
      for (const c of n.namedChildren) if (c !== cond) walkBlock(c, ctx);
      return;
    }
    default:
      walkBlock(n, ctx);
  }
}

function identifiers(n: TSNode | null, out: Set<string>): void {
  if (!n) return;
  if (n.type === 'identifier') out.add(n.text);
  for (const c of n.namedChildren) identifiers(c, out);
}

function walkBlock(n: TSNode, ctx: Ctx): void {
  if (/_statement$|^block$|_clause$|^with_item$|^with_clause$/.test(n.type) && n.type !== 'expression_statement') {
    for (const c of n.namedChildren) stmt(c, ctx);
    return;
  }
  expr(n, ctx);
}

function fn(n: TSNode, ctx: Ctx, decorators: Decorator[]): void {
  const raw = n.childForFieldName('name')?.text ?? 'anonymous';
  const name = ctx.className ? `${ctx.className}.${raw}` : raw;
  ctx.n.v++;
  const id = `${ctx.mod.file}#${name}@${line(n)}:${ctx.n.v}`;
  const unit = newUnit(ctx.mod.file, id, name, line(n), endLine(n), 'fn', ctx.unit.id);
  unit.decorators = decorators;
  unit.className = ctx.className;
  unit.async = n.children.some((c) => c.type === 'async');
  ctx.mod.units.set(id, unit);
  ctx.unit.locals.set(raw, { k: 'fn', unit: id });

  const params = n.childForFieldName('parameters');
  for (const p of params?.namedChildren ?? []) {
    if (p.type === 'identifier') {
      if (p.text !== 'self' && p.text !== 'cls') unit.params.push(p.text);
    } else if (p.type === 'typed_parameter' || p.type === 'typed_default_parameter' || p.type === 'default_parameter') {
      const nameNode = p.childForFieldName('name') ?? p.namedChildren[0];
      const pname = nameNode?.text ?? '';
      if (pname && pname !== 'self') unit.params.push(pname);
      const typeNode = p.childForFieldName('type') ?? p.namedChildren.find((c) => c.type === 'type');
      if (typeNode) unit.paramTypes.set(pname, typeNode.text.split('[')[0]);
      const value = p.childForFieldName('value');
      if (value?.type === 'call' && value.childForFieldName('function')?.text === 'Depends') {
        const dep = value.childForFieldName('arguments')?.namedChildren[0]?.text;
        if (dep) unit.decorators.push({ name: `Depends:${dep}`, args: [], line: line(p) });
      }
    }
  }
  const body = n.childForFieldName('body');
  const inner: Ctx = { ...ctx, unit, inTry: false, className: undefined };
  // className must stay visible for self.x inside methods, through the unit.
  for (const c of body?.namedChildren ?? []) stmt(c, inner);
}

function cls(n: TSNode, ctx: Ctx): void {
  const name = n.childForFieldName('name')?.text ?? 'Anonymous';
  ctx.mod.classes.add(name);
  const supers = n.childForFieldName('superclasses')?.text ?? '';
  if (/BaseModel|SQLModel/.test(supers)) ctx.mod.typeAliases.set(`pydantic:${name}`, 'yes');
  ctx.unit.locals.set(name, { k: 'class', name });
  const body = n.childForFieldName('body');
  const inner = { ...ctx, className: name };
  for (const c of body?.namedChildren ?? []) {
    if (c.type === 'function_definition') fn(c, inner, []);
    else if (c.type === 'decorated_definition') stmt(c, inner);
    else stmt(c, ctx);
  }
}

function stringValue(n: TSNode, ctx: Ctx): Value {
  const interp = n.namedChildren.filter((c) => c.type === 'interpolation');
  const content = n.text.replace(/^[rbuRBUfF]*("""|'''|"|')/, '').replace(/("""|'''|"|')$/, '');
  if (!interp.length) return { k: 'str', v: content };
  let v = content;
  const idents: string[] = [];
  for (const i of interp) {
    v = v.replace(i.text, ':p');
    const inner = i.namedChildren[0];
    if (inner?.type === 'identifier') idents.push(inner.text);
    if (inner) expr(inner, ctx);
  }
  return { k: 'tpl', v, lead: v.startsWith(':p'), holes: interp.length, idents };
}

function chain(n: TSNode): string[] | null {
  if (n.type === 'identifier') return [n.text === 'self' ? 'this' : n.text];
  if (n.type === 'attribute') {
    const obj = n.childForFieldName('object');
    const attr = n.childForFieldName('attribute');
    const base = obj ? chain(obj) : null;
    return base && attr ? [...base, attr.text] : null;
  }
  return null;
}

function args(call: TSNode, ctx: Ctx): Value[] {
  const out: Value[] = [];
  const kw: Record<string, Value> = {};
  const list = call.childForFieldName('arguments');
  if (!list) return out;
  if (list.type === 'string') return [stringValue(list, ctx)];
  for (const a of list.namedChildren) {
    if (a.type === 'keyword_argument') {
      const name = a.childForFieldName('name')?.text;
      const value = a.childForFieldName('value');
      if (name && value) kw[name] = expr(value, ctx);
    } else if (a.type !== 'comment') {
      out.push(expr(a, ctx));
    }
  }
  if (Object.keys(kw).length) out.push({ k: 'obj', props: kw });
  return out;
}

function callSite(n: TSNode, ctx: Ctx): CallSite {
  const stack: CallPart[] = [];
  let cur: TSNode | null = n;
  while (cur) {
    if (cur.type === 'call') {
      const f: TSNode | null = cur.childForFieldName('function');
      const a = args(cur, ctx);
      if (f?.type === 'attribute') {
        stack.push({ name: f.childForFieldName('attribute')?.text ?? '', args: a });
        cur = f.childForFieldName('object');
      } else if (f?.type === 'identifier') {
        stack.push({ name: f.text, args: a });
        cur = null;
      } else {
        stack.push({ name: '(expr)', args: a });
        cur = null;
      }
    } else if (cur.type === 'attribute') {
      stack.push({ name: cur.childForFieldName('attribute')?.text ?? '' });
      cur = cur.childForFieldName('object');
    } else if (cur.type === 'identifier') {
      stack.push({ name: cur.text === 'self' ? 'this' : cur.text });
      cur = null;
    } else {
      stack.push({ name: '(expr)' });
      expr(cur, ctx);
      cur = null;
    }
  }
  const site: CallSite = { parts: stack.reverse(), isNew: false, line: line(n), endLine: endLine(n), inTry: ctx.inTry, unit: ctx.unit.id };
  ctx.unit.calls.push(site);
  noteEnv(site, ctx);
  noteSql(site, ctx);
  return site;
}

function noteEnv(site: CallSite, ctx: Ctx): void {
  const names = site.parts.map((p) => p.name).join('.');
  if (/^os\.(getenv|environ\.get)$/.test(names)) {
    const a = site.parts[site.parts.length - 1].args?.[0];
    if (a?.k === 'str') ctx.mod.env.push({ name: a.v, line: site.line });
  }
}

function noteSql(site: CallSite, ctx: Ctx): void {
  const last = site.parts[site.parts.length - 1];
  for (const a of last.args ?? []) {
    if (a.k === 'tpl' && a.holes > 0 && /^\s*(select|insert\s+into|update|delete\s+from)\b/i.test(a.v)) {
      ctx.mod.notable.push({ kind: 'sql-interpolated', line: site.line, detail: a.v.slice(0, 80) });
    }
  }
}

function assign(n: TSNode, ctx: Ctx): void {
  const left = n.childForFieldName('left');
  const right = n.childForFieldName('right');
  if (!left || !right) return;
  const v = expr(right, ctx);
  if (left.type === 'identifier') ctx.unit.locals.set(left.text, v);
  else if (left.type === 'attribute') {
    const c = chain(left);
    if (c?.[0] === 'this' && c.length === 2) {
      let u: Unit | undefined = ctx.unit;
      while (u && !u.className) u = u.parent ? ctx.mod.units.get(u.parent) : undefined;
      if (u?.className && v.k !== 'unknown') ctx.mod.classFields.set(`${u.className}.${c[1]}`, { value: v, unit: ctx.unit.id });
    }
  } else if (left.type === 'pattern_list') {
    left.namedChildren.forEach((c, i) => {
      if (c.type === 'identifier') ctx.unit.locals.set(c.text, { k: 'pick', from: v, key: String(i) });
    });
  }
}

function expr(n: TSNode, ctx: Ctx): Value {
  switch (n.type) {
    case 'string':
    case 'concatenated_string':
      return n.type === 'string' ? stringValue(n, ctx) : { k: 'str', v: n.text.replace(/["']/g, '') };
    case 'integer':
    case 'float':
      return { k: 'num', v: Number(n.text) };
    case 'true':
      return { k: 'bool', v: true };
    case 'false':
      return { k: 'bool', v: false };
    case 'identifier':
      return { k: 'ident', name: n.text === 'self' ? 'this' : n.text };
    case 'attribute': {
      const c = chain(n);
      if (c) return { k: 'member', chain: c };
      return { k: 'unknown' };
    }
    case 'call':
      return { k: 'call', call: callSite(n, ctx) };
    case 'await':
      return n.namedChildren[0] ? expr(n.namedChildren[0], ctx) : { k: 'unknown' };
    case 'assignment':
      assign(n, ctx);
      return { k: 'unknown' };
    case 'parenthesized_expression':
      return n.namedChildren[0] ? expr(n.namedChildren[0], ctx) : { k: 'unknown' };
    case 'subscript': {
      const base = n.childForFieldName('value');
      const c = base ? chain(base) : null;
      if (c?.join('.') === 'os.environ') {
        const key = n.childForFieldName('subscript');
        if (key?.type === 'string') {
          const v = stringValue(key, ctx);
          if (v.k === 'str') ctx.mod.env.push({ name: v.v, line: line(n) });
        }
      }
      return { k: 'unknown' };
    }
    case 'dictionary': {
      const props: Record<string, Value> = {};
      for (const p of n.namedChildren) {
        if (p.type !== 'pair') continue;
        const key = p.childForFieldName('key');
        const value = p.childForFieldName('value');
        if (key?.type === 'string' && value) {
          const k = stringValue(key, ctx);
          if (k.k === 'str') props[k.v] = expr(value, ctx);
        }
      }
      return { k: 'obj', props };
    }
    case 'list':
      return { k: 'arr', items: n.namedChildren.map((c) => expr(c, ctx)) };
    case 'binary_operator': {
      const l = n.childForFieldName('left');
      const r = n.childForFieldName('right');
      if (n.children.some((c) => c.type === '+') && l && r) {
        const a = expr(l, ctx);
        const b = expr(r, ctx);
        const text = (x: Value): string => (x.k === 'str' || x.k === 'tpl' ? x.v : ':p');
        const holes = (x: Value): number => (x.k === 'tpl' ? x.holes : x.k === 'str' ? 0 : 1);
        return { k: 'tpl', v: text(a) + text(b), lead: a.k !== 'str', holes: holes(a) + holes(b), idents: [] };
      }
      for (const c of n.namedChildren) expr(c, ctx);
      return { k: 'unknown' };
    }
    case 'lambda': {
      ctx.n.v++;
      const id = `${ctx.mod.file}#anonymous@${line(n)}:${ctx.n.v}`;
      const unit = newUnit(ctx.mod.file, id, 'anonymous', line(n), endLine(n), 'fn', ctx.unit.id);
      ctx.mod.units.set(id, unit);
      const body = n.childForFieldName('body');
      if (body) unit.returns.push(expr(body, { ...ctx, unit }));
      ctx.unit.inline.push(id);
      return { k: 'fn', unit: id };
    }
    default:
      for (const c of n.namedChildren) {
        if (/statement$|_clause$/.test(c.type)) stmt(c, ctx);
        else expr(c, ctx);
      }
      return { k: 'unknown' };
  }
}
