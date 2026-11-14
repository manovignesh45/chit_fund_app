import { NextRequest, NextResponse } from 'next/server';
import { verifyInternalKey } from '../../../../lib/internalAuth';
import { backupErrorMessage, createDatabaseBackup, logBackupFailure } from '../../../../lib/dbBackup';
import { sendEmail } from '../../../../lib/emailConfig';
import { logEmailSend } from '../../../../lib/emailRecovery';

function defaultRecipients(): string[] {
  const value = process.env.DEFAULT_EMAIL_RECIPIENTS;
  return value ? value.split(',').map(e => e.trim()).filter(Boolean) : [];
}

// Scheduled DB backup endpoint
export async function POST(request: NextRequest) {
  // Internal callers only (lib/scheduler.ts, lib/emailRecovery.ts); fails closed without INTERNAL_API_KEY.
  if (!verifyInternalKey(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const period = new Date().toISOString().slice(0, 7); // YYYY-MM
  const recipients = defaultRecipients();

  try {
    if (recipients.length === 0) {
      return NextResponse.json({ error: 'No recipients configured' }, { status: 400 });
    }

    // Create DB backup (zipped, in memory; temp files are already removed)
    const { buffer, fileName } = await createDatabaseBackup();

    // Email subject/body
    const subject = `Monthly Database Backup - ${period}`;
    const html = `<p>Attached is the compressed database backup for ${period}.</p>`;

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
      status: 'sent',
      recipients,
      fileName
    });

    return NextResponse.json({ success: true, fileName, recipients });
  } catch (error) {
    // Only a generic message leaves the server or reaches EmailLog; details are logged redacted.
    logBackupFailure('Scheduled DB backup failed', error);
    const message = backupErrorMessage(error);
    try {
      await logEmailSend({
        emailType: 'monthly',
        period,
        sentDate: new Date(),
        status: 'failed',
        recipients,
        errorMessage: message
      });
    } catch {}
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
