import { ArrowRight, Check, X } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';
import { CONCEPTS } from '../../engine/concepts';
import { save, store, useR } from '../ctx';

type Answers = Record<string, string[]>;

export function Readback() {
  const { report: r, show, go } = useR();
  const key = `readback:answers:${r.project.name}`;
  const [answers, setAnswers] = useState<Answers>(() => store<Answers>(key, {}));
  const qs = r.questions;
  const [at, setAt] = useState(() => {
    const first = qs.findIndex((q) => !answers[q.id]);
    return first === -1 ? qs.length : first;
  });
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => save(key, answers), [answers, key]);
  useEffect(() => setPicked([]), [at]);

  const correct = (id: string): boolean => {
    const q = qs.find((x) => x.id === id);
    const a = answers[id];
    if (!q || !a) return false;
    return a.length === q.answer.length && a.every((x) => q.answer.includes(x));
  };
  const score = useMemo(() => qs.filter((q) => correct(q.id)).length, [answers, qs]);

  if (!qs.length) {
    return (
      <div className="stage">
        <h1 className="title">Not enough here to test you on</h1>
        <p className="lede">Questions are built from facts in your code, and I could not find enough of them. Try a project with screens or routes.</p>
      </div>
    );
  }

  const q = qs[at];
  const answered = q ? answers[q.id] : undefined;
  const submit = (ids: string[]): void => setAnswers({ ...answers, [q.id]: ids });
  const pick = (id: string): void => {
    if (answered) return;
    if (!q.multi) {
      submit([id]);
      return;
    }
    setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  };

  const side = (
    <aside className="rb-side">
      <ol>
        {qs.map((x, i) => (
          <li key={x.id}>
            <button aria-current={i === at ? 'step' : undefined} aria-label={`Question ${i + 1}`} className={answers[x.id] ? (correct(x.id) ? 'ok' : 'no') : ''} onClick={() => setAt(i)}>{i + 1}</button>
          </li>
        ))}
      </ol>
      <p className="hint">You can only explain what you can answer without looking. Try to answer before you read the options.</p>
    </aside>
  );

  if (!q) {
    const missed = qs.filter((x) => !correct(x.id));
    return (
      <div className="stage">
        <div className="rb">
          <div>
            <div className="score">{score} of {qs.length}</div>
            <h1 className="title" style={{ marginTop: 10 }}>{score === qs.length ? 'You can explain this app.' : score >= qs.length * 0.7 ? 'You know most of it.' : 'Some of this app is still a stranger.'}</h1>
            <p className="lede">{missed.length ? 'Go back over the ones you missed, then try again. These are the questions a teammate, a judge or an interviewer would ask.' : 'Now try saying it out loud, without the screen.'}</p>
            <div className="evlinks" style={{ marginTop: 18, display: 'grid' }}>
              {missed.map((x) => <button key={x.id} onClick={() => setAt(qs.indexOf(x))}>{x.ask}</button>)}
            </div>
            <button className="btn" style={{ marginTop: 24 }} onClick={() => { setAnswers({}); setAt(0); }}>Start again</button>
          </div>
          {side}
        </div>
      </div>
    );
  }

  const concept = q.concept ? CONCEPTS[q.concept] : undefined;
  const right = answered ? correct(q.id) : false;
  return (
    <div className="stage">
      <div className="rb">
        <div>
          <p className="rb-topic">{q.topic}, question {at + 1} of {qs.length}</p>
          <h1 className="rb-q">{q.ask}</h1>
          {q.multi && !answered && <p className="hint">Choose all that apply.</p>}
          <div className="opts">
            {q.options.map((o) => {
              const sel = (answered ?? picked).includes(o.id);
              const isRight = q.answer.includes(o.id);
              const cls = ['opt', q.multi ? 'multi' : '', o.mono ? 'mono-t' : '', sel ? 'sel' : '', answered && isRight ? 'right' : '', answered && sel && !isRight ? 'wrong' : ''].join(' ');
              return (
                <button key={o.id} className={cls} disabled={!!answered} onClick={() => pick(o.id)}>
                  <span className="box">{answered && isRight ? <Check size={13} weight="bold" /> : answered && sel ? <X size={13} weight="bold" /> : null}</span>
                  <span>{o.text}</span>
                </button>
              );
            })}
          </div>
          {q.multi && !answered && <button className="btn primary" style={{ marginTop: 16 }} disabled={!picked.length} onClick={() => submit(picked)}>Check my answer</button>}
          {answered && (
            <div className="verdict">
              <b>{right ? 'Correct.' : 'Not quite.'}</b>
              <p>{q.explain}</p>
              {concept && <p>{concept.plain}</p>}
              {q.evidence.length > 0 && (
                <div className="evlinks" style={{ marginTop: 10 }}>
                  {q.evidence.map((e, i) => <button key={i} onClick={() => show({ title: 'Where this comes from', evidence: [e] })}>{e.file}:{e.line}</button>)}
                </div>
              )}
              <button className="next" style={{ marginTop: 20 }} onClick={() => setAt(at + 1)}>{at + 1 < qs.length ? 'Next question' : 'See how you did'} <ArrowRight size={18} /></button>
            </div>
          )}
          {!answered && at > 0 && <button className="hint" style={{ display: 'block', textDecoration: 'underline' }} onClick={() => go('journeys')}>Stuck? Go back to the journeys.</button>}
        </div>
        {side}
      </div>
    </div>
  );
}
