// Dev-only: renders the origin opening's score offline in Chromium (OfflineAudioContext, the same
// builder the live sound uses), writes a float WAV and prints per-cue measurements, then loudness
// and pictures via ffmpeg when it is installed. Nothing ships this; it exists because a score
// nobody can listen to in CI still has to be checked by numbers.
//
//   node scripts/render-origin-score.mjs [--out artifacts/origin-score.wav] [--from 0] [--port 4411]
//
// It starts its own Vite dev server on a loopback port and stops that process (by PID) at the end.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const out = resolve(option('out', `${web}/artifacts/origin-score.wav`));
const from = Number(option('from', '0'));
const port = Number(option('port', '4411'));
const base = `http://127.0.0.1:${port}`;

const vite = spawn(process.execPath, [`${web}/node_modules/vite/bin/vite.js`, '--port', String(port), '--strictPort'], {
  cwd: web,
  env: { ...process.env, PORT: String(port) },
  stdio: 'ignore',
});

try {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/src/cosmos/originSound.ts`)).ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`Vite did not start on ${base}`);
    await new Promise(r => setTimeout(r, 250));
  }

  const browser = await chromium.launch();
  let result;
  try {
    const page = await browser.newPage();
    await page.goto(`${base}/src/cosmos/originSound.ts`);
    result = await page.evaluate(async start => {
      const score = await import('/src/cosmos/originSound.ts');
      const buffer = await score.renderOriginScore(48000, start);
      const probe = new OfflineAudioContext(2, 128, 48000);
      const { stats } = score.scheduleScore(probe, probe.destination, { from: start, when: 0 });
      const encode = data => {
        const bytes = new Uint8Array(data.buffer);
        let text = '';
        for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(text);
      };
      return { sampleRate: buffer.sampleRate, channels: [encode(buffer.getChannelData(0)), encode(buffer.getChannelData(1))], stats, cues: score.CUES, heartbeats: score.HEARTBEATS };
    }, from);
  } finally {
    await browser.close();
  }

  const rate = result.sampleRate;
  const [left, right] = result.channels.map(b64 => {
    const bytes = Buffer.from(b64, 'base64');
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  });

  // Float WAV (IEEE, stereo, interleaved).
  const frames = left.length;
  const wav = Buffer.alloc(44 + frames * 8);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + frames * 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(3, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 8, 28);
  wav.writeUInt16LE(8, 32);
  wav.writeUInt16LE(32, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(frames * 8, 40);
  for (let i = 0; i < frames; i++) {
    wav.writeFloatLE(left[i], 44 + i * 8);
    wav.writeFloatLE(right[i], 48 + i * 8);
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, wav);

  // Measurements in opening time. "hf" is a first difference (a crude high-pass) so a bell or a
  // pluck shows over the pads; "low" is a one-pole low-pass at ~150 Hz for the thumps.
  const mono = Float32Array.from(left, (v, i) => (v + right[i]) / 2);
  const hf = Float32Array.from(mono, (v, i) => v - (mono[i - 1] ?? 0));
  const low = new Float32Array(frames);
  const k = Math.exp((-2 * Math.PI * 150) / rate);
  for (let i = 0, y = 0; i < frames; i++) low[i] = y = (1 - k) * mono[i] + k * y;
  const index = t => Math.max(0, Math.min(frames, Math.round((t - from) * rate)));
  const db = (data, a, b) => {
    let sum = 0;
    const [i, j] = [index(a), index(b)];
    for (let n = i; n < j; n++) sum += data[n] * data[n];
    return j > i ? 10 * Math.log10(sum / (j - i) + 1e-20) : -200;
  };
  const rows = [];
  const row = (label, value) => rows.push(`${label.padEnd(44)} ${value}`);
  const rise = (data, t, before = 0.08, after = 0.06) => (db(data, t, t + after) - db(data, t - before, t - 0.01)).toFixed(1);
  let peak = 0;
  let peakAt = 0;
  for (let i = 0; i < frames; i++) {
    const v = Math.max(Math.abs(left[i]), Math.abs(right[i]));
    if (v > peak) [peak, peakAt] = [v, from + i / rate];
  }
  const { cues } = result;
  const windows = [
    ['0.0-1.8 before form (near silence)', 0, 1.8],
    ['1.8-3.58 riser', 1.8, 3.58],
    ['3.60-4.10 expansion hit', 3.6, 4.1],
    ['4.5-8.6 expansion bed', 4.5, 8.6],
    ['8.6-11.7 first stars bed', 8.6, 11.7],
    ['11.7-13.6 bells', 11.7, 13.6],
    ['13.6-15.4 transformation', 13.6, 15.4],
    ['15.4-17.2 heartbeat + cluster', 15.4, 17.2],
    ['17.2-19.6 release + choir', 17.2, 19.6],
    ['19.6-25.2 new worlds', 19.6, 25.2],
    ['25.2-26.2 your universe', 25.2, 26.2],
    ['26.2-28.4 handoff fade', 26.2, 28.4],
    ['28.4-29.5 tail', 28.4, 29.5],
    ['29.5-30.0 tail (must be gone)', 29.5, 30],
  ];
  for (const [label, a, b] of windows) if (b > from) row(label, `${db(mono, Math.max(a, from), b).toFixed(1)} dBFS rms`);
  if (cues.expansion >= from) row('expansion onset rise (broadband, dB)', rise(mono, cues.expansion, 0.12, 0.08));
  cues.ignitions.forEach((t, i) => t >= from && row(`bell ${i} at ${t.toFixed(2)} onset rise (hf, dB)`, rise(hf, t)));
  result.heartbeats.forEach((t, i) => t >= from && row(`heartbeat ${i} at ${t.toFixed(3)} onset rise (low, dB)`, rise(low, t, 0.1, 0.1)));
  if (cues.release >= from) row('release: 17.3-18.5 vs 16.0-16.8 (dB)', (db(mono, 17.3, 18.5) - db(mono, 16.0, 16.8)).toFixed(1));
  cues.worlds.forEach((t, i) => t >= from && row(`world ${i} pluck at ${t.toFixed(2)} onset rise (hf, dB)`, rise(hf, t)));
  row('sample peak', `${(20 * Math.log10(peak)).toFixed(2)} dBFS at ${peakAt.toFixed(3)} s`);
  // Loudest 50 ms window and when it falls.
  let loudest = [-200, 0];
  for (let t = from; t < 30 - 0.05; t += 0.025) {
    const v = db(mono, t, t + 0.05);
    if (v > loudest[0]) loudest = [v, t];
  }
  row('loudest 50 ms window', `${loudest[0].toFixed(1)} dBFS at ${loudest[1].toFixed(3)} s`);
  const { stats } = result;
  row('oscillators / noise sources / nodes', `${stats.oscillators} / ${stats.noiseSources} / ${stats.nodes}`);
  row('peak simultaneous sources', String(stats.peakSources));
  row('first cue scheduled', stats.cues.length ? `${stats.cues[0].name} at ${stats.cues[0].t.toFixed(3)} s` : 'none');
  row('layers joined at start', stats.layers.filter(layer => layer.from === from).map(layer => layer.name).join(', ') || 'none');
  console.log(`${out}\n${rows.join('\n')}`);

  const ffmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (ffmpeg.status === 0) {
    const loud = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', out, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8' });
    const summary = loud.stderr.slice(loud.stderr.lastIndexOf('Summary:'));
    console.log(summary.trim());
    const stem = out.replace(/\.wav$/, '');
    spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', out, '-lavfi', 'showspectrumpic=s=1800x900:legend=1:fscale=log:scale=log:start=20:stop=16000', `${stem}-spectrum.png`]);
    spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', out, '-lavfi', 'showwavespic=s=1800x500:split_channels=1:scale=sqrt', `${stem}-waveform.png`]);
    console.log(`${stem}-spectrum.png\n${stem}-waveform.png`);
  }
} finally {
  vite.kill('SIGTERM');
}
