import { NextResponse } from 'next/server';
import { suggestLunch } from '@/lib/ai';

export async function POST(req: Request) {
  const { history, budget } = await req.json();
  const idea = await suggestLunch(history, budget);
  return NextResponse.json({ idea });
}
