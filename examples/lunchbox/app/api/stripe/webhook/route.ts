import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function POST(req: Request) {
  const event = await req.json();
  if (event.type === 'checkout.session.completed') {
    await supabase.from('orders').update({ paid: true }).eq('id', event.data.object.metadata.order_id);
  }
  return NextResponse.json({ received: true });
}
