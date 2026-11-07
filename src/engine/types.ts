/**
 * The Report is the only thing that crosses from the engine to the UI.
 *
 * Rule of the whole project: anything a person reads as a fact must carry
 * Evidence, and anything the engine could not establish goes in `gaps`
 * instead of being guessed.
 */

export interface VirtualFile {
  /** Repo-relative, forward slashes. */
  path: string;
  content: string;
}

/** Lines of real source attached to a claim. */
export interface Evidence {
  file: string;
  line: number;
  endLine: number;
  /** Line number of code[0]. */
  startLine: number;
  /** Source lines, with anything secret-shaped already masked. */
  code: string[];
}

/**
 * seen: it is literally in the code and we traced it.
 * inferred: follows from a pattern, and the UI must show that it might be wrong.
 */
export type Certainty = 'seen' | 'inferred';

export type ServiceKind =
  | 'database'
  | 'auth'
  | 'payments'
  | 'ai'
  | 'email'
  | 'storage'
  | 'analytics'
  | 'monitoring'
  | 'messaging'
  | 'queue'
  | 'maps'
  | 'web'
  | 'blockchain'
  | 'other';

export type TechKind =
  | 'framework'
  | 'language'
  | 'ui'
  | 'styling'
  | 'state'
  | 'validation'
  | 'testing'
  | 'build'
  | 'hosting'
  | 'tooling'
  | 'library'
  | ServiceKind;

export interface Tech {
  id: string;
  name: string;
  kind: TechKind;
  /** Hand-written plain explanation, empty when the package is not in the catalog. */
  plain: string;
  analogy?: string;
  /** The package's own description when we only have that. */
  ownWords?: string;
  packages: string[];
  importedBy: number;
  /** True when it is declared but no source file uses it. */
  ghost: boolean;
  /** True when it is a live thing the running app depends on. */
  runtime: boolean;
  evidence: Evidence[];
  devOnly: boolean;
}

export interface Screen {
  id: string;
  path: string;
  file: string;
  name: string;
  /** Who produces this screen. */
  render: 'browser' | 'server' | 'native';
  evidence: Evidence;
  framework: string;
  app?: string;
}

export interface Route {
  id: string;
  method: string;
  path: string;
  file: string;
  kind: 'route' | 'action' | 'webhook' | 'cron' | 'function' | 'command';
  handler?: string;
  evidence: Evidence;
  framework: string;
  auth: AuthState;
  validates: boolean;
  writes: boolean;
  /** A rate limit is visible on the path. */
  limited: boolean;
  /** Service ids this route reaches, directly or through helpers. */
  services: string[];
  /** Screens whose journeys call it. */
  calledBy: string[];
  certainty: Certainty;
  app?: string;
}

export interface AuthState {
  status: 'checked' | 'read-only' | 'middleware' | 'none' | 'not-applicable';
  how?: string;
  evidence?: Evidence;
}

export interface Service {
  id: string;
  name: string;
  kind: ServiceKind;
  plain: string;
  /** Where the code talking to it runs. */
  from: Array<'browser' | 'server'>;
  operations: Operation[];
  screens: string[];
  routes: string[];
  envVars: string[];
  host?: string;
}

export interface Operation {
  label: string;
  access: 'read' | 'write' | 'call';
  target?: string;
  evidence: Evidence;
  from: 'browser' | 'server';
}

export type StepKind =
  | 'trigger'
  | 'browser'
  | 'network'
  | 'server'
  | 'auth'
  | 'validate'
  | 'data'
  | 'service'
  | 'system'
  | 'gap'
  | 'more';

export interface Step {
  kind: StepKind;
  /** One plain sentence. */
  title: string;
  /** Optional second sentence that teaches. */
  note?: string;
  where: 'browser' | 'server' | 'outside';
  concept?: string;
  evidence?: Evidence;
  certainty: Certainty;
  serviceId?: string;
}

export interface Journey {
  id: string;
  title: string;
  trigger: 'click' | 'submit' | 'load' | 'request' | 'schedule' | 'command' | 'event';
  screen?: string;
  routeIds: string[];
  serviceIds: string[];
  steps: Step[];
  /** Plain statement about what happens on failure, derived from try/catch coverage. */
  failure: { caught: boolean; text: string; evidence?: Evidence };
  writes: boolean;
  score: number;
}

export type RiskSeverity = 'high' | 'medium' | 'low';

export interface Risk {
  id: string;
  rule: string;
  severity: RiskSeverity;
  title: string;
  /** Why a person should care, without jargon. */
  why: string;
  /** How to check it yourself. */
  check: string;
  /** What this tool cannot see, stated up front. */
  caveat?: string;
  /** A prompt you can paste into your coding assistant. */
  fixPrompt: string;
  certainty: Certainty;
  evidence: Evidence[];
  concept?: string;
}

export interface Option {
  id: string;
  text: string;
  mono?: boolean;
}

export interface Question {
  id: string;
  topic: string;
  ask: string;
  options: Option[];
  answer: string[];
  multi: boolean;
  /** Shown after answering. */
  explain: string;
  evidence: Evidence[];
  concept?: string;
}

export interface Table {
  name: string;
  source: string;
  fields: Array<{ name: string; type?: string; sensitive?: boolean }>;
  evidence: Evidence;
  /** null means we have no idea, false means we saw it missing. */
  rls?: boolean | null;
  readers: string[];
  writers: string[];
}

export type FileRole =
  | 'screen'
  | 'route'
  | 'component'
  | 'logic'
  | 'data'
  | 'config'
  | 'test'
  | 'style'
  | 'docs'
  | 'script'
  | 'asset'
  | 'other';

export interface FileFact {
  path: string;
  role: FileRole;
  lines: number;
  plain: string;
  importedBy: number;
  imports: number;
  /** The file's own leading comment, quoted, if it has one. */
  ownWords?: string;
  exports: string[];
  unreached?: boolean;
  language: string;
}

export interface EnvVar {
  name: string;
  exposure: 'browser' | 'server' | 'both';
  reads: Evidence[];
  documented: boolean;
  looksSecret: boolean;
}

export interface Gap {
  kind: 'dynamic-import' | 'unresolved-import' | 'unmatched-call' | 'unmounted-router' | 'language' | 'parse-error' | 'skipped-file' | 'dynamic-route';
  text: string;
  evidence?: Evidence;
}

export interface Sentence {
  parts: Array<string | { text: string; target: Target; certainty?: Certainty }>;
}

export type Target =
  | { type: 'evidence'; evidence: Evidence[]; title: string; body?: string }
  | { type: 'view'; view: ViewId; id?: string };

export type ViewId = 'overview' | 'map' | 'journeys' | 'parts' | 'stack' | 'risks' | 'readback';

export interface Coverage {
  files: number;
  linesOfCode: number;
  analysed: number;
  languages: Array<{ name: string; files: number; lines: number; depth: 'traced' | 'listed' }>;
  durationMs: number;
}

export interface Report {
  schema: 1;
  generatedAt: string;
  project: {
    name: string;
    description?: string;
    readmeLine?: string;
    /** Set when the source is a GitHub repo, so evidence can deep link. */
    github?: { owner: string; repo: string; ref: string };
    shape: 'web-app' | 'site' | 'api' | 'cli' | 'library' | 'mobile' | 'desktop' | 'monorepo' | 'unknown';
    apps: string[];
    run: Array<{ name: string; command: string; plain: string }>;
    deploys: Array<{ name: string; evidence: Evidence }>;
  };
  summary: Sentence[];
  stack: Tech[];
  screens: Screen[];
  routes: Route[];
  services: Service[];
  journeys: Journey[];
  risks: Risk[];
  questions: Question[];
  tables: Table[];
  files: FileFact[];
  env: EnvVar[];
  gaps: Gap[];
  coverage: Coverage;
  narration?: Narration;
}

export interface Narration {
  model: string;
  at: string;
  items: Record<string, { text: string; rejected: string[] }>;
}
