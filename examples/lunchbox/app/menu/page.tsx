import { supabase } from '@/lib/supabase';

export default async function Menu() {
  const { data } = await supabase.from('menu_items').select('*');
  return <ul>{data?.map((m) => <li key={m.id}>{m.name}</li>)}</ul>;
}
