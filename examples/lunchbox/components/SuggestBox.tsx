'use client';
import { useState } from 'react';

export function SuggestBox() {
  const [idea, setIdea] = useState('');

  const suggest = async () => {
    const res = await fetch('/api/suggest', {
      method: 'POST',
      body: JSON.stringify({ history: ['ramen', 'tacos'], budget: 15 }),
    });
    const data = await res.json();
    setIdea(data.idea);
  };

  return (
    <section>
      <button onClick={suggest}>Suggest lunch</button>
      <p>{idea}</p>
    </section>
  );
}
