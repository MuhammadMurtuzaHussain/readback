import type { Evidence, FileRole, VirtualFile } from './types';

export const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', '.nuxt', '.svelte-kit', '.turbo', '.vercel', '.cache', '.output', '.parcel-cache',
  'dist', 'build', 'out', 'coverage', '.venv', 'venv', 'env', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  'target', 'vendor', 'Pods', 'DerivedData', '.gradle', '.idea', '.vscode', '.expo', '.entire', '.claude', '.terraform',
  'site-packages', 'bower_components', 'storybook-static', '.yarn', '.pnpm-store', '.wrangler', '.serverless',
  'examples', 'example', 'fixtures', '__fixtures__',
]);

const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|svgz|mp4|mov|webm|avi|mkv|mp3|wav|ogg|m4a|flac|pdf|zip|gz|tgz|tar|rar|7z|woff2?|ttf|otf|eot|wasm|so|dylib|dll|exe|bin|node|pyc|class|jar|sqlite3?|db|pt|onnx|gguf|safetensors|parquet|npz|npy|h5|apk|ipa|aab|dmg|lock|keystore|jks|p12|pem|mobileprovision)$/i;

export const MAX_FILE_BYTES = 600_000;

/** Decide before reading a file whether it is worth reading. */
export function shouldRead(path: string, size?: number): boolean {
  if (size !== undefined && size > MAX_FILE_BYTES) return false;
  const parts = path.split('/');
  if (parts.some((p) => SKIP_DIRS.has(p))) return false;
  const base = parts[parts.length - 1];
  if (BINARY.test(base)) return false;
  if (/\.min\.(js|css)$/.test(base) || /\.map$/.test(base)) return false;
  if (/^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|poetry\.lock|uv\.lock|Cargo\.lock|Gemfile\.lock|composer\.lock|go\.sum)$/.test(base)) return false;
  return true;
}

/** Lockfiles are not read for content, but their existence is a fact worth keeping. */
export const LOCKFILES = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|poetry\.lock|uv\.lock)$/;

export function isGenerated(file: VirtualFile): boolean {
  const head = file.content.slice(0, 400);
  if (/@generated|auto-?generated|do not edit/i.test(head)) return true;
  // One enormous line means a bundle.
  const lines = file.content.split('\n');
  if (lines.length < 8 && file.content.length > 20_000) return true;
  // Vendored bundles copied into public folders: long lines throughout.
  if (file.content.length > 30_000 && file.content.length / lines.length > 240) return true;
  return /\.d\.ts$/.test(file.path);
}

export const JS_EXT = /\.(tsx?|jsx?|mjs|cjs|mts|cts)$/;
export const PY_EXT = /\.py$/;
export const SFC_EXT = /\.(vue|svelte|astro)$/;

export function languageOf(path: string): string {
  const m = path.toLowerCase().match(/\.([a-z0-9]+)$/);
  const ext = m?.[1] ?? '';
  const map: Record<string, string> = {
    ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
    js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
    py: 'Python', go: 'Go', rs: 'Rust', rb: 'Ruby', php: 'PHP', java: 'Java', kt: 'Kotlin', swift: 'Swift',
    cs: 'C#', c: 'C', h: 'C', cpp: 'C++', cc: 'C++', hpp: 'C++', dart: 'Dart', ino: 'Arduino', lua: 'Lua',
    vue: 'Vue', svelte: 'Svelte', astro: 'Astro', html: 'HTML', css: 'CSS', scss: 'CSS', sql: 'SQL', sh: 'Shell',
    md: 'Markdown', mdx: 'Markdown', json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML', prisma: 'Prisma',
  };
  return map[ext] ?? 'Other';
}

export function roleOf(path: string): FileRole {
  const lower = path.toLowerCase();
  const base = lower.split('/').pop() ?? '';
  if (/(^|\/)(__tests__|tests?|spec|e2e|eval)\//.test(lower) || /\.(test|spec)\.[a-z]+$/.test(lower)) return 'test';
  if (/\.(css|scss|sass|less|styl)$/.test(lower)) return 'style';
  if (/\.(md|mdx|txt|rst)$/.test(lower) || /^(license|changelog)/.test(base)) return 'docs';
  if (/\.(png|jpe?g|gif|webp|svg|ico|mp4|woff2?|ttf)$/.test(lower)) return 'asset';
  if (/(^|\/)(scripts?|tools|bin)\//.test(lower)) return 'script';
  if (/\.(json|ya?ml|toml|ini|lock)$/.test(lower) || /(^|\/)\.[a-z]/.test(lower) || /(^|\/)(dockerfile|makefile|procfile)$/.test(lower) || /\.config\.[a-z]+$/.test(lower)) return 'config';
  if (/\.(sql|prisma)$/.test(lower) || /(^|\/)(migrations|drizzle|supabase)\//.test(lower) || /(^|\/)(schema|models?)\.[a-z]+$/.test(lower)) return 'data';
  return 'other';
}

const SECRET_VALUE: Array<[RegExp, string]> = [
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, 'Anthropic key'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, 'OpenAI key'],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, 'Stripe key'],
  [/\bwhsec_[A-Za-z0-9]{16,}/g, 'webhook secret'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AWS key'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, 'GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/g, 'GitHub token'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, 'Google API key'],
  [/\bxox[abprs]-[A-Za-z0-9-]{20,}/g, 'Slack token'],
  [/\bhf_[A-Za-z0-9]{30,}/g, 'Hugging Face token'],
  [/\bgsk_[A-Za-z0-9]{30,}/g, 'Groq key'],
  [/\bre_[A-Za-z0-9]{8}_[A-Za-z0-9_]{16,}/g, 'Resend key'],
  [/\beyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g, 'signed token'],
  [/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:\s'"`]+:[^@\s'"`]+@[^\s'"`]+/g, 'database connection string'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, 'private key'],
];

export interface SecretHit {
  label: string;
  line: number;
}

/** Find secret-shaped values. Returns labels and lines only, never the value. */
export function findSecrets(content: string): SecretHit[] {
  const hits: SecretHit[] = [];
  const lines = content.split('\n');
  lines.forEach((text, i) => {
    if (text.length > 2000) return;
    for (const [re, label] of SECRET_VALUE) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        if (/x{6,}|your[-_]|example|placeholder|\.\.\.|<[a-z_-]+>/i.test(m[0])) continue;
        hits.push({ label, line: i + 1 });
      }
    }
  });
  return hits;
}

/** Everything that goes into a Report passes through here. */
export function maskSecrets(line: string): string {
  let out = line;
  for (const [re, label] of SECRET_VALUE) {
    re.lastIndex = 0;
    out = out.replace(re, `[${label} hidden]`);
  }
  // key = "value" shapes where the name gives it away.
  out = out.replace(
    /((?:api[_-]?key|secret|password|passwd|token|private[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["'`])([^"'`\s]{8,})(["'`])/gi,
    (_m, a: string, _v: string, c: string) => `${a}[hidden]${c}`,
  );
  return out;
}

/** Reads a window of source around a line and masks it. */
export class Sources {
  private cache = new Map<string, string[]>();
  constructor(private files: Map<string, VirtualFile>) {}

  lines(path: string): string[] {
    let l = this.cache.get(path);
    if (!l) {
      l = (this.files.get(path)?.content ?? '').split('\n');
      this.cache.set(path, l);
    }
    return l;
  }

  evidence(file: string, line: number, endLine = line, context = 2): Evidence {
    const lines = this.lines(file);
    const maxSpan = 18;
    const clampedEnd = Math.min(endLine, line + maxSpan);
    const start = Math.max(1, line - context);
    const end = Math.min(lines.length, clampedEnd + context);
    const code = lines
      .slice(start - 1, end)
      .map((l) => maskSecrets(l.length > 180 ? `${l.slice(0, 177)}...` : l));
    return { file, line, endLine: clampedEnd, startLine: start, code };
  }

  /** Evidence for a file as a whole: the top of it. */
  head(file: string, n = 8): Evidence {
    return this.evidence(file, 1, Math.min(n, this.lines(file).length), 0);
  }
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

export function normalize(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

export function joinPath(...parts: string[]): string {
  return normalize(parts.filter(Boolean).join('/'));
}

/** Tolerant JSON for tsconfig: strips comments and trailing commas. */
export function parseLooseJson(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    /* fall through */
  }
  try {
    let out = '';
    let i = 0;
    let inStr = false;
    while (i < text.length) {
      const c = text[i];
      if (inStr) {
        out += c;
        if (c === '\\') {
          out += text[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (c === '"') inStr = false;
        i++;
        continue;
      }
      if (c === '"') {
        inStr = true;
        out += c;
        i++;
        continue;
      }
      if (c === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && text[i + 1] === '*') {
        i += 2;
        while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
      out += c;
      i++;
    }
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
  } catch {
    return null;
  }
}
