/** Internal code model. Every language parser produces this; nothing downstream looks at syntax. */

export type Value =
  | { k: 'str'; v: string }
  /** A template or concatenation. `v` has :p in place of dynamic parts; `lead` means it starts dynamic. */
  | { k: 'tpl'; v: string; lead: boolean; holes: number; idents: string[] }
  | { k: 'ident'; name: string }
  | { k: 'member'; chain: string[] }
  | { k: 'call'; call: CallSite }
  | { k: 'fn'; unit: string }
  | { k: 'obj'; props: Record<string, Value> }
  | { k: 'arr'; items: Value[] }
  | { k: 'pick'; from: Value; key: string }
  | { k: 'jsx'; name: string }
  | { k: 'class'; name: string }
  | { k: 'num'; v: number }
  | { k: 'bool'; v: boolean }
  | { k: 'unknown' };

export interface CallPart {
  name: string;
  /** Present when this link of the chain is actually called. */
  args?: Value[];
}

export interface CallSite {
  parts: CallPart[];
  isNew: boolean;
  tagged?: boolean;
  line: number;
  endLine: number;
  inTry: boolean;
  unit: string;
}

export interface Trigger {
  event: 'click' | 'submit' | 'change' | 'load' | 'key' | 'custom';
  rawEvent: string;
  label?: string;
  element?: string;
  handler: Value;
  line: number;
  unit: string;
}

export interface JsxUse {
  name: string;
  line: number;
  props: Record<string, Value>;
}

export interface Guard {
  line: number;
  idents: string[];
}

/** if (req.method === 'POST' && url.pathname === '/x') { ... } in a hand-written server. */
export interface PathCheck {
  path: string;
  method?: string;
  line: number;
  endLine: number;
}

export interface Decorator {
  name: string;
  args: Value[];
  line: number;
}

export interface Unit {
  id: string;
  name: string;
  file: string;
  line: number;
  endLine: number;
  parent?: string;
  kind: 'module' | 'fn';
  params: string[];
  calls: CallSite[];
  locals: Map<string, Value>;
  returns: Value[];
  jsx: JsxUse[];
  triggers: Trigger[];
  guards: Guard[];
  pathChecks: PathCheck[];
  /** Inline callbacks defined here and passed to another call. Treated as "may run". */
  inline: string[];
  directive?: 'use client' | 'use server';
  async: boolean;
  isComponent: boolean;
  returnsJsx: boolean;
  decorators: Decorator[];
  className?: string;
  classDecorators?: Decorator[];
  httpMethod?: string;
  /** Parameter name to a type name, or 'Interface.field' for destructured params. */
  paramTypes: Map<string, string>;
}

export interface ImportBinding {
  local: string;
  source: string;
  /** 'default', '*', or the exported name. */
  imported: string;
  line: number;
  typeOnly: boolean;
}

export interface ExportEntry {
  name: string;
  value?: Value;
  /** Re-export. */
  source?: string;
  imported?: string;
  line: number;
}

export interface Notable {
  kind: 'dangerous-html' | 'eval' | 'inner-html' | 'cors-wildcard' | 'sql-interpolated' | 'todo-security' | 'local-storage-token' | 'child-process' | 'cookie-insecure';
  line: number;
  detail?: string;
}

export interface Module {
  file: string;
  language: 'js' | 'python';
  units: Map<string, Unit>;
  root: Unit;
  imports: ImportBinding[];
  exports: ExportEntry[];
  starExports: string[];
  dynamicImports: Array<{ source: string | null; line: number }>;
  env: Array<{ name: string; line: number }>;
  notable: Notable[];
  directive?: 'use client' | 'use server';
  ownWords?: string;
  parseError?: string;
  lines: number;
  /** interface Foo { bar: Baz } as Foo -> bar -> Baz. */
  interfaces: Map<string, Map<string, string>>;
  typeAliases: Map<string, string>;
  /** this.x = value, keyed 'Class.x'. */
  classFields: Map<string, { value: Value; unit: string }>;
  classFieldTypes: Map<string, string>;
  classes: Set<string>;
}

export function newUnit(file: string, id: string, name: string, line: number, endLine: number, kind: 'module' | 'fn', parent?: string): Unit {
  return {
    id, name, file, line, endLine, kind, parent,
    params: [], calls: [], locals: new Map(), returns: [], jsx: [], triggers: [], guards: [], pathChecks: [],
    inline: [], async: false, isComponent: false, returnsJsx: false, decorators: [], paramTypes: new Map(),
  };
}

export function chainOf(call: CallSite): string[] {
  return call.parts.map((p) => p.name);
}

export function argsOf(call: CallSite): Value[] {
  for (let i = call.parts.length - 1; i >= 0; i--) {
    if (call.parts[i].args) return call.parts[i].args!;
  }
  return [];
}

/** A string-ish value, or null. */
export function literal(v: Value | undefined): string | null {
  if (!v) return null;
  if (v.k === 'str') return v.v;
  if (v.k === 'tpl') return v.v;
  return null;
}
