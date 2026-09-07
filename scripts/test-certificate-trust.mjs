// Only the disposable Actions runner trust store is changed; the application
// never installs certificates or invokes these tools on the user's machine.
import { execFileSync } from 'node:child_process';
import { mkdir, access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { X509Certificate, randomUUID } from 'node:crypto';
export async function trustTestCertificate(file) {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Automatic certificate trust is restricted to disposable GitHub Actions runners.');
  const cert = new X509Certificate(await readFile(file));
  const run = args => execFileSync(process.platform === 'win32' ? 'certutil.exe' : 'certutil', args, { stdio: 'pipe', timeout: 15000 });
  if (process.platform === 'win32') {
    // Hosted Windows runners are administrators without an interactive desktop.
    // CurrentUser root imports can wait for a trust dialog; use the disposable
    // runner's machine store and remove this exact certificate during cleanup.
    run(['-f', '-addstore', 'Root', file]);
    return () => run(['-delstore', 'Root', cert.fingerprint.replaceAll(':', '')]);
  }
  if (process.platform !== 'linux') throw new Error('Certificate trust test supports Linux and Windows runners.');
  const legacy = path.join(homedir(), '.pki/nssdb');
  const directory = await access(path.join(legacy, 'cert9.db')).then(() => legacy, () => path.join(homedir(), '.local/share/pki/nssdb'));
  await mkdir(directory, { recursive: true });
  const db = `sql:${directory}`;
  if (!await access(path.join(directory, 'cert9.db')).then(() => true, () => false)) run(['-d', db, '-N', '--empty-password']);
  const nickname = `voidplayer-test-${randomUUID()}`;
  run(['-d', db, '-A', '-t', 'C,,', '-n', nickname, '-i', file]);
  return () => run(['-d', db, '-D', '-n', nickname]);
}
