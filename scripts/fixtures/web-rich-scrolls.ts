/** Author two checked, source-free interactive Scroll examples in a disposable preview only.
 * This is authored test content. It is never a model output or a production publication path.
 */
import {
  webScrollBlockV1,
  type WebScrollBlockV1,
} from '../../packages/contracts/src/web-scroll-artifact.ts';
import { createAuthoredTestScrollWebArtifact } from '../../packages/core/src/scrolls/web-artifact.ts';

const configured = process.env.DATABASE_URL;
if (!configured || process.env.KS_RICH_SCROLL_FIXTURE !== '1')
  throw new Error('Explicit disposable rich Scroll fixture required');
const db = new URL(configured);
if (
  !['127.0.0.1', 'localhost', '::1'].includes(db.hostname) ||
  !/^knowscroll_(?:test|preview)_[a-z0-9_]+$/.test(db.pathname.slice(1))
) {
  throw new Error('Disposable loopback database required');
}
const { pool } = await import('../../packages/db/src/index.ts');

type Row = { id: string; revision: number; title: string; body: string };
function paragraphs(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}
function textBlock(paragraph: string): WebScrollBlockV1 {
  return { type: 'text', paragraphs: [paragraph] };
}

function tideBlocks(body: string): WebScrollBlockV1[] {
  const parts = paragraphs(body);
  if (parts.length !== 3 || !parts[1]?.includes('crest of that wave'))
    throw new Error('Tide fixture source changed; review its blocks');
  return webScrollBlockV1.array().parse([
    textBlock(parts[0]!),
    {
      type: 'visualization',
      title: 'A wave you can reshape',
      description:
        'An illustrative repeating wave, not a tide forecast. Move the slider and compare the curve with the table.',
      frequency: 1,
    },
    textBlock(parts[1]!),
    {
      type: 'diagram',
      title: 'A coast meets a long wave',
      nodes: [
        { id: 'pull', label: 'Moon + Sun' },
        { id: 'ocean', label: 'Ocean wave' },
        { id: 'coast', label: 'Coast' },
      ],
      edges: [
        { from: 'pull', to: 'ocean', label: 'pull' },
        { from: 'ocean', to: 'coast', label: 'arrives' },
      ],
    },
    {
      type: 'disclosure',
      label: 'Which part is high tide?',
      body: 'The crest reaching the coast is high tide; the trough brings low tide. This view simplifies a complex ocean into one wave so you can inspect the pattern.',
    },
    {
      type: 'code',
      title: 'How this illustrative curve is drawn',
      language: 'javascript',
      code: 'const phase = distance / width;\nconst height = Math.sin(phase * Math.PI * 2 * cycles);\ndrawPoint(distance, height);',
      caption:
        'This code sketches the browser visualization. It is not a physical tide model or forecast, and it is displayed as text rather than executed from the Scroll.',
    },
    textBlock(parts[2]!),
  ]);
}

function orbitBlocks(body: string): WebScrollBlockV1[] {
  const parts = paragraphs(body);
  if (parts.length !== 3 || !parts[1]?.includes('ellipses'))
    throw new Error('Orbit fixture source changed; review its blocks');
  return webScrollBlockV1.array().parse([
    textBlock(parts[0]!),
    {
      type: 'comparison',
      title: 'One orbit, two stretches',
      left: {
        label: 'Near the Sun',
        points: [
          'The planet is closer to the Sun.',
          'It moves faster along its path.',
        ],
      },
      right: {
        label: 'Farther away',
        points: [
          'The planet is farther from the Sun.',
          'It moves slower along its path.',
        ],
      },
    },
    textBlock(parts[1]!),
    {
      type: 'diagram',
      title: 'Follow the same planet around one Sun',
      nodes: [
        { id: 'near', label: 'Near' },
        { id: 'sun', label: 'Sun' },
        { id: 'far', label: 'Far' },
      ],
      edges: [
        { from: 'near', to: 'sun' },
        { from: 'sun', to: 'far' },
      ],
    },
    {
      type: 'disclosure',
      label: 'Why not a perfect circle?',
      body: 'Kepler described an orbit as an ellipse with the Sun at one focus. The line from the planet to the Sun sweeps equal areas in equal times, even though the planet’s speed changes.',
    },
    {
      type: 'code',
      title: 'A geometric sketch of an ellipse',
      language: 'javascript',
      code: 'const x = centerX + radiusX * Math.cos(angle);\nconst y = centerY + radiusY * Math.sin(angle);\nplot(x, y);',
      caption:
        'This draws the shape only. It does not calculate orbital speed, gravity, or a real planet’s position.',
    },
    textBlock(parts[2]!),
  ]);
}

const entries = [
  { title: 'A rhythm the ocean keeps', blocks: tideBlocks },
  { title: 'An orbit is not a perfect circle', blocks: orbitBlocks },
] as const;

try {
  for (const entry of entries) {
    const result = await pool.query<Row>(
      "SELECT id, revision, title, body FROM asset WHERE kind='Scroll' AND title=$1",
      [entry.title],
    );
    if (result.rowCount !== 1)
      throw new Error(`Expected one seeded Scroll: ${entry.title}`);
    const row = result.rows[0]!;
    const artifact = createAuthoredTestScrollWebArtifact({
      assetId: row.id,
      revision: row.revision,
      title: row.title,
      body: row.body,
      blocks: entry.blocks(row.body),
    });
    await pool.query(
      "UPDATE asset SET web_artifact=$2 WHERE id=$1 AND kind='Scroll' AND revision=$3",
      [row.id, artifact, row.revision],
    );
  }
  console.log(
    JSON.stringify({ fixture: 'authored-web-scrolls', count: entries.length }),
  );
} finally {
  await pool.end();
}
