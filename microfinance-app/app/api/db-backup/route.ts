import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUserId } from '../../../lib/auth';
import { backupErrorMessage, createDatabaseBackup } from '../../../lib/dbBackup';

// Download a zipped dump of the database (signed-in admin or partner).
export async function GET(request: NextRequest) {
  const userId = await getCurrentUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  try {
    const { buffer, fileName } = await createDatabaseBackup();

    return new NextResponse(buffer as any, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Content-Length': buffer.length.toString(),
      },
    });
  } catch (error) {
    // lib/dbBackup has already logged a redacted reason; the client only gets a generic message.
    return NextResponse.json(
      { error: backupErrorMessage(error), timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}
