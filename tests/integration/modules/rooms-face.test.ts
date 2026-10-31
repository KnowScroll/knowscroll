/**
 * Every room has a face, and painted backdrops within one dollar (v3 R-4, D-166, D-170, D-171) over real PostgreSQL, the
 * real reasoning harness with a CI fixture model, a CI fixture image provider and a real media store in a temporary
 * folder (never provider output). A model proposes a kit and code validates it; an operator reviews it before any member
 * sees it; a painted backdrop is paid for only while the recorded total plus its estimate stays within the cap, and only
 * an approved one is served.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RoomKitSchema, type RoomKit } from '@knowscroll/contracts';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { composeFaceOperator, readApprovedBackdrop } from '@knowscroll/backend/modules/rooms/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureModel } from '../support/fixture-model.js';
import type { FixtureModelPort, FixtureScenario } from '../support/fixture-model-port.js';
import { fixtureImagePort, type FixtureImagePort, type FixtureImageScenario } from '../support/fixture-image.js';
import {
  joined,
  memberView,
  PERSONAL_UNIVERSE_SCHEMAS,
  roomScope,
  roomWorld,
  rowsIn,
  say,
  seedRoom,
  unwrap,
  type RoomWorld,
} from '../support/rooms.js';
import { seedFriend } from '../support/talk.js';

const START = new Date('2026-10-31T09:00:00Z');
const PRICE = 3_500;
/** One dollar, in millionths. Written out here on purpose: the test must not agree with a changed constant by construction. */
const ONE_DOLLAR = 1_000_000;
const money = (images: number) => ({
  microUsdPerImage: PRICE,
  priceSource: 'https://example.test/ci-fixture-price',
  priceCheckedOn: '2026-10-31',
  capMicroUsd: images * PRICE,
});

const KIT = {
  palette: { ground: 'midnight', accent: 'sun', ink: 'cream' },
  emblem: { frame: 'hexagon', glyph: 'atom' },
  motif: 'circuit',
  motion: 'blink',
  cast: { explainer: 'atom', skeptic: 'gear' },
};
const kitAnswer = (patch: Record<string, unknown> = {}): FixtureScenario => ({
  kind: 'success',
  text: JSON.stringify({ ...KIT, ...patch }),
});
const LOW_CONTRAST = { palette: { ground: 'midnight', accent: 'sun', ink: 'forest' } };
const never = new AbortController().signal;

describe('every room has a face (real PostgreSQL, CI fixture model and image provider)', () => {
  let database: TestDatabase<Database>;
  let world: RoomWorld;
  let folder: string;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('rooms_face');
    world = await roomWorld(database, { now: START });
    folder = await mkdtemp(join(tmpdir(), 'ks-room-face-'));
  });
  afterAll(async () => {
    await world.close();
    await database.drop();
    await rm(folder, { recursive: true, force: true });
  });

  /** The operator's controls over fixtures: what the worker's `rooms` command composes with the real provider. */
  function operator(
    options: {
      readonly model?: FixtureModelPort;
      readonly image?: FixtureImagePort | undefined;
      readonly images?: number;
      readonly mediaRoot?: string | undefined;
    } = {},
  ) {
    const model = options.model ?? fixtureModel(() => kitAnswer(), { label: 'rooms-kit' });
    const { harness, withScope } = roomScope(world.db, model);
    const image = 'image' in options ? options.image : fixtureImagePort();
    const face = composeFaceOperator({
      db: world.db,
      harness,
      withRoomScope: withScope,
      image,
      mediaRoot: 'mediaRoot' in options ? options.mediaRoot : folder,
      model: model.model,
      generation: 1,
      ...(options.images === undefined ? {} : { money: money(options.images) }),
      now: () => world.clock.now,
    });
    return { face, model, image };
  }

  const room = async (topicId = 'machine-learning') => seedRoom(world, { topic: { kind: 'system', id: topicId } });

  /** The face a member of the room is shown. */
  async function shown(roomId: string) {
    const [member] = await joined(world, roomId, 1);
    return (await memberView(world, member!, roomId)).room.identity;
  }

  const identityRows = (roomId: string) =>
    world.db.selectFrom('rooms.room_identity').selectAll().where('room_id', '=', roomId).orderBy('revision').execute();
  const attemptsOf = (roomId: string) =>
    world.db.selectFrom('rooms.backdrop_attempts').selectAll().where('room_id', '=', roomId).execute();
  const backdropsOf = (roomId: string) =>
    world.db.selectFrom('rooms.room_backdrops').selectAll().where('room_id', '=', roomId).execute();

  describe('a room’s kit', () => {
    it('wears the default its ID gives it until an operator approves a kit, and the default always validates', async () => {
      const { roomId } = await room();
      const first = await shown(roomId);
      expect(RoomKitSchema.safeParse(first?.kit).success).toBe(true);
      expect(first?.backdrop).toBeUndefined();
      expect((await shown(roomId))?.kit).toEqual(first?.kit);
      const other = await room('earth-and-sky');
      expect((await shown(other.roomId))?.kit).not.toEqual(first?.kit);
    });

    it('proposes a kit from the topic alone: one call, stored as a proposal, shown to nobody', async () => {
      const { roomId, slug } = await room();
      const [member] = await joined(world, roomId, 1);
      const general = (await memberView(world, member!, roomId)).general.discussionId;
      unwrap(await say(world, member!, roomId, general, 'MEMBER-WORDS must never reach the kit model'));
      const before = await rowsIn(world.db, PERSONAL_UNIVERSE_SCHEMAS);
      const faceBefore = (await memberView(world, member!, roomId)).room.identity;
      const { face, model } = operator();
      const result = await face.kit.propose({ slug, dryRun: false, signal: never });
      expect(result).toMatchObject({ kind: 'proposed', slug, revision: 1 });
      expect(model.calls).toHaveLength(1);
      const sent = Buffer.from(model.calls[0]!.bytes).toString('utf8');
      expect(sent).toContain('Topic:');
      expect(sent).not.toContain('MEMBER-WORDS');
      expect(sent).not.toContain(member!.accountId);
      expect(await identityRows(roomId)).toMatchObject([
        { revision: 1, review_state: 'pending', kit_version: 'station-kit.v1' },
      ]);
      expect((await memberView(world, member!, roomId)).room.identity).toEqual(faceBefore);
      expect(await rowsIn(world.db, PERSONAL_UNIVERSE_SCHEMAS)).toBe(before);
    });

    it('shows what it would ask on a dry run, and calls nothing', async () => {
      const { roomId, slug } = await room();
      const { face, model } = operator();
      const result = await face.kit.propose({ slug, dryRun: true, signal: never });
      expect(result).toMatchObject({ kind: 'dry_run', role: 'rooms.station-kit', revision: 1 });
      expect(model.calls).toHaveLength(0);
      expect(await identityRows(roomId)).toEqual([]);
      expect(await face.kit.propose({ slug: 'no-such-room', dryRun: false, signal: never })).toEqual({
        kind: 'unknown_room',
      });
    });

    it('refuses a kit whose palette does not read: one repair, then nothing is stored and the room keeps its default', async () => {
      const { roomId, slug } = await room();
      const { face, model } = operator({ model: fixtureModel(() => kitAnswer(LOW_CONTRAST), { label: 'rooms-kit' }) });
      const result = await face.kit.propose({ slug, dryRun: false, signal: never });
      expect(result).toEqual({ kind: 'not_made', reason: 'invalid_output' });
      // The first answer and its one repair; no third.
      expect(model.calls).toHaveLength(2);
      expect(await identityRows(roomId)).toEqual([]);
      expect(RoomKitSchema.safeParse((await shown(roomId))?.kit).success).toBe(true);
    });

    it('accepts the repair when it fixes the palette', async () => {
      const { slug } = await room();
      const { face, model } = operator({
        model: fixtureModel((sequence) => (sequence === 1 ? kitAnswer(LOW_CONTRAST) : kitAnswer()), {
          label: 'rooms-kit',
        }),
      });
      expect(await face.kit.propose({ slug, dryRun: false, signal: never })).toMatchObject({ kind: 'proposed' });
      expect(model.calls).toHaveLength(2);
    });

    it('refuses an answer outside the vocabulary: a colour code, an unknown word, markup', async () => {
      const { roomId, slug } = await room();
      const { face } = operator({
        model: fixtureModel(
          () => kitAnswer({ palette: { ground: '#000000', accent: 'sun', ink: 'cream' }, motion: '<script>' }),
          {
            label: 'rooms-kit',
          },
        ),
      });
      expect(await face.kit.propose({ slug, dryRun: false, signal: never })).toMatchObject({ kind: 'not_made' });
      expect(await identityRows(roomId)).toEqual([]);
    });

    it('asks again after a failed proposal, on a new run, since a run that ended is never reopened', async () => {
      const { roomId, slug } = await room();
      const failing = operator({ model: fixtureModel(() => kitAnswer(LOW_CONTRAST), { label: 'rooms-kit' }) });
      expect(await failing.face.kit.propose({ slug, dryRun: false, signal: never })).toEqual({
        kind: 'not_made',
        reason: 'invalid_output',
      });
      const good = operator();
      expect(await good.face.kit.propose({ slug, dryRun: false, signal: never })).toMatchObject({
        kind: 'proposed',
        revision: 1,
      });
      expect(good.model.calls).toHaveLength(1);
      expect(await identityRows(roomId)).toMatchObject([{ revision: 1, review_state: 'pending' }]);
    });

    it('never sends a kit call whose outcome is unknown again, however often the operator asks', async () => {
      const { roomId, slug } = await room();
      const lost = operator({
        model: fixtureModel(() => ({ kind: 'timeout_after_dispatch' }), { label: 'rooms-kit' }),
      });
      expect(await lost.face.kit.propose({ slug, dryRun: false, signal: never })).toEqual({
        kind: 'not_made',
        reason: 'unknown',
      });
      const again = operator();
      expect(await again.face.kit.propose({ slug, dryRun: false, signal: never })).toEqual({
        kind: 'not_made',
        reason: 'unknown',
      });
      expect(again.model.calls).toHaveLength(0);
      expect(await identityRows(roomId)).toEqual([]);
    });

    it('waits for review: a second proposal is refused without a call while one is waiting', async () => {
      const { slug } = await room();
      const { face, model } = operator();
      expect(await face.kit.propose({ slug, dryRun: false, signal: never })).toMatchObject({ kind: 'proposed' });
      expect(await face.kit.propose({ slug, dryRun: false, signal: never })).toMatchObject({ kind: 'pending_exists' });
      expect(model.calls).toHaveLength(1);
    });

    it('shows a kit to members and previews only once an operator approves it, and a rejected one never', async () => {
      const { roomId, slug } = await room();
      const { face } = operator();
      await face.kit.propose({ slug, dryRun: false, signal: never });
      const unchanged = await shown(roomId);
      expect(await face.kit.review({ slug, revision: 1, decision: 'rejected', by: 'cli:ci' })).toEqual({
        kind: 'decided',
      });
      expect(await shown(roomId)).toEqual(unchanged);
      expect(await face.kit.review({ slug, revision: 1, decision: 'approved', by: 'cli:ci' })).toEqual({
        kind: 'not_pending',
      });

      await face.kit.propose({ slug, dryRun: false, signal: never });
      expect(await face.kit.review({ slug, revision: 2, decision: 'approved', by: 'cli:ci' })).toEqual({
        kind: 'decided',
      });
      const approved = (await shown(roomId))?.kit as RoomKit;
      expect(approved).toMatchObject({ ...KIT, version: 'station-kit.v1' });
      // A person who has not joined sees the same face in the room's preview.
      const stranger = await seedFriend(world.db, world.friends);
      const preview = unwrap(
        await world.rooms.read(stranger.authority, { version: 'rooms.v1', readId: randomUUID(), roomId }),
      );
      expect(preview).toMatchObject({ status: 'preview', room: { identity: { kit: { emblem: KIT.emblem } } } });
      expect(await face.kit.review({ slug, revision: 9, decision: 'approved', by: 'cli:ci' })).toEqual({
        kind: 'unknown',
      });
    });

    it('supersedes the kit shown so far when the next one is approved, keeping the record', async () => {
      const { roomId, slug } = await room();
      const first = operator();
      await first.face.kit.propose({ slug, dryRun: false, signal: never });
      await first.face.kit.review({ slug, revision: 1, decision: 'approved', by: 'cli:ci' });
      const second = operator({
        model: fixtureModel(() => kitAnswer({ motion: 'ripple', emblem: { frame: 'arch', glyph: 'book' } }), {
          label: 'rooms-kit',
        }),
      });
      await second.face.kit.propose({ slug, dryRun: false, signal: never });
      await second.face.kit.review({ slug, revision: 2, decision: 'approved', by: 'cli:ci' });
      expect((await identityRows(roomId)).map((row) => row.review_state)).toEqual(['superseded', 'approved']);
      expect((await shown(roomId))?.kit).toMatchObject({ motion: 'ripple', emblem: { frame: 'arch', glyph: 'book' } });
    });

    it('draws the default again when an approved kit no longer passes today’s rules, and refuses to approve one that does not', async () => {
      const { roomId, slug } = await room();
      const { face } = operator();
      await face.kit.propose({ slug, dryRun: false, signal: never });
      // A stored kit whose palette stopped reading (as if a swatch changed): not approvable.
      await sql`update rooms.room_identity set kit = jsonb_set(kit, '{palette,ink}', '"forest"') where room_id = ${roomId}::uuid`.execute(
        world.db,
      );
      expect(await face.kit.review({ slug, revision: 1, decision: 'approved', by: 'cli:ci' })).toEqual({
        kind: 'invalid',
      });
      expect((await face.kit.list(50)).filter((kit) => kit.slug === slug)).toMatchObject([
        { slug, revision: 1, valid: false },
      ]);
      // Approved earlier and broken later: the room shows its default instead of the broken kit.
      await sql`update rooms.room_identity set review_state = 'approved', reviewed_at = now(), reviewed_by = 'cli:ci' where room_id = ${roomId}::uuid`.execute(
        world.db,
      );
      const face2 = await shown(roomId);
      expect(RoomKitSchema.safeParse(face2?.kit).success).toBe(true);
      expect((face2?.kit as RoomKit).palette.ink).not.toBe('forest');
      await sql`update rooms.room_identity set kit = '{"motion":"<script>alert(1)</script>"}'::jsonb where room_id = ${roomId}::uuid`.execute(
        world.db,
      );
      expect(RoomKitSchema.safeParse((await shown(roomId))?.kit).success).toBe(true);
    });
  });

  describe('painted backdrops within one dollar', () => {
    // The money ledger is the world's, not a room's: each test starts from an empty one so the totals it reads are its own.
    beforeEach(async () => {
      await sql`delete from rooms.room_backdrops`.execute(world.db);
      await sql`delete from rooms.backdrop_attempts`.execute(world.db);
    });

    it('shows the prompt and the money on a dry run, and records and calls nothing', async () => {
      const { roomId, slug } = await room();
      const { face, image } = operator();
      const result = await face.backdrop.generate({ slug, dryRun: true, signal: never, by: 'cli:ci' });
      expect(result).toMatchObject({
        kind: 'dry_run',
        kitSource: 'default',
        figures: { recordedMicroUsd: 0, estimateMicroUsd: PRICE, capMicroUsd: ONE_DOLLAR },
        priceSource: 'https://platform.minimax.io/docs/guides/pricing-paygo',
      });
      expect((result as { prompt: string }).prompt).toContain('Machine learning');
      expect(image!.calls).toHaveLength(0);
      expect(await attemptsOf(roomId)).toEqual([]);
    });

    it('builds the prompt from the library topic and the room’s kit, never from a member’s words', async () => {
      const { roomId, slug } = await room();
      const [member] = await joined(world, roomId, 1);
      const general = (await memberView(world, member!, roomId)).general.discussionId;
      unwrap(await say(world, member!, roomId, general, 'MEMBER-WORDS paint something rude'));
      const { face, image } = operator();
      await face.backdrop.generate({ slug, dryRun: false, signal: never, by: 'cli:ci' });
      const prompt = image!.calls[0]!.prompt;
      expect(prompt).toContain('Screenprint');
      expect(prompt).toContain('No text');
      expect(prompt).not.toContain('MEMBER-WORDS');
      expect(prompt).not.toContain('Fixture room');
    });

    it('makes one picture: recorded before it is asked for, charged its estimate, stored pending and shown to nobody', async () => {
      const { roomId, slug } = await room();
      const before = await rowsIn(world.db, PERSONAL_UNIVERSE_SCHEMAS);
      const { face, image } = operator();
      const result = await face.backdrop.generate({ slug, dryRun: false, signal: never, by: 'cli:ci' });
      expect(result).toMatchObject({ kind: 'made', chargeMicroUsd: PRICE, mime: 'image/jpeg' });
      expect(image!.calls).toHaveLength(1);
      const [attempt] = await attemptsOf(roomId);
      expect(attempt).toMatchObject({
        state: 'succeeded',
        estimate_micro_usd: PRICE,
        charge_micro_usd: PRICE,
        requested_by: 'cli:ci',
        model: 'ci-fixture-image',
        price_source: 'https://platform.minimax.io/docs/guides/pricing-paygo',
      });
      expect(String(attempt?.price_checked_on)).toContain('2026');
      expect(attempt?.prompt_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(await backdropsOf(roomId)).toMatchObject([
        { review_state: 'pending', mime: 'image/jpeg', attempt_id: attempt?.attempt_id },
      ]);
      expect((await shown(roomId))?.backdrop).toBeUndefined();
      expect(await rowsIn(world.db, PERSONAL_UNIVERSE_SCHEMAS)).toBe(before);
      expect((await face.backdrop.spend()).recordedMicroUsd).toBe(PRICE);
    });

    it('serves a picture only after an operator approves it, and only the approved one', async () => {
      const { roomId, slug } = await room();
      const { face } = operator();
      await face.backdrop.generate({ slug, dryRun: false, signal: never, by: 'cli:ci' });
      const [pending] = await backdropsOf(roomId);
      const serve = (digest: string) => faceReader(world)(digest);
      expect(await serve(pending!.sha256)).toBeUndefined();

      expect(
        await face.backdrop.review({ backdropId: pending!.backdrop_id, decision: 'approved', by: 'cli:ci' }),
      ).toEqual({ kind: 'decided' });
      expect(await serve(pending!.sha256)).toEqual({
        key: pending!.media_key,
        mime: 'image/jpeg',
        size: pending!.size_bytes,
      });
      expect((await shown(roomId))?.backdrop).toEqual({ path: `/media/room/${pending!.sha256}` });
      expect(
        await face.backdrop.review({ backdropId: pending!.backdrop_id, decision: 'rejected', by: 'cli:ci' }),
      ).toEqual({ kind: 'not_pending' });
      expect(await face.backdrop.review({ backdropId: randomUUID(), decision: 'approved', by: 'cli:ci' })).toEqual({
        kind: 'unknown',
      });

      // A second picture is reviewed on its own; approving it replaces the first at its address.
      const again = await face.backdrop.generate({ slug, dryRun: false, signal: never, by: 'cli:ci' });
      expect(again).toMatchObject({ kind: 'made' });
      const second = (await backdropsOf(roomId)).find((row) => row.review_state === 'pending')!;
      await face.backdrop.review({ backdropId: second.backdrop_id, decision: 'approved', by: 'cli:ci' });
      expect(await serve(pending!.sha256)).toBeUndefined();
      expect(await serve(second.sha256)).toBeDefined();
      expect((await backdropsOf(roomId)).map((row) => row.review_state).sort()).toEqual(['approved', 'superseded']);
    });

    it('serves nothing of a rejected picture, and will not approve one whose file is gone', async () => {
      const { roomId, slug } = await room();
      const { face } = operator();
      await face.backdrop.generate({ slug, dryRun: false, signal: never, by: 'cli:ci' });
      const [pending] = await backdropsOf(roomId);
      expect(
        await face.backdrop.review({ backdropId: pending!.backdrop_id, decision: 'rejected', by: 'cli:ci' }),
      ).toEqual({ kind: 'decided' });
      expect(await faceReader(world)(pending!.sha256)).toBeUndefined();
      expect((await shown(roomId))?.backdrop).toBeUndefined();

      const gone = await room();
      await face.backdrop.generate({ slug: gone.slug, dryRun: false, signal: never, by: 'cli:ci' });
      const [lost] = await backdropsOf(gone.roomId);
      const elsewhere = operator({ mediaRoot: await mkdtemp(join(tmpdir(), 'ks-room-face-empty-')) });
      expect(
        await elsewhere.face.backdrop.review({ backdropId: lost!.backdrop_id, decision: 'approved', by: 'cli:ci' }),
      ).toEqual({ kind: 'missing_file' });
    });

    it('waits for review: no second picture is asked for while one is waiting', async () => {
      const { slug } = await room();
      const { face, image } = operator();
      await face.backdrop.generate({ slug, dryRun: false, signal: never, by: 'cli:ci' });
      expect(await face.backdrop.generate({ slug, dryRun: false, signal: never, by: 'cli:ci' })).toMatchObject({
        kind: 'refused',
        reason: 'review_pending',
      });
      expect(image!.calls).toHaveLength(1);
    });

    describe('the one-dollar cap', () => {
      it('refuses the attempt that would pass the cap, before it exists, and asks the provider for nothing', async () => {
        const { face, image } = operator({ images: 2 });
        const rooms = [await room(), await room(), await room()];
        const results = [];
        for (const { slug } of rooms)
          results.push(await face.backdrop.generate({ slug, dryRun: false, signal: never, by: 'cli:ci' }));
        expect(results.map((result) => result.kind)).toEqual(['made', 'made', 'refused']);
        expect(results[2]).toMatchObject({
          kind: 'refused',
          reason: 'cap',
          figures: { recordedMicroUsd: 2 * PRICE, estimateMicroUsd: PRICE, capMicroUsd: 2 * PRICE },
        });
        expect(image!.calls).toHaveLength(2);
        // The refusal left no row, no picture and no charge.
        expect(await attemptsOf(rooms[2]!.roomId)).toEqual([]);
        expect(await backdropsOf(rooms[2]!.roomId)).toEqual([]);
        expect(await face.backdrop.spend()).toMatchObject({ remainingMicroUsd: 0, imagesLeft: 0 });
        // A dry run says it would be refused.
        expect(
          await face.backdrop.generate({ slug: rooms[2]!.slug, dryRun: true, signal: never, by: 'cli:ci' }),
        ).toMatchObject({ kind: 'dry_run', wouldRefuse: 'cap' });
      });

      it('stops at one dollar in all, with the real constants: the last image that fits is made and the next is refused', async () => {
        const first = await room();
        const first2 = await room();
        const { face, image } = operator();
        const already = (await face.backdrop.spend()).recordedMicroUsd;
        // Bring the recorded total to exactly one image short of the dollar.
        const room0 = (await world.db.selectFrom('rooms.rooms').select('room_id').limit(1).executeTakeFirstOrThrow())
          .room_id;
        const fill = ONE_DOLLAR - PRICE - already;
        for (const estimate of [Math.floor(fill / 2), fill - Math.floor(fill / 2)])
          await insertAttempt(world, room0, { state: 'succeeded', estimate, charge: estimate });
        expect(
          await face.backdrop.generate({ slug: first.slug, dryRun: false, signal: never, by: 'cli:ci' }),
        ).toMatchObject({ kind: 'made' });
        expect((await face.backdrop.spend()).recordedMicroUsd).toBe(ONE_DOLLAR);
        expect(
          await face.backdrop.generate({ slug: first2.slug, dryRun: false, signal: never, by: 'cli:ci' }),
        ).toMatchObject({ kind: 'refused', reason: 'cap' });
        expect(image!.calls).toHaveLength(1);
      });

      it('holds when two operators ask at once: only the images that fit are asked for', async () => {
        const rooms = [await room(), await room(), await room(), await room()];
        let release!: (scenario: FixtureImageScenario) => void;
        const gate = new Promise<FixtureImageScenario>((resolve) => {
          release = resolve;
        });
        // Both operators share one provider fixture, so the count is the world's.
        const image = fixtureImagePort(() => ({ kind: 'hold', until: gate }));
        const one = operator({ image, images: 2 });
        const other = operator({ image, images: 2 });
        const before = (await one.face.backdrop.spend()).recordedMicroUsd;
        const asking = rooms.map(({ slug }, index) =>
          (index % 2 === 0 ? one : other).face.backdrop.generate({
            slug,
            dryRun: false,
            signal: never,
            by: `cli:ci${String(index)}`,
          }),
        );
        // Two reached the provider; the other two were refused and returned already.
        await waitFor(() => image.calls.length === 2);
        release({ kind: 'image' });
        const results = await Promise.all(asking);
        expect(results.map((result) => result.kind).sort()).toEqual(['made', 'made', 'refused', 'refused']);
        expect(results.filter((result) => result.kind === 'refused')).toEqual([
          expect.objectContaining({ reason: 'cap' }),
          expect.objectContaining({ reason: 'cap' }),
        ]);
        expect(image.calls).toHaveLength(2);
        const spent = (await one.face.backdrop.spend()).recordedMicroUsd - before;
        expect(spent).toBe(2 * PRICE);
      });

      it('refuses with nothing recorded where no provider or no media root is configured', async () => {
        const { roomId, slug } = await room();
        for (const configured of [operator({ image: undefined }), operator({ mediaRoot: undefined })])
          expect(await configured.face.backdrop.generate({ slug, dryRun: false, signal: never, by: 'cli:ci' })).toEqual(
            {
              kind: 'refused',
              reason: 'not_configured',
            },
          );
        expect(await attemptsOf(roomId)).toEqual([]);
        expect(
          await operator().face.backdrop.generate({ slug: 'no-such-room', dryRun: false, signal: never, by: 'cli:ci' }),
        ).toEqual({ kind: 'unknown_room' });
      });
    });

    describe('what each outcome costs, and how an unknown one is settled', () => {
      it('charges nothing for a provider refusal or a call that never left, and keeps the charge for an unusable picture', async () => {
        const settled = async (scenario: FixtureImageScenario) => {
          const { roomId, slug } = await room();
          const { face } = operator({ image: fixtureImagePort(() => scenario) });
          const result = await face.backdrop.generate({ slug, dryRun: false, signal: never, by: 'cli:ci' });
          const [attempt] = await attemptsOf(roomId);
          return {
            result,
            state: attempt?.state,
            charge: attempt?.charge_micro_usd,
            pictures: (await backdropsOf(roomId)).length,
          };
        };
        expect(await settled({ kind: 'rejected', code: 'PROVIDER_1026' })).toMatchObject({
          result: { kind: 'not_made', state: 'failed', code: 'PROVIDER_1026', chargeMicroUsd: 0 },
          state: 'failed',
          charge: 0,
          pictures: 0,
        });
        expect(await settled({ kind: 'not_sent', code: 'NOT_CONNECTED_ECONNREFUSED' })).toMatchObject({
          state: 'not_sent',
          charge: 0,
          pictures: 0,
        });
        expect(await settled({ kind: 'unusable' })).toMatchObject({ state: 'succeeded', charge: PRICE, pictures: 0 });
        expect(await settled({ kind: 'unknown', code: 'TIMEOUT_AFTER_DISPATCH' })).toMatchObject({
          state: 'unknown',
          charge: PRICE,
          pictures: 0,
        });
      });

      it('never sends an unknown outcome again, counts it against the cap, and lets only an operator who read the provider’s record settle it', async () => {
        const { roomId, slug } = await room();
        const other = await room();
        const { face, image } = operator({
          image: fixtureImagePort((n) =>
            n === 1 ? { kind: 'unknown', code: 'TIMEOUT_AFTER_DISPATCH' } : { kind: 'image' },
          ),
          images: 2,
        });
        expect(await face.backdrop.generate({ slug, dryRun: false, signal: never, by: 'cli:ci' })).toMatchObject({
          kind: 'not_made',
          state: 'unknown',
          chargeMicroUsd: PRICE,
        });
        // The room is blocked: no second request for it, however often it is asked.
        for (let tries = 0; tries < 3; tries++)
          expect(await face.backdrop.generate({ slug, dryRun: false, signal: never, by: 'cli:ci' })).toMatchObject({
            kind: 'refused',
            reason: 'unresolved_attempt',
          });
        expect(image!.calls).toHaveLength(1);
        // The unknown charge counts: with a cap of two images, only one more fits.
        expect(
          await face.backdrop.generate({ slug: other.slug, dryRun: false, signal: never, by: 'cli:ci' }),
        ).toMatchObject({ kind: 'made' });
        const third = await room();
        expect(
          await face.backdrop.generate({ slug: third.slug, dryRun: false, signal: never, by: 'cli:ci' }),
        ).toMatchObject({ kind: 'refused', reason: 'cap' });
        const [unknown] = await attemptsOf(roomId);
        expect(await face.backdrop.spend()).toMatchObject({
          unresolved: [expect.objectContaining({ attemptId: unknown!.attempt_id, state: 'unknown' })],
        });

        // The operator read the provider's own record and found nothing charged: only then does it count for nothing.
        expect(
          await face.backdrop.reconcile({
            attemptId: unknown!.attempt_id,
            charged: false,
            reason: 'console shows no image',
            by: 'cli:ci',
          }),
        ).toEqual({ kind: 'resolved' });
        expect((await attemptsOf(roomId))[0]).toMatchObject({
          state: 'reconciled',
          charge_micro_usd: 0,
          settled_by: 'cli:ci',
          note: 'console shows no image',
        });
        expect(
          await face.backdrop.reconcile({
            attemptId: unknown!.attempt_id,
            charged: true,
            reason: 'again',
            by: 'cli:ci',
          }),
        ).toEqual({ kind: 'not_unknown' });
        expect(await face.backdrop.generate({ slug, dryRun: false, signal: never, by: 'cli:ci' })).toMatchObject({
          kind: 'made',
        });
      });

      it('keeps the charge of an unknown attempt that is written off, and refuses to settle one that is not unknown', async () => {
        const { roomId, slug } = await room();
        const { face } = operator({ image: fixtureImagePort(() => ({ kind: 'unknown', code: 'HTTP_504' })) });
        await face.backdrop.generate({ slug, dryRun: false, signal: never, by: 'cli:ci' });
        const [unknown] = await attemptsOf(roomId);
        expect(
          await face.backdrop.writeOff({ attemptId: unknown!.attempt_id, reason: 'gave up', by: 'cli:ci' }),
        ).toEqual({ kind: 'resolved' });
        expect((await attemptsOf(roomId))[0]).toMatchObject({ state: 'written_off', charge_micro_usd: PRICE });
        expect(await face.backdrop.writeOff({ attemptId: unknown!.attempt_id, reason: 'again', by: 'cli:ci' })).toEqual(
          { kind: 'not_unknown' },
        );
        expect(await face.backdrop.writeOff({ attemptId: randomUUID(), reason: 'who', by: 'cli:ci' })).toEqual({
          kind: 'unknown_attempt',
        });
        // The room is free again, and the written-off attempt still counts.
        expect(
          (await face.backdrop.spend()).unresolved.find((attempt) => attempt.attemptId === unknown!.attempt_id),
        ).toBeUndefined();
      });

      it('takes an attempt a crash left dispatched for unknown, once the request deadline is long past, and never sends it again', async () => {
        const { roomId, slug } = await room();
        const stale = new Date(world.clock.now.getTime() - 60 * 60_000);
        await insertAttempt(world, roomId, {
          state: 'dispatched',
          estimate: PRICE,
          charge: PRICE,
          dispatchedAt: stale,
        });
        const recent = await room();
        await insertAttempt(world, recent.roomId, {
          state: 'dispatched',
          estimate: PRICE,
          charge: PRICE,
          dispatchedAt: new Date(world.clock.now.getTime() - 1_000),
        });
        const { face, image } = operator();
        expect(await face.backdrop.generate({ slug, dryRun: false, signal: never, by: 'cli:ci' })).toMatchObject({
          kind: 'refused',
          reason: 'unresolved_attempt',
        });
        expect(image!.calls).toHaveLength(0);
        expect((await attemptsOf(roomId))[0]).toMatchObject({
          state: 'unknown',
          outcome_code: 'NO_OUTCOME_RECORDED',
          charge_micro_usd: PRICE,
        });
        // One that is still within its deadline is still being waited for.
        expect((await attemptsOf(recent.roomId))[0]).toMatchObject({ state: 'dispatched' });
      });
    });

    it('counts faces for the Operator without showing a prompt or a picture', async () => {
      const view = await sql<Record<string, unknown>>`select * from ops.room_faces`.execute(world.db);
      expect(Object.keys(view.rows[0]!).sort()).toEqual([
        'backdrop_attempts',
        'backdrop_spent_micro_usd',
        'backdrop_unresolved',
        'backdrops_approved',
        'backdrops_pending',
        'kits_approved',
        'kits_pending',
      ]);
      expect(Number(view.rows[0]!['backdrop_spent_micro_usd'])).toBe(
        (await operator().face.backdrop.spend()).recordedMicroUsd,
      );
    });
  });
});

/** The read the API’s media route makes, over the same database. */
const faceReader = (world: RoomWorld) => readApprovedBackdrop(world.db);

async function insertAttempt(
  world: RoomWorld,
  roomId: string,
  row: { state: 'dispatched' | 'succeeded'; estimate: number; charge: number; dispatchedAt?: Date },
): Promise<void> {
  const at = row.dispatchedAt ?? new Date(world.clock.now.getTime() - 5 * 60 * 60_000);
  await world.db
    .insertInto('rooms.backdrop_attempts')
    .values({
      attempt_id: randomUUID(),
      room_id: roomId,
      state: row.state,
      model: 'ci-fixture-image',
      prompt_sha256: 'a'.repeat(64),
      estimate_micro_usd: row.estimate,
      charge_micro_usd: row.charge,
      price_source: 'https://example.test/ci-fixture-price',
      price_checked_on: '2026-10-31',
      requested_by: 'cli:ci',
      dispatched_at: at,
      settled_at: row.state === 'dispatched' ? null : at,
    })
    .execute();
}

async function waitFor(condition: () => boolean, limitMs = 10_000): Promise<void> {
  const until = Date.now() + limitMs;
  while (!condition()) {
    if (Date.now() > until) throw new Error('waitFor: the condition did not hold in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
