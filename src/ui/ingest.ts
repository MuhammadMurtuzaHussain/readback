import { shouldRead } from '../engine/files';
import type { VirtualFile } from '../engine/types';

export interface Ingested {
  files: VirtualFile[];
  allPaths: string[];
  name: string;
  github?: { owner: string; repo: string; ref: string };
}

const MAX_FILES = 2500;

export function parseGithub(input: string): { owner: string; repo: string } | null {
  const m = input.trim().match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/.*)?$/) ?? input.trim().match(/^([\w.-]+)\/([\w.-]+)$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** Public repos only, straight from the visitor's browser to GitHub. No server of ours is involved. */
export async function fromGithub(owner: string, repo: string, progress: (s: string) => void): Promise<Ingested> {
  const meta = await fetch(`https://api.github.com/repos/${owner}/${repo}`);
  if (meta.status === 404) throw new Error('I cannot find that repository. It may be private. For private code, use the command line version.');
  if (meta.status === 403) throw new Error('GitHub is rate limiting this browser. Try again in a while, or use the command line version.');
  if (!meta.ok) throw new Error(`GitHub said ${meta.status}.`);
  const branch = (await meta.json()).default_branch as string;
  const treeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  if (!treeRes.ok) throw new Error(`GitHub said ${treeRes.status} when listing files.`);
  const tree = await treeRes.json();
  const blobs: Array<{ path: string; size: number }> = tree.tree.filter((t: any) => t.type === 'blob');
  const wanted = blobs.filter((b) => shouldRead(b.path, b.size) && !/(^|\/)\.env(\.|$)/.test(b.path.replace(/\.(example|sample|template)$/, 'x'))).slice(0, MAX_FILES);
  const files: VirtualFile[] = [];
  let done = 0;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < wanted.length) {
      const item = wanted[cursor++];
      try {
        const res = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${item.path.split('/').map(encodeURIComponent).join('/')}`);
        if (res.ok) files.push({ path: item.path, content: await res.text() });
      } catch {
        /* a single missing file should not sink the whole run */
      }
      done++;
      if (done % 10 === 0) progress(`Read ${done} of ${wanted.length} files`);
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));
  return { files, allPaths: blobs.map((b) => b.path), name: repo, github: { owner, repo, ref: branch } };
}

function stripRoot(paths: string[]): string {
  const first = paths[0]?.split('/')[0];
  return first && paths.every((p) => p.startsWith(`${first}/`)) ? `${first}/` : '';
}

async function finish(entries: Array<{ path: string; read: () => Promise<string>; size: number }>, fallbackName: string): Promise<Ingested> {
  const prefix = stripRoot(entries.map((e) => e.path));
  const allPaths: string[] = [];
  const files: VirtualFile[] = [];
  for (const e of entries) {
    const path = e.path.slice(prefix.length);
    allPaths.push(path);
    if (files.length >= MAX_FILES || !shouldRead(path, e.size)) continue;
    if (/(^|\/)\.env(\.|$)/.test(path) && !/\.(example|sample|template)$/.test(path)) continue;
    files.push({ path, content: await e.read() });
  }
  return { files, allPaths, name: prefix.replace(/\/$/, '') || fallbackName };
}

export function fromFileList(list: FileList): Promise<Ingested> {
  const entries = [...list].map((f) => ({ path: (f as File & { webkitRelativePath: string }).webkitRelativePath || f.name, size: f.size, read: () => f.text() }));
  return finish(entries, 'your project');
}

async function walk(entry: any, base: string, out: Array<{ path: string; file: File }>): Promise<void> {
  if (entry.isFile) {
    const file: File = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ path: base + entry.name, file });
    return;
  }
  if (/^(node_modules|\.git|\.next|dist|build|out|\.venv|venv|__pycache__|target|coverage)$/.test(entry.name)) return;
  const reader = entry.createReader();
  for (;;) {
    const batch: any[] = await new Promise((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    for (const e of batch) await walk(e, `${base}${entry.name}/`, out);
  }
}

export async function fromDrop(items: DataTransferItemList): Promise<Ingested> {
  const roots = [...items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  const out: Array<{ path: string; file: File }> = [];
  for (const r of roots) await walk(r, '', out);
  return finish(out.map((o) => ({ path: o.path, size: o.file.size, read: () => o.file.text() })), 'your project');
}
