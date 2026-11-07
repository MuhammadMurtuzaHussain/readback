import { useState } from 'react';
import { useR } from './ctx';
import { narrate, PROVIDERS } from './narrationClient';
import type { NarrationResult } from './narrationClient';

/** Optional and off by default. Nothing is sent until the person presses the button. */
export function Narrate() {
  const { report } = useR();
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState(PROVIDERS[0].id);
  const [model, setModel] = useState(PROVIDERS[0].model);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<NarrationResult | null>(null);
  const [err, setErr] = useState('');
  const p = PROVIDERS.find((x) => x.id === provider)!;

  const run = async (): Promise<void> => {
    setBusy(true);
    setErr('');
    try {
      setOut(await narrate(report, { provider, model, key }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  if (out) {
    return (
      <div className="narr">
        <h3>Written by {out.model}, not by the code analysis</h3>
        <p>{out.text}</p>
        <p className="narr-note">
          {out.dropped.length
            ? `I removed ${out.dropped.length} sentence${out.dropped.length === 1 ? '' : 's'} because they named things not in the facts: ${out.dropped.slice(0, 2).join(' ')}`
            : 'Every file and service it names is in the facts above.'}
        </p>
      </div>
    );
  }

  if (!open) {
    return <p className="key"><button className="claim inferred" onClick={() => setOpen(true)}>Want this told as a story? Add a model.</button></p>;
  }

  return (
    <div className="narr">
      <h3>Optional narration</h3>
      <p>A model can retell the facts above in friendlier words. It sees only the facts in this report, never your whole code. Without it, everything still works.</p>
      <div className="narr-form">
        <label>Provider
          <select value={provider} onChange={(e) => { setProvider(e.target.value); setModel(PROVIDERS.find((x) => x.id === e.target.value)!.model); }}>
            {PROVIDERS.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </label>
        <label>Model
          <input value={model} onChange={(e) => setModel(e.target.value)} />
        </label>
        {p.needsKey && (
          <label>API key, kept in this tab only
            <input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} />
          </label>
        )}
        <button className="btn" disabled={busy || (p.needsKey && !key)} onClick={run}>{busy ? 'Writing...' : 'Narrate'}</button>
        {err && <p className="err">{err}</p>}
      </div>
    </div>
  );
}
