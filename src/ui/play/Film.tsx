import { ArrowRight, CaretLeft, CaretRight, Check, LockOpen, Pause, Play, SpeakerHigh, SpeakerSlash, X } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Report } from '../../engine/types';
import { CodeBlock } from '../Code';
import { buildScenes, laneOf, totalMs } from './scenes';
import type { NodeItem, Scene } from './scenes';

const LANES = ['Their browser', 'Your server', 'Outside'];

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Only voices that run on this machine, so turning the voice on sends nothing anywhere. */
function localVoice(): SpeechSynthesisVoice | null {
  if (typeof speechSynthesis === 'undefined') return null;
  // macOS ships joke voices ("Bad News", "Zarvox") as local English voices. Never pick those.
  const novelty = /bad news|good news|bahh|bells|boing|bubbles|cellos|jester|organ|superstar|trinoids|whisper|wobble|zarvox|albert|fred|junior|ralph|kathy|grandma|grandpa|rocko|eddy|flo |sandy|shelley|reed/i;
  const voices = speechSynthesis.getVoices().filter((v) => v.localService && v.lang.startsWith('en') && !novelty.test(`${v.name} `));
  return voices.find((v) => /moira/i.test(v.name))
    ?? voices.find((v) => /daniel|serena|kate|arthur/i.test(v.name))
    ?? voices.find((v) => v.lang === 'en-GB' || v.lang === 'en-IE')
    ?? voices.find((v) => /samantha/i.test(v.name))
    ?? voices[0]
    ?? null;
}

function Nodes({ items, more }: { items: NodeItem[]; more: number }) {
  return (
    <div className="f-nodes">
      {items.map((n, i) => (
        <div key={n.label + i} className={`f-node f-in ${n.open ? 'open' : ''}`} style={{ ['--i' as string]: i }}>
          <b>{n.method && <span className="m">{n.method}</span>}{n.label}</b>
          {n.sub && <span>{n.open && <LockOpen size={15} />} {n.sub}</span>}
        </div>
      ))}
      {more > 0 && <div className="f-more f-in" style={{ ['--i' as string]: items.length }}>and {more} more</div>}
    </div>
  );
}

function Stage({ scene, report, revealed }: { scene: Scene; report: Report; revealed: boolean }) {
  switch (scene.kind) {
    case 'title':
      return (
        <div className="f-title">
          <h1 className="f-in">{scene.title}</h1>
          <span className="f-rule" />
          {scene.sub && <p className="f-in" style={{ ['--i' as string]: 2 }}>{scene.sub}</p>}
        </div>
      );
    case 'lines':
      return (
        <div className="f-lines">
          {scene.lines.map((l, i) => (
            <p key={i} className="f-in" style={{ animationDelay: `${Math.round((i * scene.ms) / (scene.lines.length + 0.6))}ms` }}>{l}</p>
          ))}
        </div>
      );
    case 'nodes':
      return (
        <div className="f-split">
          <h2 className="f-in">{scene.heading}</h2>
          <Nodes items={scene.items} more={scene.more} />
        </div>
      );
    case 'outage':
      return (
        <div className="f-outage">
          <div className="f-off f-in"><span>{scene.service}</span><em>switched off</em></div>
          <div className="f-cols">
            {scene.screens.length > 0 && (
              <div>
                <h3>Screens</h3>
                {scene.screens.map((n, i) => <div key={n.label + i} className={`f-node small ${n.open ? 'hit' : 'safe'}`} style={{ ['--i' as string]: i }}><b>{n.label}</b></div>)}
              </div>
            )}
            {scene.routes.length > 0 && (
              <div>
                <h3>Routes</h3>
                {scene.routes.map((n, i) => <div key={n.label + i} className={`f-node small ${n.open ? 'hit' : 'safe'}`} style={{ ['--i' as string]: i + scene.screens.length }}><b>{n.method && <span className="m">{n.method}</span>}{n.label}</b></div>)}
              </div>
            )}
          </div>
        </div>
      );
    case 'step': {
      const steps = scene.journey.steps.filter((s) => s.kind !== 'more').slice(0, 9);
      const lane = laneOf(scene.step);
      return (
        <div className="f-journey">
          <div className="f-lanes" aria-hidden="true">
            {LANES.map((l, i) => <div key={l} className={`f-lane ${i === lane ? 'here' : ''}`}><span>{l}</span></div>)}
            <div className="f-trail">
              <svg viewBox="0 0 100 100" preserveAspectRatio="none">
                <polyline points={steps.slice(0, scene.index + 1).map((s, i) => `${(laneOf(s) * 2 + 1) * (100 / 6)},${8 + (i / Math.max(steps.length - 1, 1)) * 84}`).join(' ')} />
              </svg>
              {steps.slice(0, scene.index + 1).map((s, i) => (
                <i key={i} className={i === scene.index ? 'now' : ''} style={{ left: `${(laneOf(s) * 2 + 1) * (100 / 6)}%`, top: `${8 + (i / Math.max(steps.length - 1, 1)) * 84}%` }} />
              ))}
            </div>
            <div className="f-count">Step {scene.index + 1} of {steps.length}</div>
          </div>
          <div className="f-code">
            {scene.step.evidence ? <CodeBlock key={`${scene.index}`} evidence={scene.step.evidence} report={report} /> : <p className="f-nocode">{scene.index === 0 ? 'This is where it starts.' : 'No single line of code for this step.'}</p>}
          </div>
        </div>
      );
    }
    case 'failure':
      return (
        <div className="f-split">
          <h2 className="f-in">{scene.journey.failure.caught ? 'Failures are caught on this path' : 'Nothing catches a failure on this path'}</h2>
          {scene.journey.failure.evidence && <div className="f-in" style={{ ['--i' as string]: 2, maxWidth: 680 }}><CodeBlock evidence={scene.journey.failure.evidence} report={report} /></div>}
        </div>
      );
    case 'risk':
      return (
        <div className="f-risk">
          <span className={`sev ${scene.risk.severity} f-in`}>{scene.risk.severity}, {scene.index + 1} of {scene.total}</span>
          <h2 className="f-in" style={{ ['--i' as string]: 1 }}>{scene.risk.title}</h2>
          {scene.risk.evidence.length > 0 && (
            <div className="f-ev f-in" style={{ ['--i' as string]: 3 }}>{scene.risk.evidence.slice(0, 3).map((e) => `${e.file}:${e.line}`).join('   ')}</div>
          )}
        </div>
      );
    case 'question': {
      const q = scene.question;
      return (
        <div className="f-q">
          <h2 className="f-in">{q.ask}</h2>
          <div className="f-opts">
            {q.options.map((o, i) => (
              <div key={o.id} className={`f-opt f-in ${o.mono ? 'mono' : ''} ${revealed ? (q.answer.includes(o.id) ? 'right' : 'dim') : ''}`} style={{ ['--i' as string]: i + 1 }}>
                <span className="box">{revealed && q.answer.includes(o.id) && <Check size={14} weight="bold" />}</span>{o.text}
              </div>
            ))}
          </div>
          {!revealed && <div className="f-think"><i style={{ animationDuration: `${scene.thinkMs}ms` }} /></div>}
          {revealed && <p className="f-explain f-in">{q.explain}</p>}
        </div>
      );
    }
    case 'end':
      return (
        <div className="f-end">
          <div className="f-stats">
            <div className="f-in"><b>{scene.journeys}</b><span>journeys to follow</span></div>
            <div className="f-in" style={{ ['--i' as string]: 1 }}><b>{scene.risks}</b><span>things to check</span></div>
            <div className="f-in" style={{ ['--i' as string]: 2 }}><b>{scene.questions}</b><span>questions to answer</span></div>
          </div>
        </div>
      );
  }
}

/** Captions only where the stage is not already the words. */
function caption(scene: Scene): string | null {
  if (scene.kind === 'title' || scene.kind === 'lines' || scene.kind === 'question' || scene.kind === 'end') return null;
  if (scene.kind === 'risk') return scene.say.slice(scene.risk.title.length + 2);
  if (scene.kind === 'step') return scene.step.title;
  return scene.say;
}

export function Film({ report, onClose, onExplore }: { report: Report; onClose: () => void; onExplore: (view: 'overview' | 'readback') => void }) {
  const scenes = useMemo(() => buildScenes(report), [report]);
  const total = useMemo(() => totalMs(scenes), [scenes]);
  const starts = useMemo(() => scenes.reduce<number[]>((acc, s, i) => [...acc, i ? acc[i - 1] + scenes[i - 1].ms : 0], []), [scenes]);
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [voiceOn, setVoiceOn] = useState(false);
  const [voice, setVoice] = useState<SpeechSynthesisVoice | null>(null);
  const [revealed, setRevealed] = useState(false);
  const elapsed = useRef(0);
  const spoken = useRef(true);
  const fill = useRef<Array<HTMLSpanElement | null>>([]);
  const time = useRef<HTMLSpanElement>(null);
  const scene = scenes[i];

  useEffect(() => {
    const pick = (): void => setVoice(localVoice());
    pick();
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.addEventListener?.('voiceschanged', pick);
    return () => {
      if (typeof speechSynthesis !== 'undefined') {
        speechSynthesis.removeEventListener?.('voiceschanged', pick);
        speechSynthesis.cancel();
      }
    };
  }, []);

  const go = useCallback((n: number) => {
    const next = Math.max(0, Math.min(scenes.length - 1, n));
    elapsed.current = 0;
    setRevealed(false);
    setI(next);
  }, [scenes.length]);

  // Speak the scene, and hold the scene until the voice is done.
  useEffect(() => {
    if (typeof speechSynthesis === 'undefined') return;
    speechSynthesis.cancel();
    spoken.current = true;
    if (!voiceOn || !voice || !playing) return;
    const u = new SpeechSynthesisUtterance(scene.say);
    u.voice = voice;
    u.rate = 1.02;
    spoken.current = false;
    u.onend = () => { spoken.current = true; };
    u.onerror = () => { spoken.current = true; };
    speechSynthesis.speak(u);
  }, [i, voiceOn, voice, playing, scene.say]);

  // The clock. Progress is written straight to the DOM so React does not re-render every frame.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (now: number): void => {
      const dt = now - last;
      last = now;
      if (playing) {
        elapsed.current += dt;
        const s = scenes[i];
        const p = s.ms ? Math.min(1, elapsed.current / s.ms) : 1;
        const el = fill.current[i];
        if (el) el.style.transform = `scaleX(${p})`;
        if (time.current) time.current.textContent = `${clock(starts[i] + Math.min(elapsed.current, s.ms))} / ${clock(total)}`;
        if (s.kind === 'question' && !revealed && elapsed.current >= s.thinkMs) setRevealed(true);
        if (s.kind !== 'end' && elapsed.current >= s.ms && spoken.current) {
          go(i + 1);
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [i, playing, scenes, starts, total, revealed, go]);

  useEffect(() => {
    fill.current.forEach((el, n) => { if (el) el.style.transform = `scaleX(${n < i ? 1 : 0})`; });
  }, [i]);

  useEffect(() => {
    const on = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
      else if (e.key === ' ' || e.key === 'k') { e.preventDefault(); setPlaying((p) => !p); }
      else if (e.key === 'ArrowRight' || e.key === 'l') go(i + 1);
      else if (e.key === 'ArrowLeft' || e.key === 'j') go(i - 1);
      else if (e.key === 'v') setVoiceOn((v) => !v);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [i, go, onClose]);

  const cap = caption(scene);
  // Steps of one journey share a stage, so the trail continues instead of restarting.
  const stageKey = scene.kind === 'step' ? `journey-${scene.journey.id}` : `scene-${i}`;

  return (
    <div className={`film ${playing ? '' : 'paused'}`} role="dialog" aria-label={`${report.project.name}, played back`}>
      <header className="f-top">
        <span className="f-chapter" key={`c${scene.chapter}`}>{scene.chapter}</span>
        <span className="f-name">{report.project.name}</span>
        <button className="icon-btn" aria-label="Close the film" onClick={onClose}><X size={20} /></button>
      </header>

      <main className="f-stage" key={stageKey}>
        <Stage scene={scene} report={report} revealed={revealed} />
      </main>

      <div className="f-caption" aria-live="polite">
        {cap && <p key={`cap${i}`} className="f-in">{cap}</p>}
        {scene.kind === 'end' && (
          <div className="f-actions">
            <button className="btn primary" onClick={() => onExplore('overview')}>Explore the report <ArrowRight size={18} /></button>
            <button className="btn" onClick={() => onExplore('readback')}>Answer the questions</button>
            <button className="btn" onClick={() => { go(0); setPlaying(true); }}>Watch again</button>
          </div>
        )}
      </div>

      <footer className="f-controls">
        <button className="icon-btn" aria-label={playing ? 'Pause' : 'Play'} onClick={() => setPlaying(!playing)}>
          {playing ? <Pause size={20} weight="fill" /> : <Play size={20} weight="fill" />}
        </button>
        <button className="icon-btn" aria-label="Previous scene" onClick={() => go(i - 1)}><CaretLeft size={20} /></button>
        <button className="icon-btn" aria-label="Next scene" onClick={() => go(i + 1)}><CaretRight size={20} /></button>
        <div className="f-track">
          {scenes.map((s, n) => (
            <button key={n} className={`f-seg ${n === i ? 'now' : ''}`} style={{ flexGrow: Math.max(s.ms, 1800) }} aria-label={`Scene ${n + 1}: ${s.chapter}`} onClick={() => go(n)}>
              <span ref={(el) => { fill.current[n] = el; }} />
            </button>
          ))}
        </div>
        <span className="f-time" ref={time}>{clock(starts[i])} / {clock(total)}</span>
        <button
          className="icon-btn"
          aria-pressed={voiceOn}
          disabled={!voice}
          title={voice ? `Read aloud with ${voice.name}, on this device` : 'No offline voice on this device'}
          aria-label={voiceOn ? 'Turn the voice off' : 'Read it aloud'}
          onClick={() => setVoiceOn(!voiceOn)}
        >
          {voiceOn ? <SpeakerHigh size={20} /> : <SpeakerSlash size={20} />}
        </button>
      </footer>
    </div>
  );
}
