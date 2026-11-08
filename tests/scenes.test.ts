import { describe, expect, it } from 'vitest';
import { scanFolder } from '../src/cli/scan';
import { analyse } from '../src/engine';
import { buildScenes, pickJourney, totalMs } from '../src/ui/play/scenes';

async function report(dir: string) {
  const s = await scanFolder(dir);
  return analyse(s.files, { allPaths: s.allPaths });
}

describe('the film', () => {
  it('tells the sample app in order, from title to end card', async () => {
    const scenes = buildScenes(await report('examples/lunchbox'));
    const kinds = scenes.map((s) => s.kind);
    expect(kinds[0]).toBe('title');
    expect(kinds[kinds.length - 1]).toBe('end');
    for (const k of ['lines', 'nodes', 'outage', 'step', 'failure', 'risk', 'question']) expect(kinds).toContain(k);
    const seconds = totalMs(scenes) / 1000;
    expect(seconds).toBeGreaterThan(45);
    expect(seconds).toBeLessThan(150);
  });

  it('picks a journey where a person does something that reaches a service', async () => {
    const j = pickJourney(await report('examples/lunchbox'))!;
    expect(['click', 'submit']).toContain(j.trigger);
    expect(j.serviceIds.length).toBeGreaterThan(0);
  });

  it('never says anything with a dash used as punctuation, and never says nothing', async () => {
    for (const s of buildScenes(await report('examples/lunchbox'))) {
      expect(s.say.trim().length).toBeGreaterThan(0);
      expect(s.say).not.toMatch(/[–—]/);
    }
  });

  it('still makes a sensible film of a project with no screens or routes', () => {
    const scenes = buildScenes(analyse([{ path: 'index.js', content: 'module.exports = (a, b) => a + b;' }]));
    expect(scenes[0].kind).toBe('title');
    expect(scenes[scenes.length - 1].kind).toBe('end');
    expect(scenes.some((s) => s.kind === 'outage' || s.kind === 'step')).toBe(false);
  });
});
