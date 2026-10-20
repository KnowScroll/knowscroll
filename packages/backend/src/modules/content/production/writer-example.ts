import type { ScrollDraft } from '@knowscroll/scroll-model/producer';

/**
 * Authored, fictional syntax example, never product content. Its claim ID deliberately lies
 * outside claimsRole's `claim-` namespace, so real offered evidence cannot authorize a copy.
 * JSON.stringify produces the one complete JSON exemplar embedded in the writer instructions.
 */
export function writerDraftExampleJson(): string {
  const example: ScrollDraft = {
    draftVersion: 'scroll-draft.v1',
    title: 'A fictional signal switch',
    dek: 'An invented device illustrates how paragraph text, diagram frames and evidence bindings fit together.',
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
                  text: 'Imagine a device with a switch between an input and an output. In this invented model, closing the switch connects the route. Opening it removes the connection. The buttons change the drawing so the contrast can be inspected directly.',
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
        ],
      },
    ],
    bindings: [
      { kind: 'block', claimId: 'example-only-claim', blockId: 'example-paragraph' },
      { kind: 'block', claimId: 'example-only-claim', blockId: 'example-diagram' },
    ],
  };
  return JSON.stringify(example);
}
