import { describe, expect, it } from 'vitest';
import { issueFromSchema, type Issue } from '../../issues.js';
import { validReply } from '../../test-support/written-v3-fixtures.js';
import { FIELD_LIMITS_V3 as F } from '../../v3/limits.js';
import { REPAIR_HINTS_V3 } from './reasons.js';
import { WrittenPictureV3, WrittenScrollV3 } from './written-schema.js';

function findings(value: unknown): Issue[] {
  const parsed = WrittenScrollV3.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map(issueFromSchema);
}

function mutated(change: (reply: ReturnType<typeof validReply>) => void): unknown {
  const reply = validReply();
  change(reply);
  return reply;
}

/** Every finding of these tests has a hint: the schema group of the catalogue. */
const seen = new Set<string>();
const refusedAt = (value: unknown): Issue[] => {
  const result = findings(value);
  for (const issue of result) seen.add(issue.code);
  return result;
};

describe('WrittenScrollV3', () => {
  it('parses the fixture reply and trims the strings a model pads', () => {
    expect(findings(validReply())).toEqual([]);
    const parsed = WrittenScrollV3.parse(mutated((reply) => (reply.title = '  How a kettle boils water \n')));
    expect(parsed.title).toBe('How a kettle boils water');
  });

  it('refuses an oversize field at the model’s own path', () => {
    const issues = refusedAt(
      mutated((reply) => {
        const item = reply.items[1];
        if (item?.type === 'para') item.text = 'w'.repeat(F.beatChars + 1);
        const picture = reply.pictures[0];
        if (picture?.kind === 'flow' && picture.steps[0] !== undefined)
          picture.steps[0].label = 'l'.repeat(F.itemLabelChars + 1);
      }),
    );
    expect(issues).toContainEqual({ code: 'schema_too_big', path: 'items.1.text' });
    expect(issues).toContainEqual({ code: 'schema_too_big', path: 'pictures.0.steps.0.label' });
  });

  it('refuses a link phrase that is empty or only space, at the link, so the compile never searches for nothing', () => {
    for (const phrase of ['', '   ']) {
      const issues = refusedAt(
        mutated((reply) => {
          const item = reply.items[6];
          if (item?.type === 'para') item.links = [{ phrase, part: 'Bubbles' }];
        }),
      );
      expect(issues).toContainEqual({ code: 'schema_too_small', path: 'items.6.links.0.phrase' });
    }
  });

  it('refuses a key the shape does not have, a bad handle and a bad chart value', () => {
    const issues = refusedAt(
      mutated((reply) => {
        const item = reply.items[1];
        if (item?.type === 'para') (item as Record<string, unknown>)['id'] = 'b1';
        const second = reply.items[2];
        if (second?.type === 'para') second.cites = ['E1', 'e100'];
        reply.pictures[1] = {
          kind: 'chart',
          title: 'People',
          cites: ['e2'],
          form: 'bars',
          values: 'shown',
          points: [
            { label: 'Town', value: '8.3m' },
            { label: 'City', value: '9' },
          ],
          marks: [],
        };
      }),
    );
    expect(issues).toContainEqual({ code: 'schema_unrecognized_keys', path: 'items.1' });
    expect(issues).toContainEqual({ code: 'id_format', path: 'items.2.cites.0' });
    expect(issues).toContainEqual({ code: 'id_format', path: 'items.2.cites.1' });
    expect(issues).toContainEqual({ code: 'schema_invalid_format', path: 'pictures.1.points.0.value' });
  });

  it('refuses an item of no known type, a text that is not plain and a web address', () => {
    const issues = refusedAt(
      mutated((reply) => {
        reply.items.push({ type: 'heading' } as never);
        reply.title = 'A title\nwith a line break';
        reply.dek = 'Read more at example.com for the whole dek of this Scroll.';
      }),
    );
    expect(issues).toContainEqual({ code: 'schema_invalid_union', path: `items.${validReply().items.length}.type` });
    expect(issues).toContainEqual({ code: 'text_not_plain', path: 'title' });
    expect(issues).toContainEqual({ code: 'text_mentions_web_address', path: 'dek' });
  });

  it('refuses a wrong type, a value that is not an allowed word and a list that is too short', () => {
    const issues = refusedAt(
      mutated((reply) => {
        const item = reply.items[1];
        if (item?.type === 'para') (item as Record<string, unknown>)['emphasis'] = 'loud';
        (reply as Record<string, unknown>)['askSuggestions'] = [];
        reply.title = 7 as never;
      }),
    );
    expect(issues).toContainEqual({ code: 'schema_invalid_value', path: 'items.1.emphasis' });
    expect(issues).toContainEqual({ code: 'schema_too_small', path: 'askSuggestions' });
    expect(issues).toContainEqual({ code: 'schema_invalid_type', path: 'title' });
  });

  it('has no id on any picture kind', () => {
    const picture = WrittenPictureV3.safeParse({
      kind: 'flow',
      id: 'p1',
      title: 'A',
      cites: ['e1'],
      steps: [{ label: 'a' }, { label: 'b' }],
    });
    expect(picture.success).toBe(false);
  });

  it('has a repair hint for each schema finding above', () => {
    expect(seen.size).toBeGreaterThanOrEqual(6);
    for (const code of seen) expect(REPAIR_HINTS_V3[code], code).toBeDefined();
  });
});
