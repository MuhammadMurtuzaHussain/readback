import { supabase } from './supabase';

export async function listOrders(officeId: string) {
  const { data } = await supabase.from('orders').select('*').eq('office_id', officeId);
  return data ?? [];
}

export async function createOrder(input: { office_id: string; item: string; price: number; email: string }) {
  const { data, error } = await supabase.from('orders').insert(input).select().single();
  if (error) throw error;
  return data;
}

export async function deleteOrder(id: string) {
  await supabase.from('orders').delete().eq('id', id);
}
