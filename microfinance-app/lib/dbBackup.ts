import { execFile } from 'child_process';
import { createWriteStream, promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import archiver from 'archiver';

/**
 * Database backups (GET /api/db-backup and the scheduled /api/scheduled/db-backup*).
 *
 * The dump tool runs with execFile and an argument array (no shell), the password goes
 * through the environment (PGPASSWORD / MYSQL_PWD) and never into argv, files live in a
 * private mkdtemp directory that is removed afterwards, and failures surface only as a
 * generic BackupError: the underlying error (which can carry the command line, the
 * DATABASE_URL or the password) is logged server-side after redaction and never returned.
 */

export interface DbBackupResult {
  buffer: Buffer;
  /** Download / attachment name of the zip. */
  fileName: string;
}

/** The only error this module throws; its message is safe to show and store. */
export class BackupError extends Error {
  constructor(message = 'Backup failed') {
    super(message);
    this.name = 'BackupError';
  }
}

interface DumpTarget {
  kind: 'postgres' | 'mysql';
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  sslmode?: string;
}

function parseDatabaseUrl(urlStr: string): DumpTarget {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw new BackupError('Backup failed: DATABASE_URL is not a valid URL');
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);

  if (url.protocol === 'postgres:' || url.protocol === 'postgresql:') {
    // libpq-style ?host=/path/to/socket overrides the URL host (used for local sockets).
    const host = url.searchParams.get('host') || url.hostname || 'localhost';
    return {
      kind: 'postgres',
      host,
      port: url.port || '5432',
      database,
      user,
      password,
      sslmode: url.searchParams.get('sslmode') || undefined,
    };
  }

  if (url.protocol === 'mysql:') {
    return { kind: 'mysql', host: url.hostname, port: url.port || '3306', database, user, password };
  }

  throw new BackupError('Backup failed: unsupported database type');
}

/** Removes anything that could reveal the connection string or password from a log line. */
function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 3) out = out.split(secret).join('***');
  }
  // Any URL with credentials (scheme://user:pass@host...).
  return out.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"]*@[^\s'"]*/gi, '<redacted-url>');
}

function runDump(target: DumpTarget, outFile: string): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  let bin: string;
  let args: string[];

  if (target.kind === 'postgres') {
    bin = 'pg_dump';
    args = ['--host', target.host, '--port', target.port, '--username', target.user, '--no-password',
      '--format', 'plain', '--file', outFile, '--dbname', target.database];
    if (target.password) env.PGPASSWORD = target.password;
    if (target.sslmode) env.PGSSLMODE = target.sslmode;
  } else {
    bin = 'mysqldump';
    args = [`--host=${target.host}`, `--port=${target.port}`, `--user=${target.user}`,
      `--result-file=${outFile}`, target.database];
    if (target.password) env.MYSQL_PWD = target.password;
  }

  return new Promise((resolve, reject) => {
    execFile(bin, args, { env, maxBuffer: 10 * 1024 * 1024, timeout: 10 * 60 * 1000 }, (err, _stdout, stderr) => {
      if (!err) return resolve();
      const secrets = [target.password, process.env.DATABASE_URL ?? ''];
      const code = (err as NodeJS.ErrnoException).code;
      const reason = code === 'ENOENT' ? `${bin} is not installed or not on PATH` : `${bin} exited with code ${code ?? 'unknown'}`;
      console.error(`Database backup failed: ${reason}${stderr ? ` | stderr: ${redact(String(stderr).slice(0, 500), secrets)}` : ''}`);
      reject(new BackupError(code === 'ENOENT' ? 'Backup failed: backup tool not available on the server' : 'Backup failed'));
    });
  });
}

function zipFile(source: string, entryName: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(dest);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', () => resolve());
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.file(source, { name: entryName });
    archive.finalize();
  });
}

/**
 * Dumps the database named by DATABASE_URL (PostgreSQL via pg_dump, MySQL via mysqldump)
 * and returns it as a zipped buffer. Temporary files are always removed.
 * Throws BackupError only.
 */
export async function createDatabaseBackup(): Promise<DbBackupResult> {
  const { DATABASE_URL } = process.env;
  if (!DATABASE_URL) throw new BackupError('Backup failed: database is not configured');

  const target = parseDatabaseUrl(DATABASE_URL);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dumpName = `db-backup-${stamp}.sql`;
  const fileName = `db-backup-${stamp}.zip`;

  let dir: string | null = null;
  try {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'db-backup-'));
    const dumpPath = path.join(dir, dumpName);
    const zipPath = path.join(dir, fileName);

    await runDump(target, dumpPath);
    await zipFile(dumpPath, dumpName, zipPath);
    const buffer = await fs.readFile(zipPath);
    return { buffer, fileName };
  } catch (error) {
    if (error instanceof BackupError) throw error;
    console.error('Database backup failed while packaging:', redact(String(error), [target.password, DATABASE_URL]));
    throw new BackupError();
  } finally {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Message safe to return to clients or store in EmailLog for any backup-route failure. */
export function backupErrorMessage(error: unknown): string {
  return error instanceof BackupError ? error.message : 'Backup failed';
}

/** Server-side log for a failure around a backup (e.g. the email step), with secrets redacted. */
export function logBackupFailure(context: string, error: unknown): void {
  if (error instanceof BackupError) return; // already logged (redacted) where it happened
  const dbUrl = process.env.DATABASE_URL ?? '';
  let password = '';
  try {
    password = decodeURIComponent(new URL(dbUrl).password);
  } catch {}
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(`${context}: ${redact(text.slice(0, 500), [password, dbUrl])}`);
}
