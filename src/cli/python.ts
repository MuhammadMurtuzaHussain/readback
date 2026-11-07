import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { Language, Parser } from 'web-tree-sitter';
import { parsePython } from '../engine/python';
import type { TSNode } from '../engine/python';
import type { Module } from '../engine/model';

/** Loads the Python grammar for Node. Returns null rather than failing the run. */
export async function nodePython(): Promise<((file: string, source: string) => Module) | null> {
  try {
    const require = createRequire(import.meta.url);
    await Parser.init();
    const wasm = await readFile(require.resolve('tree-sitter-python/tree-sitter-python.wasm'));
    const lang = await Language.load(new Uint8Array(wasm));
    const parser = new Parser();
    parser.setLanguage(lang);
    return (file, source) => parsePython(file, source, (s) => parser.parse(s)!.rootNode as unknown as TSNode);
  } catch {
    return null;
  }
}
