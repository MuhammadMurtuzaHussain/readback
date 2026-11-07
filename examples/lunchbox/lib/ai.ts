import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/** Ask the model for a lunch idea based on what the office liked before. */
export async function suggestLunch(history: string[], budget: number) {
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You suggest office lunches.' },
      { role: 'user', content: `Past orders: ${history.join(', ')}. Budget: ${budget}.` },
    ],
  });
  return res.choices[0].message.content;
}
