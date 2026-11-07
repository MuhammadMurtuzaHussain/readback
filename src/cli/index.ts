import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyse } from '../engine/index';
import type { Report } from '../engine/types';
import { nodePython } from './python';
import { scanFolder } from './scan';

const HELP = `readback: see what your project actually does.

  readback [folder or GitHub URL] [options]

  --out <file.html>   write one shareable HTML file instead of opening a browser
  --json <file>       write the raw report as JSON
  --no-open           serve the report but do not open a browser
  --port <n>          port for the local page (default: any free port)
  -h, --help          show this

Nothing leaves your machine. There are no network calls during analysis.
`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function githubTarget(input: string): { url: string; owner: string; repo: string } | null {
  const m = input.match(/^(?:https?:\/\/)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/.*)?$/);
  return m ? { url: `https://github.com/${m[1]}/${m[2]}.git`, owner: m[1], repo: m[2] } : null;
}

export function viewerHtml(report: Report): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const template = readFileSync(path.join(here, 'viewer', 'index.html'), 'utf8');
  const json = JSON.stringify(report).replace(/</g, '\\u003c').split(String.fromCharCode(0x2028)).join('\\u2028').split(String.fromCharCode(0x2029)).join('\\u2029');
  return template.replace('__READBACK_REPORT__', () => json);
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

async function main(): Promise<void> {
  if (process.argv.includes('-h') || process.argv.includes('--help')) {
    process.stdout.write(HELP);
    return;
  }
  const input = process.argv.slice(2).find((a, i, all) => !a.startsWith('-') && !['--out', '--json', '--port'].includes(all[i - 1])) ?? '.';
  const gh = githubTarget(input);
  let root = path.resolve(input);
  let temp: string | null = null;
  let github: Report['project']['github'];

  if (gh) {
    temp = mkdtempSync(path.join(os.tmpdir(), 'readback-'));
    process.stderr.write(`Cloning ${gh.owner}/${gh.repo}\n`);
    execFileSync('git', ['clone', '--depth', '1', '--quiet', gh.url, temp], { stdio: 'inherit' });
    root = temp;
    const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: temp, encoding: 'utf8' }).trim();
    github = { owner: gh.owner, repo: gh.repo, ref };
  } else if (!existsSync(root)) {
    process.stderr.write(`I cannot find ${input}.\n`);
    process.exit(1);
  }

  try {
    process.stderr.write(`Reading ${gh ? `${gh.owner}/${gh.repo}` : root}\n`);
    const scan = await scanFolder(root);
    const parsePython = (await nodePython()) ?? undefined;
    const report = analyse(scan.files, {
      name: gh?.repo ?? (existsSync(path.join(root, 'package.json')) ? undefined : path.basename(root)),
      allPaths: scan.allPaths, tracked: scan.tracked, github, parsePython,
    });
    if (report.project.name === 'this project') report.project.name = path.basename(root);
    const r = report;
    process.stderr.write(`Read ${r.coverage.files} files in ${(r.coverage.durationMs / 1000).toFixed(1)}s: ${r.screens.length} screens, ${r.routes.length} routes, ${r.services.filter((s) => s.operations.length).length} services, ${r.journeys.length} journeys, ${r.risks.length} risks.\n`);

    const json = arg('--json');
    if (json) {
      writeFileSync(json, JSON.stringify(report, null, 2));
      process.stderr.write(`Wrote ${json}\n`);
    }
    const out = arg('--out');
    if (out) {
      writeFileSync(out, viewerHtml(report));
      process.stderr.write(`Wrote ${out}. It contains snippets of your code, so check them before sharing.\n`);
    }
    if (out || json) return;

    const html = viewerHtml(report);
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
    });
    server.listen(Number(arg('--port') ?? 0), '127.0.0.1', () => {
      const addr = server.address();
      const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : ''}`;
      process.stderr.write(`Your report is at ${url}\nPress Ctrl+C to stop. Only this computer can see it.\n`);
      if (!process.argv.includes('--no-open')) openBrowser(url);
    });
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
