import { ArrowRight } from '@phosphor-icons/react';
import { useState } from 'react';
import type { Tech } from '../../engine/types';
import { plural, useR } from '../ctx';

function Row({ t }: { t: Tech }) {
  const { show } = useR();
  return (
    <div className="tech">
      <h3>
        <span>{t.name}</span>
        <button onClick={() => show({ title: t.name, body: t.plain, evidence: t.evidence })}>
          {t.ghost ? 'never imported' : t.importedBy ? `in ${plural(t.importedBy, 'file')}` : 'in config'}
        </button>
      </h3>
      <p>{t.plain || t.ownWords || 'I have no notes on this one.'}</p>
      {t.analogy && <p className="ana">{t.analogy}</p>}
    </div>
  );
}

export function Stack() {
  const { report: r, go, show } = useR();
  const [more, setMore] = useState(false);
  const known = r.stack.filter((t) => t.plain || t.ownWords);
  const live = known.filter((t) => !t.ghost && !t.devOnly && ['database', 'auth', 'payments', 'ai', 'email', 'storage', 'analytics', 'monitoring', 'messaging', 'queue', 'maps', 'web', 'blockchain', 'other'].includes(t.kind));
  const app = known.filter((t) => !t.ghost && !t.devOnly && !live.includes(t));
  const dev = known.filter((t) => !t.ghost && t.devOnly);
  const ghost = r.stack.filter((t) => t.ghost && !t.devOnly);
  const unknown = r.stack.filter((t) => !t.plain && !t.ownWords && !t.ghost && !t.devOnly);

  return (
    <div className="stage">
      <h1 className="title">What each technology is, and why it is here</h1>
      <p className="lede">Fixed explanations that ship with this tool, matched to what your project actually imports. No model writes these when you run it.</p>
      <div className="stackgrid">
        <div>
          <div className="stackgroup">
            <h2>Live services</h2>
            <p>Your running app needs these. If one stops, part of your app stops.</p>
            {live.length ? live.map((t) => <Row key={t.id} t={t} />) : <p className="hint">None found.</p>}
          </div>
          {ghost.length > 0 && (
            <div className="stackgroup" style={{ marginTop: 44 }}>
              <h2>Installed but never used</h2>
              <p>Coding assistants often add these and move on. Check before you remove them.</p>
              <div className="pills">
                {ghost.map((t) => <button key={t.id} className="pill" onClick={() => show({ title: t.packages[0], body: t.plain || 'Declared in your manifest. I found no import of it.', evidence: t.evidence })}>{t.packages[0]}</button>)}
              </div>
            </div>
          )}
        </div>
        <div>
          <div className="stackgroup">
            <h2>Part of your app</h2>
            <p>Code that ships with your project.</p>
            {app.slice(0, more ? undefined : 10).map((t) => <Row key={t.id} t={t} />)}
            {app.length > 10 && !more && <button className="btn" onClick={() => setMore(true)}>Show {app.length - 10} more</button>}
            {unknown.length > 0 && <p className="hint">Also uses {unknown.slice(0, 12).map((t) => t.name).join(', ')}{unknown.length > 12 ? ` and ${unknown.length - 12} more` : ''}. I have no notes on these.</p>}
          </div>
          {dev.length > 0 && (
            <div className="stackgroup" style={{ marginTop: 44 }}>
              <h2>Only while building</h2>
              <p>Never reaches your users.</p>
              <div className="pills">{dev.map((t) => <button key={t.id} className="pill" onClick={() => show({ title: t.name, body: t.plain, evidence: t.evidence })}>{t.name}</button>)}</div>
            </div>
          )}
        </div>
      </div>

      {r.tables.length > 0 && (
        <section className="datasec">
          <h2 style={{ fontSize: 24, letterSpacing: '-0.01em' }}>What you store</h2>
          <p className="lede" style={{ marginTop: 2 }}>Read from your schema and migrations. Marked fields hold personal or secret data.</p>
          <div className="tables">
            {r.tables.slice(0, 24).map((t) => (
              <div className="tbl" key={t.name}>
                <h3><button className="claim" style={{ fontFamily: 'var(--mono)' }} onClick={() => show({ title: t.name, body: `From ${t.source}.`, evidence: [t.evidence] })}>{t.name}</button></h3>
                <p>{t.writers.length ? `Written from ${plural(t.writers.length, 'file')}. ` : ''}{t.rls === false ? <span className="flag">No row level security in migrations.</span> : t.rls ? 'Row level security on.' : ''}</p>
                <div className="pills">
                  {t.fields.slice(0, 14).map((f) => <span key={f.name} className={`pill ${f.sensitive ? 'hot' : ''}`}>{f.name}</span>)}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {r.env.length > 0 && (
        <section className="datasec">
          <h2 style={{ fontSize: 24, letterSpacing: '-0.01em' }}>Settings it needs to run</h2>
          <p className="lede" style={{ marginTop: 2 }}>Move hosts and you must set all of these again. Marked ones reach the browser, so they must not be secrets.</p>
          <div className="pills">
            {r.env.map((e) => (
              <button key={e.name} className={`pill ${e.exposure === 'browser' ? 'hot' : ''}`} onClick={() => show({ title: e.name, body: e.exposure === 'browser' ? 'Copied into the JavaScript your visitors download.' : e.exposure === 'both' ? 'Read in code that also runs in the browser, where it will be empty.' : 'Only read on the server.', evidence: e.reads })}>{e.name}</button>
            ))}
          </div>
        </section>
      )}

      <button className="next" onClick={() => go('risks')}>See what could bite you <ArrowRight size={18} /></button>
    </div>
  );
}
