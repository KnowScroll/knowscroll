import type { ScrollDraft } from '@knowscroll/scroll-model/producer';

/**
 * Authored, fictional syntax example, never product content. Its claim ID deliberately lies
 * outside claimsRole's `claim-` namespace, so real offered evidence cannot authorize a copy.
 * JSON.stringify produces the one complete JSON exemplar embedded in the writer instructions.
 */
export function writerDraftExampleJson(interactive: boolean): string {
  const example: ScrollDraft = {
    draftVersion: 'scroll-draft.v1',
    title: 'A fictional signal switch',
    dek: 'An invented device illustrates how original text, a format block and evidence bindings fit together.',
    sections: [
      {
        id: 'example-opening',
        heading: null,
        blocks: [
          {
            id: 'example-paragraph',
            type: 'paragraph',
            data: {
              spans: [
                {
                  text: 'Imagine a device with a switch between an input and an output. In this invented model, closing the switch connects the route. Opening it removes the connection. Comparing these authored states makes the connection and interruption visible.',
                },
              ],
            },
          },
          {
            id: 'example-diagram',
            type: 'diagram',
            a11y: { label: 'An invented signal route, connected or interrupted' },
            fallbackText:
              'In the fictional device, the closed state joins input to output. In the open state the connecting arrow is hidden. These are authored diagram states, not a physical simulation.',
            data: {
              title: 'Compare the invented states',
              instruction: 'Choose a state to inspect its route.',
              layout: 'flow-lr',
              nodes: [
                { id: 'example-input', label: 'Input', kind: 'entity' },
                { id: 'example-output', label: 'Output', kind: 'entity' },
              ],
              edges: [
                { id: 'example-route', from: 'example-input', to: 'example-output', directed: true, style: 'solid' },
              ],
              groups: [],
              frames: [
                {
                  id: 'example-closed',
                  label: 'Closed',
                  description: 'The connection is present in this invented state.',
                  emphasis: ['example-route'],
                  hidden: [],
                  weights: [],
                },
                {
                  id: 'example-open',
                  label: 'Open',
                  description: 'The connection is absent in this invented state.',
                  emphasis: [],
                  hidden: ['example-route'],
                  weights: [],
                },
              ],
              interaction: { kind: 'toggle' },
            },
          },
          {
            id: 'example-limit',
            type: 'callout',
            data: {
              kind: 'limit',
              title: 'Limits of this invented picture',
              spans: [
                {
                  text: 'This authored device explains a contrast through selected states. It does not measure a real signal or simulate a physical circuit.',
                },
              ],
            },
          },
        ],
      },
    ],
    bindings: [
      { kind: 'block', claimId: 'example-only-claim', blockId: 'example-paragraph' },
      { kind: 'block', claimId: 'example-only-claim', blockId: 'example-diagram' },
      { kind: 'block', claimId: 'example-only-claim', blockId: 'example-limit' },
    ],
  };
  if (!interactive) {
    const section = example.sections[0];
    if (section === undefined) throw new Error('EXAMPLE_SECTION_MISSING');
    section.blocks[1] = {
      id: 'example-comparison',
      type: 'comparison',
      a11y: { label: 'Compare the connected and interrupted fictional routes' },
      fallbackText:
        'The invented closed state connects input to output. The invented open state interrupts the route. This comparison describes an authored device, not a measured physical system.',
      data: {
        title: 'Compare the invented routes',
        columns: [
          {
            label: 'Closed',
            points: [
              [{ text: 'The switch joins the input to the output in this invented state.' }],
              [{ text: 'The connection is present, so the drawn route can be followed.' }],
            ],
          },
          {
            label: 'Open',
            points: [
              [{ text: 'The switch interrupts the route in this invented state.' }],
              [{ text: 'The input and output remain separate in the authored picture.' }],
            ],
          },
        ],
      },
    };
    example.bindings[1] = { kind: 'block', claimId: 'example-only-claim', blockId: 'example-comparison' };
  }
  return JSON.stringify(example);
}
