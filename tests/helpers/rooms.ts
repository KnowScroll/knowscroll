/**
 * #163 — a question the reader carries over two days, through the real API (ADR-0045). Two days are
 * compressed as in `tests/atlas-places.test.ts`' anchorGravity: day one's rows are moved back a day
 * in this disposable database. Day one keeps "One force, many jobs" and asks about it; day two keeps
 * two more Scrolls, which anchors Gravity as a planet; a second Ask then opens its room.
 */
import { readFileSync } from 'node:fs';
import type { buildApp } from '../../apps/api/src/app.ts';
import { transaction } from '../../packages/db/src/index.ts';
import { backdateOneDay } from '../../scripts/lib/backdate.ts';
import { askAbout, readScroll } from './reading.ts';

type App = ReturnType<typeof buildApp>;
type Headers = Record<string, string>;

const scrolls = JSON.parse(readFileSync('content/editorial-scrolls.json', 'utf8')) as { assetId: string; title: string }[] | Record<string, unknown>;
const library = (Array.isArray(scrolls) ? scrolls : Object.values(scrolls).find(Array.isArray)) as { assetId: string; title: string }[];
const idOf = (title: string) => library.find(s => s.title.startsWith(title))!.assetId;

/** Yesterday, for a universe whose history includes an Ask (`scripts/lib/backdate.ts`). */
export const yesterday = (universeId: string) => transaction(client => backdateOneDay(client, universeId));

export const GRAVITY_QUESTIONS = { dayOne: 'Why does everything fall toward the ground?', dayTwo: 'So what is gravity, really?' } as const;

/** Keeps "One force, many jobs", asks about it, and moves the day back. Returns the Ask. */
export async function askOnDayOne(app: App, headers: Headers, universeId: string): Promise<string> {
  const askId = await askAbout(app, headers, await readScroll(app, headers, idOf('One force, many jobs'), true), GRAVITY_QUESTIONS.dayOne);
  await yesterday(universeId);
  return askId;
}

/** Keeps "The pull you can't see" and a Scroll from a second source family: Gravity is anchored.
 * Returns the first exposure, for the day's own question. */
export async function anchorGravityOnDayTwo(app: App, headers: Headers): Promise<string> {
  const pull = await readScroll(app, headers, idOf("The pull you can't see"), true);
  await readScroll(app, headers, idOf('A rhythm the ocean keeps'), true);
  return pull;
}

/** Both days, and the second question that opens the room. */
export async function carryGravityQuestion(app: App, headers: Headers, universeId: string): Promise<{ dayOne: string; dayTwo: string }> {
  const dayOne = await askOnDayOne(app, headers, universeId);
  return { dayOne, dayTwo: await askAbout(app, headers, await anchorGravityOnDayTwo(app, headers), GRAVITY_QUESTIONS.dayTwo) };
}
