import { ArrowRight } from '@phosphor-icons/react';
import { useState } from 'react';
import type { Sentence, Target } from '../../engine/types';
import { plural, useR } from '../ctx';
import { Narrate } from '../Narrate';

function Claim({ part }: { part: { text: string; target: Target; certainty?: string } }) {
  const { go, show } = useR();
  const t = part.target;
  return (
    <button
      type="button"
      className={`claim ${part.certainty === 'inferred' ? 'inferred' : ''}`}
      onClick={() => (t.type === 'view' ? go(t.view, t.id) : show({ title: t.title, body: t.body, evidence: t.evidence }))}
    >
      {part.text}
    </button>
  );
}

function Line({ s }: { s: Sentence }) {
  return <p>{s.parts.map((p, i) => (typeof p === 'string' ? p : <Claim key={i} part={p} />))}</p>;
}

export function Overview() {
  const { report: r, go, show } = useR();
  const [allGaps, setAllGaps] = useState(false);
  const gaps = allGaps ? r.gaps : r.gaps.slice(0, 8);
  const first = r.journeys[0];

  return (
    <div className="stage">
      <div className="ov">
        <div>
          <div className="story">{r.summary.map((s, i) => <Line key={i} s={s} />)}</div>
          <div className="key">
            <span><i>Underlined</i> means I found it in the code. Click to see where.</span>
          </div>
          <Narrate />
          {first && (
            <button className="next" onClick={() => go('journeys', first.id)}>
              Follow one thing through the app <ArrowRight size={18} />
            </button>
          )}
        </div>
        <aside className="side">
          {(r.project.readmeLine || r.project.description) && (
            <section>
              <h2>Your README says</h2>
              <blockquote>{r.project.readmeLine ?? r.project.description}</blockquote>
            </section>
          )}
          <section>
            <h2>What I read</h2>
            <div className="cov">
              {r.coverage.languages.slice(0, 5).map((l) => (
                <div key={l.name} style={{ display: 'contents' }}>
                  <span>{l.name}</span>
                  <span>{l.depth === 'traced' ? `${l.files} traced` : `${l.files} listed`}</span>
                </div>
              ))}
            </div>
          </section>
          {r.project.run.length > 0 && (
            <section>
              <h2>How it runs</h2>
              <div className="runs">
                {r.project.run.slice(0, 3).map((x) => (
                  <div key={x.name}><code>{x.command}</code><span>{x.plain}</span></div>
                ))}
              </div>
            </section>
          )}
        </aside>
      </div>

      <section className="gaps">
        <h2>{r.gaps.length ? `What I could not see (${r.gaps.length})` : 'What I could not see'}</h2>
        <p>
          {r.gaps.length
            ? 'This is everything I know I missed. A clean report does not mean a safe app, so treat anything not listed here as unproven too.'
            : 'I found nothing I could not follow, but static reading has limits: it cannot see your live settings, what your host does, or anything your code builds while running.'}
        </p>
        {gaps.length > 0 && (
          <ul className="gaplist">
            {gaps.map((g, i) => (
              <li key={i}>
                {g.evidence ? <button className="claim inferred" onClick={() => show({ title: 'Something I could not follow', body: g.text, evidence: [g.evidence!] })}>{g.text}</button> : g.text}
              </li>
            ))}
          </ul>
        )}
        {r.gaps.length > 8 && !allGaps && <button className="btn" onClick={() => setAllGaps(true)}>Show all {plural(r.gaps.length, 'item')}</button>}
      </section>
    </div>
  );
}
