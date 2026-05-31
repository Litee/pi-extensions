import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform } from 'node:os';

const execFileAsync = promisify(execFile);

export type SupportedPlatform = 'darwin' | 'linux' | 'win32';

/**
 * Detect the current OS and return a canonical platform string.
 * Throws if the platform is not supported.
 */
export function detectPlatform(): SupportedPlatform {
  const p = platform();
  if (p === 'darwin' || p === 'linux' || p === 'win32') {
    return p;
  }
  throw new Error(`Unsupported platform: ${p}`);
}

/**
 * Play a WAV file using the best available system player for the current OS.
 *
 * macOS  → afplay
 * Linux  → paplay → aplay → ffplay  (first one found in PATH)
 * Win32  → PowerShell Media.SoundPlayer
 *
 * Pass an `AbortSignal` to kill the player process mid-playback (e.g. on timeout).
 */
export async function playAudioFile(filePath: string, signal?: AbortSignal): Promise<void> {
  const os = detectPlatform();
  const opts = signal ? { signal } : {};

  if (os === 'darwin') {
    await execFileAsync('afplay', [filePath], opts);
    return;
  }

  if (os === 'linux') {
    const candidates = [
      { bin: 'paplay', args: [filePath] },
      { bin: 'aplay', args: [filePath] },
      { bin: 'ffplay', args: ['-nodisp', '-autoexit', filePath] },
    ];

    for (const { bin, args } of candidates) {
      if (await isInPath(bin)) {
        await execFileAsync(bin, args, opts);
        return;
      }
    }

    throw new Error(
      'No audio player found. Please install pulseaudio-utils (paplay), ' +
        'alsa-utils (aplay), or ffmpeg (ffplay).',
    );
  }

  if (os === 'win32') {
    const escaped = filePath.replace(/'/g, "''");
    await execFileAsync('powershell', [
      '-NoProfile',
      '-Command',
      `(New-Object Media.SoundPlayer '${escaped}').PlaySync()`,
    ], opts);
    return;
  }
}

/** Return true if `bin` resolves in the system PATH without throwing. */
async function isInPath(bin: string): Promise<boolean> {
  try {
    const checkCmd = platform() === 'win32' ? 'where' : 'which';
    await execFileAsync(checkCmd, [bin]);
    return true;
  } catch {
    return false;
  }
}
