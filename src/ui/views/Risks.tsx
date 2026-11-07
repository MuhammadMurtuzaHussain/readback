import { ArrowRight, Check, Copy, Minus, Plus } from '@phosphor-icons/react';
import { useState } from 'react';
import { CONCEPTS } from '../../engine/concepts';
import type { Risk } from '../../engine/types';
import { useR } from '../ctx';

function RiskRow({ risk, open, toggle }: { risk: Risk; open: boolean; toggle: () => void }) {
  const { show } = useR();
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(risk.fixPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      show({ title: 'Prompt for your coding assistant', body: risk.fixPrompt, evidence: [] });
    }
  };
  const concept = risk.concept ? CONCEPTS[risk.concept] : undefined;
  return (
    <div className="risk">
      <button className="risk-h" aria-expanded={open} onClick={toggle}>
        <span className={`sev ${risk.severity}`}>{risk.severity}</span>
        <b>{risk.title}</b>
        {open ? <Minus size={18} /> : <Plus size={18} />}
      </button>
      {open && (
        <div className="risk-b">
          <p>{risk.why}</p>
          <div><h4>Check it yourself</h4><p>{risk.check}</p></div>
          {risk.caveat && <div><h4>What I cannot see</h4><p>{risk.caveat}</p></div>}
          {risk.certainty === 'inferred' && !risk.caveat && <p>This is inferred from a pattern, so it could be wrong.</p>}
          {concept && <div><h4>{concept.title}</h4><p>{concept.plain}</p></div>}
          {risk.evidence.length > 0 && (
            <div className="evlinks">
              {risk.evidence.map((e, i) => (
                <button key={i} onClick={() => show({ title: risk.title, evidence: [e] })}>{e.file}:{e.line}</button>
              ))}
            </div>
          )}
          <div className="risk-actions">
            <button className="btn" onClick={copy}>
              {copied ? <Check size={18} /> : <Copy size={18} />} {copied ? 'Copied' : 'Copy fix prompt'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function Risks() {
  const { report: r, go, focus } = useR();
  const [open, setOpen] = useState<string | null>(focus ?? r.risks[0]?.id ?? null);
  const high = r.risks.filter((x) => x.severity === 'high').length;
  return (
    <div className="stage">
      <h1 className="title">{r.risks.length ? (high ? `${high} thing${high === 1 ? '' : 's'} to look at before anyone else does` : 'Nothing urgent, but worth checking') : 'Nothing matched my checks'}</h1>
      <p className="lede">
        {r.risks.length
          ? 'These come from fixed rules, not opinion, and every one shows its evidence. They are starting points, not a security audit.'
          : 'That is not the same as safe. It means none of my rules fired. These checks cover common mistakes, not all of them.'}
      </p>
      <div className="risks">
        {r.risks.map((x) => <RiskRow key={x.id} risk={x} open={open === x.id} toggle={() => setOpen(open === x.id ? null : x.id)} />)}
      </div>
      <button className="next" onClick={() => go('readback')}>Now read it back <ArrowRight size={18} /></button>
    </div>
  );
}
