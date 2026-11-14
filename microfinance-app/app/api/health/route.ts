import { NextResponse } from 'next/server';
import prisma from '../../../lib/prisma';

// Health check endpoint (public; used by the Docker HEALTHCHECK). Returns only a status and a
// timestamp: no counts or error text. 200 when the database answers, 503 when it does not.
export async function GET() {
  const timestamp = new Date().toISOString();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: 'ok', timestamp });
  } catch (error) {
    console.error('Health check failed:', error);
    return NextResponse.json({ status: 'error', timestamp }, { status: 503 });
  }
}
