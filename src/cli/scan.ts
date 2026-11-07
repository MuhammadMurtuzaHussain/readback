import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import ignore from 'ignore';
import { shouldRead, SKIP_DIRS } from '../engine/files';
import type { VirtualFile } from '../engine/types';

export interface Scan {
  files: VirtualFile[];
  allPaths: string[];
  tracked?: string[];
}

/** Walk a project folder. Reads text only, never follows symlinks, respects .gitignore. */
export async function scanFolder(root: string, maxFiles = 4000): Promise<Scan> {
  const ig = ignore();
  try {
    ig.add(await fs.readFile(path.join(root, '.gitignore'), 'utf8'));
  } catch { /* no .gitignore */ }
  const files: VirtualFile[] = [];
  const allPaths: string[] = [];

  async function walk(dir: string): Promise<void> {
    if (files.length >= maxFiles) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (ig.ignores(`${rel}/`)) continue;
        await walk(abs);
        continue;
      }
      if (!e.isFile()) continue;
      allPaths.push(rel);
      // Secrets stay out of the report entirely, but we still note they exist.
      if (/(^|\/)\.env(\.|$)/.test(rel) && !/\.(example|sample|template)$/.test(rel)) continue;
      if (ig.ignores(rel)) continue;
      const stat = await fs.stat(abs);
      if (!shouldRead(rel, stat.size)) continue;
      try {
        files.push({ path: rel, content: await fs.readFile(abs, 'utf8') });
      } catch { /* unreadable */ }
    }
  }
  await walk(root);

  let tracked: string[] | undefined;
  try {
    tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32_000_000 }).split('\n').filter(Boolean);
  } catch { /* not a git repo */ }
  return { files, allPaths, tracked };
}
