import { NextRequest, NextResponse } from 'next/server';
import { verifyInternalKey } from '../../../../../lib/internalAuth';
import { backupErrorMessage, createDatabaseBackup, logBackupFailure } from '../../../../../lib/dbBackup';
import { sendEmail } from '../../../../../lib/emailConfig';
import { logEmailSend } from '../../../../../lib/emailRecovery';

function defaultRecipients(): string[] {
  const value = process.env.DEFAULT_EMAIL_RECIPIENTS;
  return value ? value.split(',').map(e => e.trim()).filter(Boolean) : [];
}

// Recovery endpoint for missed DB backups
export async function POST(request: NextRequest) {
  // Internal callers only (lib/scheduler.ts, lib/emailRecovery.ts); fails closed without INTERNAL_API_KEY.
  if (!verifyInternalKey(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Parse request body
  const body = await request.json().catch(() => null);
  const period = body?.period;
  if (typeof period !== 'string' || !/^\d{4}-\d{2}$/.test(period)) {
    return NextResponse.json({ error: 'Invalid period format. Expected YYYY-MM' }, { status: 400 });
  }

  const recipients = defaultRecipients();

  try {
    if (recipients.length === 0) {
      return NextResponse.json({ error: 'No recipients configured' }, { status: 400 });
    }

    // Create DB backup (for the current DB state, as point-in-time recovery is not supported)
    const { buffer, fileName } = await createDatabaseBackup();

    // Email subject/body
    const subject = `[RECOVERY] Monthly Database Backup - ${period}`;
    const html = `<p>This is a <strong>recovery email</strong> for the missed database backup for ${period}.<br>Attached is the current database backup.</p>`;

    // Send email
    await sendEmail({
      to: recipients,
      subject,
      html,
      attachments: [{
        filename: fileName,
        content: buffer,
        contentType: 'application/zip'
      }]
    });

    // Log
    await logEmailSend({
      emailType: 'monthly',
      period,
      sentDate: new Date(),
      status: 'recovered',
      recipients,
      fileName,
      isRecovery: true
    });

    return NextResponse.json({ success: true, fileName, recipients, isRecovery: true });
  } catch (error) {
    // Only a generic message leaves the server or reaches EmailLog; details are logged redacted.
    logBackupFailure('Recovery DB backup failed', error);
    const message = backupErrorMessage(error);
    try {
      await logEmailSend({
        emailType: 'monthly',
        period,
        sentDate: new Date(),
        status: 'failed',
        recipients,
        isRecovery: true,
        errorMessage: message
      });
    } catch {}
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
