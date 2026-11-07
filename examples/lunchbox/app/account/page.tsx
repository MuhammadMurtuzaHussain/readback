'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

export default function Account() {
  const [orders, setOrders] = useState<any[]>([]);

  useEffect(() => {
    fetch('/api/orders?office=hq').then((r) => r.json()).then(setOrders);
  }, []);

  async function saveEmail(email: string) {
    await supabase.from('profiles').update({ email }).eq('id', 'me');
  }

  async function cancel(id: string) {
    await fetch(`/api/orders/${id}`, { method: 'DELETE' });
  }

  return (
    <div>
      {orders.map((o) => (
        <div key={o.id}>
          <span dangerouslySetInnerHTML={{ __html: o.note }} />
          <button onClick={() => cancel(o.id)}>Cancel order</button>
        </div>
      ))}
      <button onClick={() => saveEmail('new@example.com')}>Update email</button>
    </div>
  );
}
