import { NextResponse } from 'next/server';
import { greet } from '../../../lib/main';

export function GET() {
  return NextResponse.json({ hello: greet() });
}
