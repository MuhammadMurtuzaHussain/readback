import { useEffect, useRef } from 'react';
import type { Evidence, Report } from '../engine/types';

const KW = /\b(import|from|export|default|const|let|var|function|async|await|return|if|else|try|catch|throw|new|class|def|for|while|in|of|with|as|raise|except|None|True|False|null|undefined|true|false)\b/g;

function highlight(line: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(\/\/.*$|#(?![\w-]+['"`]).*$|\/\*.*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const plain = (text: string, key: number): void => {
    let i = 0;
    let k: RegExpExecArray | null;
    KW.lastIndex = 0;
    const parts: React.ReactNode[] = [];
    while ((k = KW.exec(text))) {
      parts.push(text.slice(i, k.index), <span className="tk-k" key={`${key}-${k.index}`}>{k[0]}</span>);
      i = k.index + k[0].length;
    }
    parts.push(text.slice(i));
    out.push(...parts);
  };
  while ((m = re.exec(line))) {
    plain(line.slice(last, m.index), m.index);
    out.push(<span className={m[1] ? 'tk-c' : 'tk-s'} key={m.index}>{m[0]}</span>);
    last = m.index + m[0].length;
  }
  plain(line.slice(last), line.length + 1);
  return out;
}

export function githubUrl(report: Report, e: Evidence): string | null {
  const g = report.project.github;
  if (!g) return null;
  return `https://github.com/${g.owner}/${g.repo}/blob/${g.ref}/${e.file}#L${e.line}${e.endLine > e.line ? `-L${e.endLine}` : ''}`;
}

export function CodeBlock({ evidence, report, fill }: { evidence: Evidence; report: Report; fill?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = ref.current?.querySelector('tr.mark') as HTMLElement | null;
    if (row && ref.current) ref.current.scrollTop = Math.max(0, row.offsetTop - 32);
  }, [evidence]);
  const url = githubUrl(report, evidence);
  const label = `${evidence.file}:${evidence.line}`;
  return (
    <div className="block" style={fill ? { flex: 1, minHeight: 0 } : undefined}>
      <div className="code-head">
        {url ? <a href={url} target="_blank" rel="noreferrer">{label}</a> : <span>{label}</span>}
      </div>
      <div className="code" ref={ref} style={fill ? undefined : { maxHeight: 340 }}>
        <table>
          <tbody>
            {evidence.code.map((l, i) => {
              const n = evidence.startLine + i;
              const marked = n >= evidence.line && n <= evidence.endLine;
              return (
                <tr key={n} className={marked ? 'mark' : undefined}>
                  <td className="ln">{n}</td>
                  <td>{highlight(l)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
