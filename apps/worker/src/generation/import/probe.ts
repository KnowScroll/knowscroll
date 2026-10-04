/**
 * The probe half of verified import: ffprobe the staged copy and refuse anything outside the media
 * profile (MP4/H.264/AAC, 9:16, 5-120 s, `moov` before `mdat`). Reads the file only; staging,
 * hashing and the content-addressed install live in `../import.ts` (ADR-0023 section 4).
 */
import { ffprobeJson, MEDIA_PROFILE } from '../media-profile.ts';
import { readMp4BoxOrder } from '../media-store.ts';

export type ImportRefusalReason =
  | 'engine_path_not_absolute'
  | 'engine_artifact_root_unresolvable'
  | 'engine_path_missing'
  | 'engine_path_not_contained'
  | 'engine_path_is_symlink'
  | 'engine_path_is_directory'
  | 'engine_path_not_regular_file'
  | 'engine_file_empty'
  | 'engine_file_too_large'
  | 'probe_not_mp4'
  | 'probe_missing_video_stream'
  | 'probe_video_codec_not_h264'
  | 'probe_audio_codec_not_aac'
  | 'probe_aspect_ratio_not_9_16'
  | 'probe_duration_out_of_range'
  | 'probe_not_progressive'
  | 'probe_failed'
  | 'io_error';

export interface ProbeSummary {
  formatName: string;
  majorBrand: string | null;
  durationSeconds: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string | null;
  progressive: boolean;
}

const ASPECT_TARGET = MEDIA_PROFILE.aspectTarget;
const ASPECT_TOLERANCE_RATIO = MEDIA_PROFILE.aspectToleranceRatio;
const MIN_DURATION_SECONDS = MEDIA_PROFILE.minDurationSeconds;
const MAX_DURATION_SECONDS = MEDIA_PROFILE.maxDurationSeconds;

function withinAspectTolerance(width: number, height: number): boolean {
  if (!(width > 0) || !(height > 0)) return false;
  const ratio = width / height;
  return (
    Math.abs(ratio - ASPECT_TARGET) <= ASPECT_TARGET * ASPECT_TOLERANCE_RATIO
  );
}

export type ProbeCheck =
  | { ok: true; probe: ProbeSummary }
  | { ok: false; reason: ImportRefusalReason };

/**
 * Requires MP4 with an H.264 video stream, AAC audio when audio is present, 9:16 within the stated
 * tolerance, duration between 5 and 120 seconds, and `moov` before `mdat` (progressive). `format_name`
 * alone cannot distinguish MP4 from a plain MOV under ffmpeg's shared demuxer, so this also checks
 * `major_brand` is not the QuickTime brand (`qt  `); that is a real, if imperfect, limit of ffprobe.
 */
export async function probeVideo(path: string): Promise<ProbeCheck> {
  const data = await ffprobeJson(path);
  if (!data || !data.format) return { ok: false, reason: 'probe_failed' };
  const formatName = data.format.format_name ?? '';
  const majorBrand = data.format.tags?.major_brand?.trim() ?? null;
  const looksLikeMp4 =
    formatName.split(',').includes('mp4') && majorBrand !== 'qt';
  if (!looksLikeMp4) return { ok: false, reason: 'probe_not_mp4' };

  const streams = data.streams ?? [];
  const video = streams.find((entry) => entry.codec_type === 'video');
  if (!video) return { ok: false, reason: 'probe_missing_video_stream' };
  if (video.codec_name !== 'h264')
    return { ok: false, reason: 'probe_video_codec_not_h264' };
  const width = video.width ?? 0;
  const height = video.height ?? 0;
  if (!withinAspectTolerance(width, height))
    return { ok: false, reason: 'probe_aspect_ratio_not_9_16' };

  const audio = streams.find((entry) => entry.codec_type === 'audio');
  if (audio && audio.codec_name !== 'aac')
    return { ok: false, reason: 'probe_audio_codec_not_aac' };

  const durationSeconds =
    data.format.duration !== undefined ? Number(data.format.duration) : NaN;
  if (!Number.isFinite(durationSeconds))
    return { ok: false, reason: 'probe_failed' };
  if (
    durationSeconds < MIN_DURATION_SECONDS ||
    durationSeconds > MAX_DURATION_SECONDS
  ) {
    return { ok: false, reason: 'probe_duration_out_of_range' };
  }

  const boxOrder = await readMp4BoxOrder(path);
  const progressive =
    boxOrder.moovOffset !== null &&
    (boxOrder.mdatOffset === null || boxOrder.moovOffset < boxOrder.mdatOffset);
  if (!progressive) return { ok: false, reason: 'probe_not_progressive' };

  return {
    ok: true,
    probe: {
      formatName,
      majorBrand,
      durationSeconds,
      width,
      height,
      videoCodec: video.codec_name ?? 'unknown',
      audioCodec: audio?.codec_name ?? null,
      progressive,
    },
  };
}
