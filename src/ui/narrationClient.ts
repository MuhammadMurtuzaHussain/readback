import type { Report } from '../engine/types';

export const PROVIDERS = [
  { id: 'ollama', name: 'Ollama on this computer', model: 'llama3.2', needsKey: false },
  { id: 'anthropic', name: 'Anthropic', model: 'claude-haiku-5-5', needsKey: true },
  { id: 'openai', name: 'OpenAI', model: 'gpt-4o-mini', needsKey: true },
];

export interface NarrationResult {
  model: string;
  text: string;
  dropped: string[];
}

/** Only facts go out: names and counts, no source code. */
export function factSheet(r: Report): string {
  const lines: string[] = [];
  lines.push(`Project: ${r.project.name}. Kind: ${r.project.shape}.`);
  if (r.project.readmeLine) lines.push(`README: ${r.project.readmeLine}`);
  lines.push(`Screens: ${r.screens.slice(0, 12).map((s) => s.path).join(', ') || 'none'}.`);
  lines.push(`Server routes: ${r.routes.slice(0, 16).map((x) => `${x.method} ${x.path}`).join(', ') || 'none'}.`);
  lines.push(`Outside services: ${r.services.filter((s) => s.operations.length).map((s) => s.name).join(', ') || 'none'}.`);
  for (const j of r.journeys.slice(0, 4)) lines.push(`Journey "${j.title}": ${j.steps.map((s) => s.title).join(' ')}`);
  for (const x of r.risks.slice(0, 4)) lines.push(`Risk: ${x.title}.`);
  return lines.join('\n');
}

const PROMPT = `You are explaining someone's own app back to them. They did not write the code and are not technical.
Using ONLY the facts below, write one short paragraph of 4 to 6 sentences explaining what the app does and how one action moves through it.
Use the names exactly as written. Do not add any file, route, service or technology that is not in the facts. Do not give advice.

FACTS:
`;

/** Anything that looks like a code name in the output must exist in the facts, or the sentence goes. */
export function checkAgainstFacts(text: string, facts: string): { text: string; dropped: string[] } {
  const sentences = text.replace(/\s+/g, ' ').trim().replace(/^(here('s| is)|sure)[^:]{0,60}:\s*/i, '').split(/(?<=[.!?])\s+/);
  const kept: string[] = [];
  const dropped: string[] = [];
  const hay = facts.toLowerCase();
  const techWords = /\b(Redis|Postgres|MongoDB|Firebase|Stripe|Supabase|OpenAI|Anthropic|Clerk|Prisma|GraphQL|Kafka|AWS|Docker|Kubernetes)\b/g;
  for (const raw of sentences) {
    const s = raw.trim();
    const names = [...s.matchAll(/[\w@.-]*\/[\w@.:/-]+|\b[\w-]+\.(?:tsx?|jsx?|py|sql|json)\b/g)].map((m) => m[0].replace(/[.,]$/, ''));
    const tech = [...s.matchAll(techWords)].map((m) => m[0]);
    const bad = [...names, ...tech].some((n) => !hay.includes(n.toLowerCase()));
    (bad ? dropped : kept).push(s);
  }
  return { text: kept.join(' '), dropped };
}

export async function narrate(r: Report, opts: { provider: string; model: string; key: string }): Promise<NarrationResult> {
  const facts = factSheet(r);
  const body = PROMPT + facts;
  let text = '';
  if (opts.provider === 'ollama') {
    const res = await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      body: JSON.stringify({ model: opts.model, prompt: body, stream: false, options: { temperature: 0.2 } }),
    }).catch(() => {
      throw new Error('Could not reach Ollama. Is it running? From a hosted page you also need OLLAMA_ORIGINS set.');
    });
    if (!res.ok) throw new Error(`Ollama said ${res.status}. Is the model pulled?`);
    text = (await res.json()).response ?? '';
  } else if (opts.provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': opts.key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: opts.model, max_tokens: 400, messages: [{ role: 'user', content: body }] }),
    });
    if (!res.ok) throw new Error(`Anthropic said ${res.status}.`);
    text = (await res.json()).content?.[0]?.text ?? '';
  } else {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.key}` },
      body: JSON.stringify({ model: opts.model, temperature: 0.2, messages: [{ role: 'user', content: body }] }),
    });
    if (!res.ok) throw new Error(`OpenAI said ${res.status}.`);
    text = (await res.json()).choices?.[0]?.message?.content ?? '';
  }
  const checked = checkAgainstFacts(text, facts);
  return { model: opts.model, text: checked.text || 'Every sentence failed the fact check, so nothing is shown.', dropped: checked.dropped };
}
