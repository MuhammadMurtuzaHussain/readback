import { parse } from '@babel/parser';
import { newUnit } from './model';
import type { CallPart, CallSite, Decorator, JsxUse, Module, Trigger, Unit, Value } from './model';

const WRAPPER_HOOKS = new Set(['useCallback', 'useMemo', 'memo', 'forwardRef', 'observer', 'cache', 'unstable_cache', 'React.memo', 'React.forwardRef', 'React.useCallback', 'React.useMemo']);
const LOAD_HOOKS = new Set(['useEffect', 'useLayoutEffect', 'onMount', 'onMounted', 'React.useEffect']);
const SQL_START = /^\s*(select|insert\s+into|update|delete\s+from|drop|alter)\b/i;
const SQL_SHAPE = /\b(select\b[\s\S]+\bfrom\b|insert\s+into\b|update\b[\s\S]+\bset\b|delete\s+from\b)/i;

function plugins(file: string): any[] {
  const isTs = /\.(ts|tsx|mts|cts|vue|svelte|astro)$/.test(file);
  const isJsx = !/\.(ts|mts|cts)$/.test(file);
  const out: any[] = ['decorators'];
  if (isTs) out.push('typescript');
  if (isJsx) out.push('jsx');
  return out;
}

function line(n: any): number {
  return n?.loc?.start?.line ?? 1;
}
function endLine(n: any): number {
  return n?.loc?.end?.line ?? line(n);
}

/** For .vue/.svelte/.astro: keep only script content, on its original lines. */
export function extractScript(source: string): string {
  const out = source.split('\n').map(() => '');
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>|^---\n([\s\S]*?)\n---/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const body = m[1] ?? m[2] ?? '';
    const startLine = source.slice(0, m.index + m[0].indexOf(body)).split('\n').length - 1;
    body.split('\n').forEach((l, i) => {
      if (out[startLine + i] !== undefined) out[startLine + i] = l;
    });
  }
  return out.join('\n');
}

export function parseJs(file: string, source: string): Module {
  const root = newUnit(file, `${file}#module`, file.split('/').pop() ?? file, 1, source.split('\n').length, 'module');
  const mod: Module = {
    file, language: 'js', units: new Map([[root.id, root]]), root,
    imports: [], exports: [], starExports: [], dynamicImports: [], env: [], notable: [],
    lines: source.split('\n').length,
    interfaces: new Map(), typeAliases: new Map(), classFields: new Map(), classFieldTypes: new Map(), classes: new Set(),
  };

  let ast: any;
  try {
    ast = parse(source, {
      sourceType: 'unambiguous',
      errorRecovery: true,
      plugins: plugins(file),
      createParenthesizedExpressions: false,
    } as any);
  } catch (err: any) {
    mod.parseError = String(err?.message ?? err).slice(0, 160);
    return mod;
  }

  const program = ast.program;
  for (const d of program.directives ?? []) {
    const v = d.value?.value;
    if (v === 'use client' || v === 'use server') mod.directive = v;
  }
  root.directive = mod.directive;

  const comments: any[] = ast.comments ?? [];
  mod.ownWords = leadingComment(comments, program);
  for (const c of comments) {
    if (/\b(todo|fixme|hack|xxx)\b.*\b(auth|secur|valid|sanitiz|rate.?limit|permission|password|encrypt)/i.test(c.value)) {
      mod.notable.push({ kind: 'todo-security', line: line(c), detail: c.value.trim().slice(0, 120) });
    }
  }

  let anon = 0;
  const ctx: Ctx = { unit: root, inTry: false, mod, nextAnon: () => ++anon, className: undefined };

  for (const stmt of program.body) statement(stmt, ctx);
  return mod;
}

function leadingComment(comments: any[], program: any): string | undefined {
  const first = program.body[0];
  const firstLine = first ? line(first) : Infinity;
  const c = comments.find((x) => line(x) <= firstLine + 1 && !/eslint|prettier|ts-|@flow|biome|license|copyright|^\s*!/i.test(x.value));
  if (!c) return undefined;
  const text = c.value.replace(/^\*+/gm, '').replace(/^\s*\*\s?/gm, '').replace(/\s+/g, ' ').trim();
  return text.length >= 12 ? text.slice(0, 220) : undefined;
}

interface Ctx {
  unit: Unit;
  inTry: boolean;
  mod: Module;
  nextAnon: () => number;
  className?: string;
  classDecorators?: Decorator[];
}

function statement(n: any, ctx: Ctx): void {
  if (!n) return;
  switch (n.type) {
    case 'ImportDeclaration':
      return importDecl(n, ctx);
    case 'ExportNamedDeclaration':
      return exportNamed(n, ctx);
    case 'ExportDefaultDeclaration':
      return exportDefault(n, ctx);
    case 'ExportAllDeclaration':
      ctx.mod.starExports.push(n.source.value);
      return;
    case 'TSExportAssignment':
      ctx.mod.exports.push({ name: 'default', value: expr(n.expression, ctx), line: line(n) });
      return;
    default:
      visit(n, ctx);
  }
}

function importDecl(n: any, ctx: Ctx): void {
  const typeOnly = n.importKind === 'type';
  for (const s of n.specifiers ?? []) {
    const imported = s.type === 'ImportDefaultSpecifier' ? 'default' : s.type === 'ImportNamespaceSpecifier' ? '*' : (s.imported.name ?? s.imported.value);
    ctx.mod.imports.push({ local: s.local.name, source: n.source.value, imported, line: line(n), typeOnly: typeOnly || s.importKind === 'type' });
  }
  if (!n.specifiers?.length) ctx.mod.imports.push({ local: '', source: n.source.value, imported: '', line: line(n), typeOnly });
}

function typeName(t: any): string | undefined {
  const a = t?.type === 'TSTypeAnnotation' ? t.typeAnnotation : t;
  if (!a) return undefined;
  if (a.type === 'TSTypeReference') return a.typeName?.name ?? a.typeName?.right?.name;
  if (a.type === 'TSTypeQuery') return `typeof ${a.exprName?.name ?? ''}`;
  if (a.type === 'TSUnionType') {
    for (const x of a.types) {
      const n = typeName(x);
      if (n) return n;
    }
  }
  return undefined;
}

function recordType(d: any, ctx: Ctx): void {
  const fields = (members: any[]): Map<string, string> => {
    const m = new Map<string, string>();
    for (const x of members ?? []) {
      if (x.type !== 'TSPropertySignature') continue;
      const key = x.key?.name ?? x.key?.value;
      const t = typeName(x.typeAnnotation);
      if (key && t) m.set(String(key), t);
    }
    return m;
  };
  if (d.type === 'TSInterfaceDeclaration') ctx.mod.interfaces.set(d.id.name, fields(d.body?.body));
  else if (d.type === 'TSTypeAliasDeclaration') {
    if (d.typeAnnotation?.type === 'TSTypeLiteral') ctx.mod.interfaces.set(d.id.name, fields(d.typeAnnotation.members));
    else {
      const t = typeName(d.typeAnnotation);
      if (t) ctx.mod.typeAliases.set(d.id.name, t);
    }
  }
}

function exportNamed(n: any, ctx: Ctx): void {
  if (n.declaration && /^TS/.test(n.declaration.type)) recordType(n.declaration, ctx);
  if (n.exportKind === 'type') return;
  if (n.source) {
    for (const s of n.specifiers ?? []) {
      const name = s.exported.name ?? s.exported.value;
      const imported = s.local?.name ?? s.local?.value ?? 'default';
      ctx.mod.exports.push({ name, source: n.source.value, imported, line: line(n) });
    }
    return;
  }
  if (n.declaration) {
    const d = n.declaration;
    if (d.type === 'FunctionDeclaration') {
      const id = fnUnit(d, ctx, d.id?.name);
      ctx.mod.exports.push({ name: d.id.name, value: { k: 'fn', unit: id }, line: line(n) });
      ctx.unit.locals.set(d.id.name, { k: 'fn', unit: id });
    } else if (d.type === 'VariableDeclaration') {
      for (const v of d.declarations) {
        declarator(v, ctx);
        if (v.id.type === 'Identifier') {
          ctx.mod.exports.push({ name: v.id.name, value: { k: 'ident', name: v.id.name }, line: line(n) });
        }
      }
    } else if (d.type === 'ClassDeclaration') {
      classDecl(d, ctx);
      if (d.id) ctx.mod.exports.push({ name: d.id.name, value: { k: 'ident', name: d.id.name }, line: line(n) });
    } else if (!/^TS/.test(d.type)) {
      visit(d, ctx);
    }
    return;
  }
  for (const s of n.specifiers ?? []) {
    const name = s.exported.name ?? s.exported.value;
    ctx.mod.exports.push({ name, value: { k: 'ident', name: s.local.name }, line: line(n) });
  }
}

function exportDefault(n: any, ctx: Ctx): void {
  const d = n.declaration;
  if (d.type === 'FunctionDeclaration') {
    const id = fnUnit(d, ctx, d.id?.name ?? 'default');
    if (d.id) ctx.unit.locals.set(d.id.name, { k: 'fn', unit: id });
    ctx.mod.exports.push({ name: 'default', value: { k: 'fn', unit: id }, line: line(n) });
  } else if (d.type === 'ClassDeclaration') {
    classDecl(d, ctx);
    ctx.mod.exports.push({ name: 'default', value: { k: 'ident', name: d.id?.name ?? 'default' }, line: line(n) });
  } else {
    ctx.mod.exports.push({ name: 'default', value: expr(d, ctx, 'default'), line: line(n) });
  }
}

function classDecl(n: any, ctx: Ctx): void {
  const name = n.id?.name ?? 'Anonymous';
  const decorators = decoratorsOf(n, ctx);
  ctx.mod.classes.add(name);
  for (const m of n.body?.body ?? []) {
    if (m.type === 'ClassMethod' || m.type === 'ClassPrivateMethod') {
      const key = m.key?.name ?? m.key?.id?.name ?? 'method';
      for (const p of m.params ?? []) {
        if (p.type === 'TSParameterProperty') {
          const inner = p.parameter?.type === 'AssignmentPattern' ? p.parameter.left : p.parameter;
          const t = typeName(inner?.typeAnnotation);
          if (inner?.name && t) ctx.mod.classFieldTypes.set(`${name}.${inner.name}`, t);
        }
      }
      fnUnit(m, { ...ctx, className: name, classDecorators: decorators }, `${name}.${key}`);
    } else if (m.type === 'ClassProperty' || m.type === 'ClassPrivateProperty') {
      const key = m.key?.name ?? m.key?.id?.name;
      const t = typeName(m.typeAnnotation);
      if (key && t) ctx.mod.classFieldTypes.set(`${name}.${key}`, t);
      if (!m.value) continue;
      if (m.value.type === 'ArrowFunctionExpression' || m.value.type === 'FunctionExpression') {
        fnUnit(m.value, { ...ctx, className: name, classDecorators: decorators }, `${name}.${key ?? 'prop'}`);
      } else {
        const v = expr(m.value, ctx);
        if (key) ctx.mod.classFields.set(`${name}.${key}`, { value: v, unit: ctx.unit.id });
      }
    }
  }
  if (n.id) ctx.unit.locals.set(n.id.name, { k: 'class', name });
}

function decoratorsOf(n: any, ctx: Ctx): Decorator[] {
  const out: Decorator[] = [];
  for (const d of n.decorators ?? []) {
    const e = d.expression;
    if (e?.type === 'CallExpression' && e.callee?.type === 'Identifier') {
      out.push({ name: e.callee.name, args: e.arguments.map((a: any) => expr(a, ctx)), line: line(d) });
    } else if (e?.type === 'Identifier') {
      out.push({ name: e.name, args: [], line: line(d) });
    }
  }
  return out;
}

/** Create a Unit for any function-like node and walk its body. */
function fnUnit(n: any, ctx: Ctx, hint?: string): string {
  const num = ctx.nextAnon();
  const name = hint ?? (n.id?.name as string | undefined) ?? `anonymous`;
  const id = `${ctx.mod.file}#${name}@${line(n)}:${num}`;
  const unit = newUnit(ctx.mod.file, id, name, line(n), endLine(n), 'fn', ctx.unit.id);
  unit.async = !!n.async;
  unit.className = ctx.className;
  unit.classDecorators = ctx.classDecorators;
  unit.decorators = decoratorsOf(n, ctx);
  unit.isComponent = /^[A-Z]/.test(name.split('.').pop() ?? '');
  ctx.mod.units.set(id, unit);
  for (const p of n.params ?? []) {
    collectParam(p, unit);
    collectParamType(p, unit);
  }
  const inner: Ctx = { ...ctx, unit, inTry: false, className: undefined, classDecorators: undefined };
  const body = n.body;
  for (const d of body?.directives ?? []) {
    const v = d.value?.value;
    if (v === 'use client' || v === 'use server') unit.directive = v;
  }
  if (body?.type === 'BlockStatement') {
    for (const s of body.body) visit(s, inner);
  } else if (body) {
    unit.returns.push(expr(body, inner));
  }
  return id;
}

function collectParamType(p: any, unit: Unit): void {
  if (!p) return;
  if (p.type === 'TSParameterProperty') return collectParamType(p.parameter, unit);
  if (p.type === 'AssignmentPattern') {
    const right = unwrap(p.right);
    if (p.left.type === 'Identifier') {
      if (right?.type === 'Identifier' && right.name === 'fetch') unit.paramTypes.set(p.left.name, 'typeof fetch');
      else if (right?.type === 'NewExpression' && right.callee?.name) unit.paramTypes.set(p.left.name, right.callee.name);
    }
    collectParamType(p.left, unit);
    return;
  }
  if (p.type === 'Identifier') {
    const t = typeName(p.typeAnnotation);
    if (t && !unit.paramTypes.has(p.name)) unit.paramTypes.set(p.name, t);
    return;
  }
  if (p.type === 'ObjectPattern') {
    const t = typeName(p.typeAnnotation);
    for (const prop of p.properties) {
      if (prop.type !== 'ObjectProperty') continue;
      const key = prop.key?.name;
      const v = prop.value.type === 'AssignmentPattern' ? prop.value.left : prop.value;
      if (prop.value.type === 'AssignmentPattern' && unwrap(prop.value.right)?.name === 'fetch' && v.name) unit.paramTypes.set(v.name, 'typeof fetch');
      else if (t && key && v.type === 'Identifier') unit.paramTypes.set(v.name, `${t}.${key}`);
    }
  }
}

function collectParam(p: any, unit: Unit): void {
  if (!p) return;
  if (p.type === 'Identifier') unit.params.push(p.name);
  else if (p.type === 'AssignmentPattern') collectParam(p.left, unit);
  else if (p.type === 'RestElement') collectParam(p.argument, unit);
  else if (p.type === 'TSParameterProperty') collectParam(p.parameter, unit);
  else if (p.type === 'ObjectPattern') {
    for (const prop of p.properties) {
      if (prop.type === 'ObjectProperty') collectParam(prop.value, unit);
      else if (prop.type === 'RestElement') collectParam(prop.argument, unit);
    }
  } else if (p.type === 'ArrayPattern') {
    for (const el of p.elements) collectParam(el, unit);
  }
}

function bindPattern(p: any, value: Value, ctx: Ctx): void {
  if (!p) return;
  if (p.type === 'Identifier') {
    ctx.unit.locals.set(p.name, value);
  } else if (p.type === 'ObjectPattern') {
    for (const prop of p.properties) {
      if (prop.type !== 'ObjectProperty') continue;
      const key = prop.key?.name ?? prop.key?.value;
      if (key !== undefined) bindPattern(prop.value, { k: 'pick', from: value, key: String(key) }, ctx);
    }
  } else if (p.type === 'ArrayPattern') {
    p.elements.forEach((el: any, i: number) => bindPattern(el, { k: 'pick', from: value, key: String(i) }, ctx));
  } else if (p.type === 'AssignmentPattern') {
    bindPattern(p.left, value, ctx);
  }
}

function declarator(v: any, ctx: Ctx): void {
  const init = unwrap(v.init);
  if (!init) return;
  // const x = require('y')
  if (isRequire(init)) {
    const source = init.arguments[0]?.value;
    if (typeof source === 'string') {
      if (v.id.type === 'Identifier') {
        ctx.mod.imports.push({ local: v.id.name, source, imported: 'module.exports', line: line(v), typeOnly: false });
      } else if (v.id.type === 'ObjectPattern') {
        for (const prop of v.id.properties) {
          if (prop.type === 'ObjectProperty' && prop.value.type === 'Identifier') {
            ctx.mod.imports.push({ local: prop.value.name, source, imported: prop.key.name, line: line(v), typeOnly: false });
          }
        }
      }
    }
    return;
  }
  // const Page = lazy(() => import('./Page'))
  const lazySource = lazyImport(init);
  if (lazySource && v.id.type === 'Identifier') {
    ctx.mod.imports.push({ local: v.id.name, source: lazySource, imported: 'default', line: line(v), typeOnly: false });
    ctx.mod.dynamicImports.push({ source: lazySource, line: line(v) });
    return;
  }
  const hint = v.id.type === 'Identifier' ? v.id.name : undefined;
  const value = expr(init, ctx, hint);
  bindPattern(v.id, value, ctx);
  // const { A, B } = process.env
  if (v.id.type === 'ObjectPattern' && isProcessEnv(init)) {
    for (const prop of v.id.properties) {
      if (prop.type === 'ObjectProperty' && prop.key?.name) ctx.mod.env.push({ name: prop.key.name, line: line(prop) });
    }
  }
}

function isRequire(n: any): boolean {
  return n?.type === 'CallExpression' && n.callee?.type === 'Identifier' && n.callee.name === 'require';
}

function isProcessEnv(n: any): boolean {
  return n?.type === 'MemberExpression' && n.object?.name === 'process' && n.property?.name === 'env';
}

function lazyImport(n: any): string | null {
  if (n?.type !== 'CallExpression') return null;
  const fn = n.arguments?.[0];
  if (!fn || (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression')) return null;
  const callee = fn.body?.type === 'BlockStatement' ? null : fn.body;
  const inner = callee?.type === 'CallExpression' && callee.callee?.type === 'MemberExpression' ? callee.callee.object : callee;
  if (inner?.type === 'CallExpression' && inner.callee?.type === 'Import') return inner.arguments[0]?.value ?? null;
  if (inner?.type === 'ImportExpression') return inner.source?.value ?? null;
  return null;
}

function unwrap(n: any): any {
  let cur = n;
  while (cur) {
    switch (cur.type) {
      case 'AwaitExpression':
        cur = cur.argument;
        break;
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
      case 'TSNonNullExpression':
      case 'TSTypeAssertion':
      case 'ParenthesizedExpression':
      case 'ChainExpression':
        cur = cur.expression;
        break;
      default:
        return cur;
    }
  }
  return cur;
}

/** Turn an expression into a Value, walking anything nested inside it. */
function expr(raw: any, ctx: Ctx, hint?: string): Value {
  const n = unwrap(raw);
  if (!n) return { k: 'unknown' };
  switch (n.type) {
    case 'StringLiteral':
      return { k: 'str', v: n.value };
    case 'NumericLiteral':
      return { k: 'num', v: n.value };
    case 'BooleanLiteral':
      return { k: 'bool', v: n.value };
    case 'TemplateLiteral':
      return template(n, ctx);
    case 'BinaryExpression':
      if (n.operator === '+') return concat(n, ctx);
      children(n, ctx);
      return { k: 'unknown' };
    case 'Identifier':
      return { k: 'ident', name: n.name };
    case 'ThisExpression':
      return { k: 'ident', name: 'this' };
    case 'MemberExpression':
    case 'OptionalMemberExpression': {
      noteMember(n, ctx);
      const chain = memberChain(n);
      if (chain) return { k: 'member', chain };
      const inner = unwrap(n.object);
      if (inner?.type === 'CallExpression' || inner?.type === 'OptionalCallExpression') {
        const value = expr(inner, ctx);
        return { k: 'pick', from: value, key: n.property?.name ?? '' };
      }
      children(n, ctx);
      return { k: 'unknown' };
    }
    case 'CallExpression':
    case 'OptionalCallExpression':
    case 'NewExpression':
      return callExpr(n, ctx, hint);
    case 'TaggedTemplateExpression': {
      const v = template(n.quasi, ctx);
      const tagChain = memberChain(n.tag) ?? [n.tag?.name ?? 'tag'];
      const site = record(
        { parts: tagChain.map((name, i) => (i === tagChain.length - 1 ? { name, args: [v] } : { name })), isNew: false, tagged: true, line: line(n), endLine: endLine(n), inTry: ctx.inTry, unit: ctx.unit.id },
        ctx,
      );
      return { k: 'call', call: site };
    }
    case 'ImportExpression': {
      const s = unwrap(n.source);
      ctx.mod.dynamicImports.push({ source: s?.type === 'StringLiteral' ? s.value : null, line: line(n) });
      return { k: 'unknown' };
    }
    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
      return { k: 'fn', unit: fnUnit(n, ctx, hint ?? n.id?.name) };
    case 'ObjectExpression': {
      const props: Record<string, Value> = {};
      for (const p of n.properties) {
        if (p.type === 'ObjectProperty') {
          const key = p.key?.name ?? p.key?.value;
          const v = expr(p.value, ctx, key !== undefined ? String(key) : undefined);
          if (key !== undefined && !p.computed) props[String(key)] = v;
        } else if (p.type === 'ObjectMethod') {
          const key = p.key?.name ?? p.key?.value;
          const id = fnUnit(p, ctx, key !== undefined ? String(key) : undefined);
          if (key !== undefined) props[String(key)] = { k: 'fn', unit: id };
        } else if (p.type === 'SpreadElement') {
          visit(p.argument, ctx);
        }
      }
      return { k: 'obj', props };
    }
    case 'ArrayExpression':
      return { k: 'arr', items: n.elements.map((e: any) => (e ? expr(e.type === 'SpreadElement' ? e.argument : e, ctx) : { k: 'unknown' })) };
    case 'ConditionalExpression':
      expr(n.test, ctx);
      {
        const a = expr(n.consequent, ctx);
        const b = expr(n.alternate, ctx);
        return a.k !== 'unknown' ? a : b;
      }
    case 'LogicalExpression': {
      const a = expr(n.left, ctx);
      const b = expr(n.right, ctx);
      return a.k !== 'unknown' ? a : b;
    }
    case 'SequenceExpression': {
      let last: Value = { k: 'unknown' };
      for (const e of n.expressions) last = expr(e, ctx);
      return last;
    }
    case 'JSXElement':
    case 'JSXFragment':
      jsx(n, ctx);
      return n.type === 'JSXElement' ? { k: 'jsx', name: jsxName(n.openingElement.name) } : { k: 'unknown' };
    default:
      children(n, ctx);
      return { k: 'unknown' };
  }
}

function template(n: any, ctx: Ctx): Value {
  let v = '';
  let lead = false;
  const idents: string[] = [];
  n.quasis.forEach((q: any, i: number) => {
    v += q.value.cooked ?? q.value.raw;
    const e = n.expressions[i];
    if (e) {
      if (i === 0 && !v) lead = true;
      v += ':p';
      const inner = unwrap(e);
      if (inner?.type === 'Identifier') idents.push(inner.name);
      visit(e, ctx);
    }
  });
  return { k: 'tpl', v, lead, holes: n.expressions.length, idents };
}

function concat(n: any, ctx: Ctx): Value {
  const left = expr(n.left, ctx);
  const right = expr(n.right, ctx);
  const piece = (x: Value): { text: string; dyn: boolean; holes: number; idents: string[] } => {
    if (x.k === 'str') return { text: x.v, dyn: false, holes: 0, idents: [] };
    if (x.k === 'tpl') return { text: x.v, dyn: x.lead, holes: x.holes, idents: x.idents };
    return { text: ':p', dyn: true, holes: 1, idents: x.k === 'ident' ? [x.name] : [] };
  };
  const l = piece(left);
  const r = piece(right);
  return { k: 'tpl', v: l.text + r.text, lead: l.dyn, holes: l.holes + r.holes, idents: [...l.idents, ...r.idents] };
}

function memberChain(n: any): string[] | null {
  const cur = unwrap(n);
  if (!cur) return null;
  if (cur.type === 'Identifier') return [cur.name];
  if (cur.type === 'ThisExpression') return ['this'];
  if (cur.type === 'MetaProperty') return ['import.meta'];
  if (cur.type === 'MemberExpression' || cur.type === 'OptionalMemberExpression') {
    const base = memberChain(cur.object);
    if (!base) return null;
    if (cur.computed) {
      const p = unwrap(cur.property);
      if (p?.type === 'StringLiteral') return [...base, p.value];
      return [...base, '[]'];
    }
    return [...base, cur.property.name];
  }
  return null;
}

function noteMember(n: any, ctx: Ctx): void {
  const chain = memberChain(n);
  if (!chain) return;
  const envName = envFromChain(chain);
  if (envName) ctx.mod.env.push({ name: envName, line: line(n) });
}

function envFromChain(chain: string[]): string | null {
  if (chain.length === 3 && chain[0] === 'process' && chain[1] === 'env' && chain[2] !== '[]') return chain[2];
  if (chain.length === 3 && chain[0] === 'import.meta' && chain[1] === 'env' && chain[2] !== '[]') return chain[2];
  if (chain.length === 3 && chain[0] === 'Bun' && chain[1] === 'env' && chain[2] !== '[]') return chain[2];
  return null;
}

function callExpr(n: any, ctx: Ctx, hint?: string): Value {
  // Flatten a.b('x').c('y') into one site with parts.
  const parts: CallPart[] = [];
  let cur: any = n;
  let isNew = n.type === 'NewExpression';

  const stack: Array<{ name: string; args?: any[] }> = [];
  for (;;) {
    cur = unwrap(cur);
    if (cur?.type === 'CallExpression' || cur?.type === 'OptionalCallExpression' || cur?.type === 'NewExpression') {
      if (cur.type === 'NewExpression') isNew = true;
      const callee = unwrap(cur.callee);
      if (callee?.type === 'Import') {
        const s = unwrap(cur.arguments[0]);
        ctx.mod.dynamicImports.push({ source: s?.type === 'StringLiteral' ? s.value : null, line: line(cur) });
        return { k: 'unknown' };
      }
      if (callee?.type === 'MemberExpression' || callee?.type === 'OptionalMemberExpression') {
        const name = callee.computed ? (unwrap(callee.property)?.value ?? '[]') : callee.property.name;
        stack.push({ name: String(name), args: cur.arguments });
        cur = callee.object;
        continue;
      }
      if (callee?.type === 'Identifier') {
        stack.push({ name: callee.name, args: cur.arguments });
        cur = null;
        break;
      }
      stack.push({ name: '(expr)', args: cur.arguments });
      if (callee) visit(callee, ctx);
      cur = null;
      break;
    }
    if (cur?.type === 'MemberExpression' || cur?.type === 'OptionalMemberExpression') {
      const name = cur.computed ? (unwrap(cur.property)?.value ?? '[]') : cur.property.name;
      stack.push({ name: String(name) });
      cur = cur.object;
      continue;
    }
    if (cur?.type === 'Identifier') {
      stack.push({ name: cur.name });
      break;
    }
    if (cur?.type === 'ThisExpression') {
      stack.push({ name: 'this' });
      break;
    }
    if (cur) {
      stack.push({ name: '(expr)' });
      visit(cur, ctx);
    }
    break;
  }
  stack.reverse();

  const site: CallSite = { parts, isNew, line: line(n), endLine: endLine(n), inTry: ctx.inTry, unit: ctx.unit.id };
  const chainName = stack.map((s) => s.name).join('.');

  for (const s of stack) {
    const part: CallPart = { name: s.name };
    if (s.args) {
      part.args = s.args.map((a: any) => argValue(a, ctx, chainName, hint));
    }
    parts.push(part);
  }

  record(site, ctx);

  // Hook-shaped calls give back the function they wrap.
  if (WRAPPER_HOOKS.has(chainName) && parts[parts.length - 1].args?.[0]?.k === 'fn') {
    return parts[parts.length - 1].args![0];
  }
  return { k: 'call', call: site };
}

function argValue(a: any, ctx: Ctx, chainName: string, hint?: string): Value {
  const arg = a.type === 'SpreadElement' ? a.argument : a;
  const inner = unwrap(arg);
  const isFn = inner?.type === 'ArrowFunctionExpression' || inner?.type === 'FunctionExpression';
  if (isFn) {
    const nameHint = WRAPPER_HOOKS.has(chainName) ? hint : LOAD_HOOKS.has(chainName) ? 'on load' : hint && /^(with|require|protected|authed)/i.test(chainName) ? hint : undefined;
    const id = fnUnit(inner, ctx, nameHint);
    if (!LOAD_HOOKS.has(chainName) && !WRAPPER_HOOKS.has(chainName)) ctx.unit.inline.push(id);
    return { k: 'fn', unit: id };
  }
  return expr(arg, ctx);
}

function record(site: CallSite, ctx: Ctx): CallSite {
  ctx.unit.calls.push(site);
  const chain = site.parts.map((p) => p.name);
  const name = chain.join('.');
  const args = site.parts[site.parts.length - 1].args ?? [];

  if (LOAD_HOOKS.has(name) && args[0]) {
    ctx.unit.triggers.push({ event: 'load', rawEvent: name, handler: args[0], line: site.line, unit: ctx.unit.id });
  }
  if (/(^|\.)(useQuery|useSuspenseQuery|useInfiniteQuery|useSWR|useSWRImmutable)$/.test(name)) {
    ctx.unit.triggers.push({ event: 'load', rawEvent: name, handler: { k: 'call', call: site }, line: site.line, unit: ctx.unit.id });
  }
  if (name === 'eval' || (site.isNew && name === 'Function')) {
    ctx.mod.notable.push({ kind: 'eval', line: site.line });
  }
  if (chain[chain.length - 1] === 'addEventListener' && args[0]?.k === 'str') {
    const ev = args[0].v;
    const event: Trigger['event'] = ev === 'click' ? 'click' : ev === 'submit' ? 'submit' : ev === 'change' || ev === 'input' ? 'change' : /key/.test(ev) ? 'key' : ev === 'load' || ev === 'DOMContentLoaded' ? 'load' : 'custom';
    const sel = selectorOf(site);
    ctx.unit.triggers.push({ event, rawEvent: ev, label: sel, handler: args[1] ?? { k: 'unknown' }, line: site.line, unit: ctx.unit.id });
  }
  if (name.endsWith('localStorage.setItem') || name === 'localStorage.setItem') {
    const key = args[0]?.k === 'str' ? args[0].v : '';
    if (/token|jwt|session|auth|password|secret/i.test(key)) ctx.mod.notable.push({ kind: 'local-storage-token', line: site.line, detail: key });
  }
  if ((chain[chain.length - 1] === 'setHeader' || chain[chain.length - 1] === 'set' || chain[chain.length - 1] === 'header') && args[0]?.k === 'str' && /access-control-allow-origin/i.test(args[0].v) && args[1]?.k === 'str' && args[1].v === '*') {
    ctx.mod.notable.push({ kind: 'cors-wildcard', line: site.line });
  }
  // SQL built by gluing strings together. Tagged templates are parameterised, so they are fine.
  if (!site.tagged && /^(query|execute|exec|prepare|raw|\$queryRawUnsafe|\$executeRawUnsafe|unsafe|run|all|get)$/i.test(chain[chain.length - 1])) {
    for (const a of args) {
      if (a.k === 'tpl' && a.holes > 0 && (SQL_START.test(a.v) || SQL_SHAPE.test(a.v))) {
        ctx.mod.notable.push({ kind: 'sql-interpolated', line: site.line, detail: a.v.slice(0, 80) });
      }
    }
  }
  return site;
}

function selectorOf(site: CallSite): string | undefined {
  for (const p of site.parts) {
    const a = p.args?.[0];
    if (a?.k === 'str' && /^(getElementById|querySelector|\$|find)$/.test(p.name)) return a.v.replace(/^[#.]/, '');
  }
  const root = site.parts[0]?.name;
  if (root && !['document', 'window', '(expr)', 'this', '$', 'el', 'elem', 'element', 'e', 'node', 'btn', 'button', 'form', 'input'].includes(root) && root.length > 2) return root.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ').toLowerCase();
  return undefined;
}

function jsxName(n: any): string {
  if (n.type === 'JSXIdentifier') return n.name;
  if (n.type === 'JSXMemberExpression') return `${jsxName(n.object)}.${n.property.name}`;
  return 'unknown';
}

function jsxText(n: any, depth = 0): string {
  if (!n || depth > 5) return '';
  if (n.type === 'JSXText') return n.value.replace(/\s+/g, ' ');
  if (n.type === 'StringLiteral') return n.value;
  if (n.type === 'JSXExpressionContainer') {
    const e = unwrap(n.expression);
    if (e?.type === 'StringLiteral') return e.value;
    if (e?.type === 'ConditionalExpression') return jsxText({ type: 'JSXExpressionContainer', expression: e.alternate }, depth + 1);
    if (e?.type === 'LogicalExpression') return jsxText({ type: 'JSXExpressionContainer', expression: e.right }, depth + 1);
    if (e?.type === 'JSXElement') return jsxText(e, depth + 1);
    return '';
  }
  if (n.type === 'JSXElement' || n.type === 'JSXFragment') {
    return (n.children ?? []).map((c: any) => jsxText(c, depth + 1)).join('');
  }
  return '';
}

function attrString(el: any, names: string[]): string | undefined {
  for (const a of el.openingElement.attributes) {
    if (a.type !== 'JSXAttribute') continue;
    if (names.includes(a.name.name)) {
      const t = a.value?.type === 'StringLiteral' ? a.value.value : jsxText(a.value);
      if (t) return t;
    }
  }
  return undefined;
}

function cleanLabel(s: string | undefined): string | undefined {
  const t = s?.replace(/\s+/g, ' ').replace(/\(\s*\)/g, '').replace(/[·:,\-\s]+$/, '').trim();
  if (!t || !/[a-zA-Z]/.test(t)) return undefined;
  return t.length > 48 ? `${t.slice(0, 45)}...` : t;
}

function findSubmitText(n: any, depth = 0): string | undefined {
  if (!n || depth > 8) return undefined;
  if (n.type === 'JSXElement') {
    const name = jsxName(n.openingElement.name);
    if (/^(button|Button|input)$/.test(name) || /Button$/.test(name)) {
      const type = attrString(n, ['type']);
      if (name !== 'input' && type !== 'button') {
        const t = cleanLabel(jsxText(n)) ?? cleanLabel(attrString(n, ['aria-label', 'title']));
        if (t) return t;
      }
      if (name === 'input' && type === 'submit') return cleanLabel(attrString(n, ['value']));
    }
  }
  for (const c of n.children ?? []) {
    if (c.type === 'JSXExpressionContainer') {
      const e = unwrap(c.expression);
      if (e?.type === 'LogicalExpression') {
        const t = findSubmitText(unwrap(e.right), depth + 1);
        if (t) return t;
      }
      if (e?.type === 'ConditionalExpression') {
        const t = findSubmitText(unwrap(e.consequent), depth + 1) ?? findSubmitText(unwrap(e.alternate), depth + 1);
        if (t) return t;
      }
    }
    const t = findSubmitText(c, depth + 1);
    if (t) return t;
  }
  return undefined;
}

function eventKind(attr: string): Trigger['event'] {
  if (attr === 'onClick' || attr === 'onPress' || attr === 'onTap') return 'click';
  if (attr === 'onSubmit' || attr === 'action') return 'submit';
  if (attr === 'onChange' || attr === 'onInput' || attr === 'onBlur' || attr === 'onValueChange') return 'change';
  if (/^onKey/.test(attr)) return 'key';
  return 'custom';
}

function jsx(n: any, ctx: Ctx): void {
  if (n.type === 'JSXFragment') {
    for (const c of n.children) jsxChild(c, ctx);
    return;
  }
  const open = n.openingElement;
  const name = jsxName(open.name);
  const props: Record<string, Value> = {};
  const use: JsxUse = { name, line: line(n), props };

  for (const a of open.attributes) {
    if (a.type === 'JSXSpreadAttribute') {
      visit(a.argument, ctx);
      continue;
    }
    const attr = a.name?.name;
    if (typeof attr !== 'string') continue;
    const isEvent = /^on[A-Z]/.test(attr) || (attr === 'action' && /^form$/i.test(name));
    let value: Value;
    if (a.value?.type === 'StringLiteral') value = { k: 'str', v: a.value.value };
    else if (a.value?.type === 'JSXExpressionContainer') {
      const inner = unwrap(a.value.expression);
      if (inner?.type === 'ArrowFunctionExpression' || inner?.type === 'FunctionExpression') {
        const label = isEvent ? `${attr} handler` : undefined;
        value = { k: 'fn', unit: fnUnit(inner, ctx, label) };
        if (!isEvent) ctx.unit.inline.push((value as any).unit);
      } else if (inner?.type === 'JSXElement') {
        jsx(inner, ctx);
        value = { k: 'jsx', name: jsxName(inner.openingElement.name) };
      } else {
        value = expr(inner, ctx);
      }
    } else if (a.value?.type === 'JSXElement') {
      jsx(a.value, ctx);
      value = { k: 'jsx', name: jsxName(a.value.openingElement.name) };
    } else {
      value = { k: 'bool', v: true };
    }
    props[attr] = value;

    if (attr === 'dangerouslySetInnerHTML') {
      const raw = value.k === 'obj' ? value.props.__html : undefined;
      // A constant written in this file is the author's own HTML, not a person's input.
      const obj = raw?.k === 'ident' ? (ctx.unit.locals.get(raw.name) ?? ctx.mod.root.locals.get(raw.name) ?? raw) : raw;
      const fixed = obj?.k === 'str' || (obj?.k === 'tpl' && obj.holes === 0);
      if (!fixed) ctx.mod.notable.push({ kind: 'dangerous-html', line: line(a) });
    }

    if (isEvent && value.k !== 'str' && value.k !== 'bool') {
      const event = eventKind(attr);
      const custom = event === 'custom';
      let label: string | undefined;
      if (event === 'submit') label = findSubmitText(n);
      label ??= cleanLabel(jsxText(n)) ?? cleanLabel(attrString(n, ['aria-label', 'title', 'placeholder', 'label', 'name']));
      if (custom && !label) label = attr.replace(/^on/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
      ctx.unit.triggers.push({ event, rawEvent: attr, label, element: name, handler: value, line: line(a), unit: ctx.unit.id });
    }
  }

  ctx.unit.jsx.push(use);
  let u: Unit | undefined = ctx.unit;
  while (u && u.kind === 'fn') {
    u.returnsJsx = true;
    u = u.parent ? ctx.mod.units.get(u.parent) : undefined;
  }
  for (const c of n.children) jsxChild(c, ctx);
}

function jsxChild(c: any, ctx: Ctx): void {
  if (c.type === 'JSXElement' || c.type === 'JSXFragment') jsx(c, ctx);
  else if (c.type === 'JSXExpressionContainer') expr(c.expression, ctx);
  else if (c.type === 'JSXSpreadChild') expr(c.expression, ctx);
}

/** Statement-level walk. Expressions go through expr(). */
function visit(n: any, ctx: Ctx): void {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) {
    for (const x of n) visit(x, ctx);
    return;
  }
  switch (n.type) {
    case undefined:
      return;
    case 'FunctionDeclaration': {
      const id = fnUnit(n, ctx, n.id?.name);
      if (n.id) ctx.unit.locals.set(n.id.name, { k: 'fn', unit: id });
      return;
    }
    case 'ClassDeclaration':
    case 'ClassExpression':
      classDecl(n, ctx);
      return;
    case 'VariableDeclaration':
      if (n.declare) return;
      for (const d of n.declarations) declarator(d, ctx);
      return;
    case 'ReturnStatement':
      if (n.argument) ctx.unit.returns.push(expr(n.argument, ctx));
      return;
    case 'ThrowStatement':
      expr(n.argument, ctx);
      return;
    case 'TryStatement':
      for (const s of n.block.body) visit(s, { ...ctx, inTry: true });
      if (n.handler) for (const s of n.handler.body.body) visit(s, ctx);
      if (n.finalizer) for (const s of n.finalizer.body) visit(s, ctx);
      return;
    case 'IfStatement':
      ifStatement(n, ctx);
      return;
    case 'ExpressionStatement':
      statementExpr(n.expression, ctx);
      return;
    case 'AssignmentExpression':
      statementExpr(n, ctx);
      return;
    case 'AwaitExpression':
    case 'ImportExpression':
    case 'CallExpression':
    case 'OptionalCallExpression':
    case 'NewExpression':
    case 'MemberExpression':
    case 'OptionalMemberExpression':
    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
    case 'ObjectExpression':
    case 'ArrayExpression':
    case 'TemplateLiteral':
    case 'TaggedTemplateExpression':
    case 'JSXElement':
    case 'JSXFragment':
    case 'ConditionalExpression':
    case 'LogicalExpression':
    case 'BinaryExpression':
    case 'SequenceExpression':
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression':
      expr(n, ctx);
      return;
    case 'TSTypeAliasDeclaration':
    case 'TSInterfaceDeclaration':
      recordType(n, ctx);
      return;
    case 'TSDeclareFunction':
    case 'TSEnumDeclaration':
    case 'TSModuleDeclaration':
      return;
    default:
      break;
  }
  children(n, ctx);
}

function children(n: any, ctx: Ctx): void {
  for (const key of Object.keys(n)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'range' || key === 'extra' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments' || key === 'typeAnnotation' || key === 'returnType' || key === 'typeParameters') continue;
    const v = n[key];
    if (v && typeof v === 'object') visit(v, ctx);
  }
}

function statementExpr(raw: any, ctx: Ctx): void {
  const n = unwrap(raw);
  if (n?.type !== 'AssignmentExpression') {
    expr(n, ctx);
    return;
  }
  const leftChain = memberChain(n.left);
  // module.exports = x and exports.x = y
  if (leftChain && leftChain[0] === 'module' && leftChain[1] === 'exports') {
    if (isRequire(unwrap(n.right))) {
      const source = unwrap(n.right).arguments[0]?.value;
      if (typeof source === 'string') ctx.mod.exports.push({ name: leftChain[2] ?? 'default', source, imported: 'default', line: line(n) });
      return;
    }
    ctx.mod.exports.push({ name: leftChain[2] ?? 'default', value: expr(n.right, ctx, leftChain[2]), line: line(n) });
    return;
  }
  if (leftChain && leftChain[0] === 'exports' && leftChain[1]) {
    ctx.mod.exports.push({ name: leftChain[1], value: expr(n.right, ctx, leftChain[1]), line: line(n) });
    return;
  }
  if (leftChain && leftChain[leftChain.length - 1] === 'innerHTML') {
    const v = expr(n.right, ctx);
    if (v.k !== 'str' && !(v.k === 'tpl' && v.holes === 0)) ctx.mod.notable.push({ kind: 'inner-html', line: line(n) });
    return;
  }
  const v = expr(n.right, ctx, leftChain?.length === 1 ? leftChain[0] : undefined);
  if (leftChain?.length === 2 && leftChain[0] === 'this') {
    let u: Unit | undefined = ctx.unit;
    while (u && !u.className) u = u.parent ? ctx.mod.units.get(u.parent) : undefined;
    if (u?.className && v.k !== 'unknown') ctx.mod.classFields.set(`${u.className}.${leftChain[1]}`, { value: v, unit: ctx.unit.id });
  }
  if (n.left.type === 'Identifier' && !ctx.unit.locals.has(n.left.name)) ctx.unit.locals.set(n.left.name, v);
  else if (n.left.type === 'ObjectPattern' || n.left.type === 'ArrayPattern') bindPattern(n.left, v, ctx);
}

function identsIn(n: any, out: Set<string>, depth = 0): void {
  if (!n || typeof n !== 'object' || depth > 6) return;
  if (Array.isArray(n)) {
    for (const x of n) identsIn(x, out, depth + 1);
    return;
  }
  if (n.type === 'Identifier') {
    out.add(n.name);
    return;
  }
  for (const key of ['left', 'right', 'argument', 'object', 'property', 'expression', 'callee', 'arguments', 'test']) {
    if (n[key]) identsIn(n[key], out, depth + 1);
  }
}

function exits(n: any): boolean {
  if (!n) return false;
  if (n.type === 'ReturnStatement' || n.type === 'ThrowStatement') return true;
  if (n.type === 'BlockStatement') return n.body.some(exits);
  if (n.type === 'ExpressionStatement') {
    const e = unwrap(n.expression);
    const name = e?.type === 'CallExpression' ? (memberChain(e.callee) ?? []).pop() : undefined;
    return !!name && /^(redirect|notFound|unauthorized|forbidden|abort)$/.test(name);
  }
  return false;
}

/** Find url === '/x' and method === 'POST' comparisons in a condition. */
function requestTest(t: any, out: { path?: string; method?: string }, depth = 0): void {
  const n = unwrap(t);
  if (!n || depth > 5) return;
  if (n.type === 'LogicalExpression') {
    requestTest(n.left, out, depth + 1);
    requestTest(n.right, out, depth + 1);
    return;
  }
  if (n.type !== 'BinaryExpression' || !/^[!=]==?$/.test(n.operator) || n.operator.startsWith('!')) return;
  const [l, r] = [unwrap(n.left), unwrap(n.right)];
  const lit = l?.type === 'StringLiteral' ? l : r?.type === 'StringLiteral' ? r : null;
  const other = lit === l ? r : l;
  if (!lit) return;
  const chain = memberChain(other);
  const last = chain?.[chain.length - 1];
  if (last === 'url' || last === 'pathname' || last === 'path') {
    if (lit.value.startsWith('/')) out.path = lit.value;
  } else if (last === 'method' && /^[A-Z]+$/.test(lit.value)) out.method = lit.value;
}

function ifStatement(n: any, ctx: Ctx): void {
  const found: { path?: string; method?: string } = {};
  requestTest(n.test, found);
  if (found.path) ctx.unit.pathChecks.push({ path: found.path, method: found.method, line: line(n), endLine: endLine(n.consequent) });
  if (exits(n.consequent)) {
    const idents = new Set<string>();
    identsIn(n.test, idents);
    ctx.unit.guards.push({ line: line(n), idents: [...idents] });
  }
  expr(n.test, ctx);
  visit(n.consequent, ctx);
  visit(n.alternate, ctx);
}

export { jsxName };
export type { JsxUse };
