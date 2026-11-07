import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodePython } from '../src/cli/python';
import { scanFolder } from '../src/cli/scan';
import { analyse } from '../src/engine';
import type { Evidence, Report } from '../src/engine/types';

/** Walk the whole report and yield every piece of evidence in it. */
function allEvidence(value: unknown, out: Evidence[] = []): Evidence[] {
  if (Array.isArray(value)) value.forEach((v) => allEvidence(v, out));
  else if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.file === 'string' && typeof o.line === 'number' && Array.isArray(o.code)) out.push(o as unknown as Evidence);
    else Object.values(o).forEach((v) => allEvidence(v, out));
  }
  return out;
}

function assertHonest(r: Report, files: Map<string, string>): void {
  const evidence = allEvidence(r);
  expect(evidence.length).toBeGreaterThan(0);
  for (const e of evidence) {
    const source = files.get(e.file);
    expect(source, `${e.file} is cited but is not in the project`).toBeDefined();
    const lines = source!.split('\n');
    expect(e.line, `${e.file}:${e.line} is past the end of the file`).toBeLessThanOrEqual(lines.length);
    expect(e.line).toBeGreaterThanOrEqual(1);
    e.code.forEach((text, i) => {
      if (/hidden\]/.test(text) || text.endsWith('...')) return;
      expect(text, `${e.file}:${e.startLine + i} does not match the source`).toBe(lines[e.startLine - 1 + i]);
    });
  }
  // The quiz must always have a provable answer among its options.
  for (const q of r.questions) {
    expect(q.answer.length).toBeGreaterThan(0);
    for (const a of q.answer) expect(q.options.map((o) => o.id)).toContain(a);
  }
  // Every route a journey names must exist.
  const ids = new Set(r.routes.map((x) => x.id));
  for (const j of r.journeys) for (const id of j.routeIds) expect(ids.has(id)).toBe(true);
  const services = new Set(r.services.map((s) => s.id));
  for (const j of r.journeys) for (const id of j.serviceIds) expect(services.has(id)).toBe(true);
}

async function run(dir: string): Promise<void> {
  const scan = await scanFolder(dir);
  const report = analyse(scan.files, { allPaths: scan.allPaths, tracked: scan.tracked, parsePython: (await nodePython()) ?? undefined });
  assertHonest(report, new Map(scan.files.map((f) => [f.path, f.content])));
}

describe('every claim points at a real line', () => {
  it('holds for the sample app', () => run('examples/lunchbox'));
  it('holds for this repository', () => run('.'));

  // Extra repositories, for local runs: READBACK_CORPUS=/path/one:/path/two
  const corpus = (process.env.READBACK_CORPUS ?? '').split(':').filter(Boolean);
  for (const dir of corpus) {
    it(`holds for ${path.basename(dir)}`, () => run(dir));
  }
  it('corpus paths exist', () => {
    for (const dir of corpus) expect(existsSync(dir) && statSync(dir).isDirectory() && readdirSync(dir).length > 0).toBe(true);
  });
});
