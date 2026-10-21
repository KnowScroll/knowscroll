import { describe, expect, it } from 'vitest';
import { FIELD_LIMITS, LIMITS } from '@knowscroll/scroll-model';
import { DraftBlock, DraftSection, ScrollDraft } from '@knowscroll/scroll-model/producer';
import { onlyCanonicalOption, writerDraftProfile } from './writer-profile.js';
import { writerDraftExampleJson } from './writer-example.js';

/** Authored syntax and canonical-node inspection only; automated by Actions, never provider content. */
describe('canonical production writer profiles (CI fixtures)', () => {
  it('fails closed if a canonical selection is absent or ambiguous', () => {
    const paragraph = DraftBlock.options[0];
    const select = (option: typeof paragraph): option is typeof paragraph => option.shape.type.value === 'paragraph';
    expect(onlyCanonicalOption([paragraph], select)).toBe(paragraph);
    expect(() => onlyCanonicalOption([], select)).toThrow('WRITER_CANONICAL_SELECTION_INVALID');
    expect(() => onlyCanonicalOption([paragraph, paragraph], select)).toThrow('WRITER_CANONICAL_SELECTION_INVALID');
  });

  it.each([false, true])(
    'reuses canonical fields/refinements and keeps exactly the selected variants, interactive=%s',
    (interactive) => {
      const profile = writerDraftProfile(interactive);
      expect(DraftBlock.options).toHaveLength(16);
      expect(profile.shape.title).toBe(ScrollDraft.shape.title);
      expect(profile.shape.dek).toBe(ScrollDraft.shape.dek);
      expect(profile.shape.draftVersion).toBe(ScrollDraft.shape.draftVersion);
      const section = profile.shape.sections.element;
      expect(section.shape.heading).toBe(DraftSection.shape.heading);
      expect(section.shape.id).toBe(DraftSection.shape.id);
      const blocks = section.shape.blocks.element.options;
      expect(blocks.map((option) => option.shape.type.value).sort()).toEqual(
        ['paragraph', interactive ? 'diagram' : 'comparison', 'callout'].sort(),
      );
      for (const type of ['paragraph', 'callout']) {
        const original = DraftBlock.options.find((option) => option.shape.type.value === type);
        expect(blocks.find((option) => option.shape.type.value === type)).toBe(original);
      }
      expect(profile.shape.bindings.element.options.map((option) => option.shape.kind.value)).toEqual([
        'passage',
        'header',
        'heading',
        'block',
      ]);
      const example = JSON.parse(writerDraftExampleJson(interactive)) as unknown;
      expect(profile.safeParse(example).success).toBe(true);
      expect(ScrollDraft.safeParse(example).success).toBe(true);
    },
  );

  it.each([false, true])(
    'keeps strict native arrays, combined RichText and canonical root/section bounds, interactive=%s',
    (interactive) => {
      const profile = writerDraftProfile(interactive);
      const example = ScrollDraft.parse(JSON.parse(writerDraftExampleJson(interactive)));
      for (const field of ['sections', 'bindings'] as const)
        for (const value of [null, {}, 'serialized array', 1, false]) {
          const result = profile.safeParse({ ...example, [field]: value });
          expect(result.success).toBe(false);
          if (!result.success)
            expect(result.error.issues).toContainEqual(
              expect.objectContaining({ code: 'invalid_type', path: [field] }),
            );
        }
      expect(profile.safeParse({ ...example, extra: true }).success).toBe(false);
      expect(profile.safeParse({ ...example, sections: [] }).success).toBe(false);
      expect(
        profile.safeParse({ ...example, sections: Array(LIMITS.sections + 1).fill(example.sections[0]) }).success,
      ).toBe(false);
      const section = example.sections[0];
      if (!section) throw new Error('CI_SECTION_MISSING');
      expect(profile.safeParse({ ...example, sections: [{ ...section, blocks: [] }] }).success).toBe(false);
      expect(
        profile.safeParse({
          ...example,
          sections: [{ ...section, blocks: Array(LIMITS.blocks + 1).fill(section.blocks[0]) }],
        }).success,
      ).toBe(false);
      expect(
        profile.safeParse({ ...example, bindings: Array(LIMITS.blocks * 6 + 1).fill(example.bindings[0]) }).success,
      ).toBe(false);
      const paragraph = section.blocks[0];
      if (paragraph?.type !== 'paragraph') throw new Error('CI_PARAGRAPH_MISSING');
      for (const [spans, code] of [
        [[{ text: ' leading' }], 'rich_text_not_trimmed'],
        [[{ text: 'a'.repeat(700) }, { text: 'b'.repeat(501) }], 'rich_text_too_long'],
      ] as const) {
        paragraph.data.spans = spans.map((span) => ({ ...span }));
        const result = profile.safeParse(example);
        expect(result.success).toBe(false);
        if (!result.success)
          expect(result.error.issues).toContainEqual(
            expect.objectContaining({ code: 'custom', params: { safeCode: code } }),
          );
      }
    },
  );

  it.each([false, true])(
    'requires canonical non-text accessibility and refuses the other mode, interactive=%s',
    (interactive) => {
      const example = ScrollDraft.parse(JSON.parse(writerDraftExampleJson(interactive)));
      const section = example.sections[0];
      const format = section?.blocks[1];
      if (!section || !format || !('a11y' in format)) throw new Error('CI_FORMAT_MISSING');
      const profile = writerDraftProfile(interactive);
      for (const field of ['a11y', 'fallbackText'] as const) {
        const changed = { ...format, [field]: undefined };
        expect(ScrollDraft.safeParse({ ...example, sections: [{ ...section, blocks: [changed] }] }).success).toBe(true);
        expect(profile.safeParse({ ...example, sections: [{ ...section, blocks: [changed] }] }).success).toBe(false);
      }
      expect(profile.safeParse(JSON.parse(writerDraftExampleJson(!interactive))).success).toBe(false);
      if (format.type === 'diagram') {
        for (const kind of ['static', 'steps', 'drag-to-target'])
          expect(
            profile.safeParse({
              ...example,
              sections: [{ ...section, blocks: [{ ...format, data: { ...format.data, interaction: { kind } } }] }],
            }).success,
          ).toBe(false);
        for (const count of [1, 5])
          expect(
            profile.safeParse({
              ...example,
              sections: [
                {
                  ...section,
                  blocks: [{ ...format, data: { ...format.data, frames: Array(count).fill(format.data.frames[0]) } }],
                },
              ],
            }).success,
          ).toBe(false);
      }
      if (format.type === 'comparison') {
        for (const count of [1, FIELD_LIMITS.comparisonColumns])
          expect(
            profile.safeParse({
              ...example,
              sections: [
                {
                  ...section,
                  blocks: [{ ...format, data: { ...format.data, columns: Array(count).fill(format.data.columns[0]) } }],
                },
              ],
            }).success,
          ).toBe(false);
        const column = format.data.columns[0];
        if (!column) throw new Error('CI_COLUMN_MISSING');
        expect(
          profile.safeParse({
            ...example,
            sections: [
              {
                ...section,
                blocks: [
                  { ...format, data: { ...format.data, columns: [{ ...column, points: [column.points[0]] }, column] } },
                ],
              },
            ],
          }).success,
        ).toBe(false);
      }
    },
  );
});
