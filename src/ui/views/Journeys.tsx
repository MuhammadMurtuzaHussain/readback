import { ArrowRight, CaretDown, CaretUp, Pause, Play } from '@phosphor-icons/react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CONCEPTS } from '../../engine/concepts';
import type { Step } from '../../engine/types';
import { CodeBlock } from '../Code';
import { useR } from '../ctx';

const LANE: Record<Step['where'], number> = { browser: 26, server: 80, outside: 134 };

export function Journeys() {
  const { report: r, focus, go } = useR();
  const [id, setId] = useState(focus ?? r.journeys[0]?.id);
  const j = r.journeys.find((x) => x.id === id) ?? r.journeys[0];
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [concept, setConcept] = useState<string | null>(null);

  useEffect(() => {
    setAt(0);
    setPlaying(false);
  }, [id]);
  useEffect(() => {
    if (focus) setId(focus);
  }, [focus]);

  useEffect(() => {
    if (!playing || !j) return;
    if (at >= j.steps.length - 1) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setAt((x) => x + 1), 1900);
    return () => clearTimeout(t);
  }, [playing, at, j]);

  useEffect(() => {
    const on = (e: KeyboardEvent): void => {
      if (!j || (e.target as HTMLElement).tagName === 'SELECT') return;
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        setAt((x) => Math.min(x + 1, j.steps.length - 1));
      }
      if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        setAt((x) => Math.max(x - 1, 0));
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [j]);

  const list = useRef<HTMLDivElement>(null);
  const [line, setLine] = useState<{ h: number; done: string; rest: string }>({ h: 0, done: '', rest: '' });
  const draw = useCallback(() => {
    const el = list.current;
    if (!el || !j) return;
    const rows = [...el.querySelectorAll<HTMLElement>('.step')];
    const pts = rows.map((row, i) => ({ x: LANE[j.steps[i].where], y: row.offsetTop + 13 }));
    const seg = (a: number, b: number): string => {
      let d = '';
      for (let i = a; i <= b && i < pts.length; i++) {
        const p = pts[i];
        if (i === a) d += `M${p.x} ${p.y}`;
        else {
          const q = pts[i - 1];
          const mid = (q.y + p.y) / 2;
          d += ` C${q.x} ${mid}, ${p.x} ${mid}, ${p.x} ${p.y}`;
        }
      }
      return d;
    };
    setLine({ h: el.scrollHeight, done: seg(0, at), rest: seg(at, pts.length - 1) });
  }, [j, at]);
  useLayoutEffect(() => {
    draw();
    const ro = new ResizeObserver(draw);
    if (list.current) ro.observe(list.current);
    return () => ro.disconnect();
  }, [draw]);

  useEffect(() => {
    list.current?.querySelector('[aria-current="step"]')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [at]);

  if (!j) {
    return (
      <div className="stage">
        <h1 className="title">Nothing to follow yet</h1>
        <p className="lede">I could not find a click, a request or a command that reaches anything outside the code. That is normal for a library or a fully offline app. See Parts for how the code is laid out.</p>
      </div>
    );
  }

  const step = j.steps[at];
  const screenPath = (sid?: string) => r.screens.find((s) => s.id === sid)?.path;

  return (
    <div className="stage wide">
      <h1 className="title" style={{ maxWidth: 'none' }}>Follow one thing through the app</h1>
      <p className="lede">Taken from your code, in the order it runs. The button words are your own.</p>
      <select className="jpick" value={j.id} aria-label="Choose a journey" onChange={(e) => setId(e.target.value)}>
        {r.journeys.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
      </select>
      <div className="jr">
        <nav className="jlist" aria-label="Journeys">
          {r.journeys.map((x) => (
            <button key={x.id} className="jitem" aria-pressed={x.id === j.id} onClick={() => setId(x.id)}>
              {x.title}
              {x.writes && <small>changes something</small>}
            </button>
          ))}
        </nav>
        <div className="jmain">
          <div className="lanes">
            <span>Browser</span><span>Server</span><span>Outside</span>
            <div className="ctrl">
              <button className="icon-btn" aria-label="Previous step" onClick={() => setAt((x) => Math.max(0, x - 1))}><CaretUp size={18} /></button>
              <button className="icon-btn" aria-label="Next step" onClick={() => setAt((x) => Math.min(j.steps.length - 1, x + 1))}><CaretDown size={18} /></button>
              <button className="icon-btn" aria-label={playing ? 'Pause' : 'Play through'} onClick={() => { if (!playing && at >= j.steps.length - 1) setAt(0); setPlaying(!playing); }}>
                {playing ? <Pause size={18} weight="fill" /> : <Play size={18} weight="fill" />}
              </button>
            </div>
          </div>
          <div ref={list} style={{ position: 'relative' }}>
            <svg className="trackline" height={line.h} aria-hidden="true">
              <path d={line.rest} />
              <path d={line.done} className="done" />
            </svg>
            {j.steps.map((s, i) => (
              <button key={i} className={`step ${i < at ? 'past' : ''}`} aria-current={i === at ? 'step' : undefined} onClick={() => setAt(i)}>
                <span className="rail"><span className="pip" style={{ left: LANE[s.where] }} /></span>
                <span>
                  <span className="t">{s.title}</span>
                  {i === at && s.note && <span className="n">{s.note}</span>}
                  {i === at && s.certainty === 'inferred' && <span className="n">This step is inferred, so it could be wrong.</span>}
                </span>
              </button>
            ))}
          </div>
          <div className={`fail ${j.failure.caught ? '' : 'open'}`}>
            {j.failure.text}
          </div>
        </div>
        <div className="jcode">
          {step?.evidence ? <CodeBlock evidence={step.evidence} report={r} fill /> : <div className="empty-code">This step is a description, not a line of code.</div>}
          {step?.concept && CONCEPTS[step.concept] && (
            <div style={{ padding: '10px 14px', borderTop: '1px solid var(--line)' }}>
              <button style={{ fontWeight: 700, textDecoration: 'underline', textUnderlineOffset: 3 }} onClick={() => setConcept(concept === step.concept ? null : step.concept!)}>
                {CONCEPTS[step.concept].title}
              </button>
              {concept === step.concept && <p style={{ color: 'var(--ink-2)', marginTop: 4, fontSize: 16 }}>{CONCEPTS[step.concept].plain}</p>}
            </div>
          )}
        </div>
      </div>
      <p className="hint">
        {j.screen ? `Starts on ${screenPath(j.screen)}. ` : ''}Use the arrow keys to step through.
      </p>
      <button className="next" onClick={() => go('parts')}>See what each file is for <ArrowRight size={18} /></button>
    </div>
  );
}
