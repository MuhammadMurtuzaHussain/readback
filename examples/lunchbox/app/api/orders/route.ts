import { NextResponse } from 'next/server';
import { createOrder, listOrders } from '@/lib/orders';

export async function GET(req: Request) {
  const officeId = new URL(req.url).searchParams.get('office') ?? '';
  return NextResponse.json(await listOrders(officeId));
}

export async function POST(req: Request) {
  const body = await req.json();
  const order = await createOrder(body);
  return NextResponse.json(order, { status: 201 });
}
