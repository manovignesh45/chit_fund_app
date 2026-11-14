import { NextResponse } from 'next/server';

/**
 * An error whose message is written for the person using the app (validation, not found,
 * permission, conflict). API catch blocks may return its message and status to the client.
 * Any other error is logged server-side and answered with a generic message (errorResponse),
 * so database, file-system or library error text never reaches a client.
 */
export class PublicError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
    this.name = 'PublicError';
  }
}

/**
 * Catch-block response: a PublicError keeps its own message and status; anything else is
 * logged with `context` and answered `{ error: genericMessage }` with `status`.
 */
export function errorResponse(error: unknown, context: string, genericMessage: string, status = 500) {
  if (error instanceof PublicError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error(`${context} failed:`, error);
  return NextResponse.json({ error: genericMessage }, { status });
}
