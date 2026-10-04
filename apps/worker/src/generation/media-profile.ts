/**
 * The one media profile and the one ffprobe call. Verified import (`import.ts`) and the
 * `media_conformance` publication gate both enforce this profile: keeping a single copy means the
 * gate re-checks exactly what import enforced (ADR-0023 section 4, ADR-0024). Each caller keeps
 * its own reason codes and checks; only the identical pieces live here.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// The stated tolerance for "9:16": within 2% of the 9/16 ratio. A caller that needs a different
// tolerance is a contract change, not a runtime parameter — this module keeps it fixed and named.
export const MEDIA_PROFILE = {
  aspectTarget: 9 / 16,
  aspectToleranceRatio: 0.02,
  minDurationSeconds: 5,
  maxDurationSeconds: 120,
} as const;

export interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
}
export interface FfprobeFormat {
  format_name?: string;
  duration?: string;
  tags?: { major_brand?: string };
}
export interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

export async function ffprobeJson(path: string): Promise<FfprobeOutput | null> {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        path,
      ],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    return JSON.parse(stdout) as FfprobeOutput;
  } catch {
    return null;
  }
}
