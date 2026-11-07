import pythonWasm from 'tree-sitter-python/tree-sitter-python.wasm?url';
import treeSitterWasm from 'web-tree-sitter/web-tree-sitter.wasm?url';
import { analyse } from '../engine/index';
import { parsePython } from '../engine/python';
import type { TSNode } from '../engine/python';
import type { Report, VirtualFile } from '../engine/types';

interface Job {
  files: VirtualFile[];
  allPaths: string[];
  name: string;
  github?: Report['project']['github'];
}

async function python() {
  const { Language, Parser } = await import('web-tree-sitter');
  await Parser.init({ locateFile: () => treeSitterWasm });
  const lang = await Language.load(pythonWasm);
  const parser = new Parser();
  parser.setLanguage(lang);
  return (file: string, source: string) => parsePython(file, source, (s) => parser.parse(s)!.rootNode as unknown as TSNode);
}

self.onmessage = async (e: MessageEvent<Job>) => {
  const job = e.data;
  try {
    const needsPython = job.files.some((f) => f.path.endsWith('.py'));
    const parser = needsPython ? await python().catch(() => undefined) : undefined;
    const report = analyse(job.files, { name: job.name, allPaths: job.allPaths, github: job.github, parsePython: parser });
    self.postMessage({ ok: true, report });
  } catch (err) {
    self.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
