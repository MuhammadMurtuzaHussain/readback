import { NextResponse } from 'next/server';
import { deleteOrder } from '@/lib/orders';

// TODO: add auth before launch
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  await deleteOrder(params.id);
  return NextResponse.json({ ok: true });
}
