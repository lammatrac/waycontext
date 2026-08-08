import { spawn } from 'node:child_process';

function launcherForPlatform() {
  if (process.platform === 'darwin') return { command: 'open', args: [] };
  if (process.platform === 'win32') return { command: 'cmd', args: ['/c', 'start', ''] };
  return { command: 'xdg-open', args: [] };
}

/**
 * Fire-and-forget open of a local file via the platform default app.
 * Resolves once process spawn succeeds; rejects immediately when launch fails.
 */
export async function openLocalFile(filePath) {
  const launcher = launcherForPlatform();
  const args = [...launcher.args, filePath];

  await new Promise((resolve, reject) => {
    const child = spawn(launcher.command, args, {
      detached: true,
      stdio: 'ignore',
    });

    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });

  return { command: launcher.command, args };
}
