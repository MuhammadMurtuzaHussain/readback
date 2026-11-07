import { createClient } from '@supabase/supabase-js';

// One client, shared by the browser and the server.
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);
