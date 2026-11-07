'use client';
import { useState } from 'react';

export function OrderForm() {
  const [item, setItem] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await fetch('/api/orders', {
      method: 'POST',
      body: JSON.stringify({ office_id: 'hq', item, price: 12, email: 'someone@example.com' }),
    });
  }

  return (
    <form onSubmit={handleSubmit}>
      <input value={item} onChange={(e) => setItem(e.target.value)} placeholder="What do you want?" />
      <button type="submit">Place order</button>
    </form>
  );
}
