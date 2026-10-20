import {
  BLOCK_TYPES,
  BLOCK_VERSIONS,
  SCROLL_DOCUMENT_SCHEMA_VERSION,
  negotiate,
  type Block,
  type BlockOfType,
  type ScrollDocument,
} from '../model';
import {
  altitudeSimulation,
  audioBlock,
  barChart,
  comparisonBlock,
  cycleDiagram,
  figureBlock,
  floorSimulation,
  gridDiagram,
  heatmapChart,
  horizontalBarChart,
  interestSimulation,
  layersDiagram,
  lineChart,
  loadPathDiagram,
  pendulumSimulation,
  scatterChart,
  sequenceBlock,
  tableBlock,
  timelineBlock,
  weightDiagram,
} from './blocks';
import { callout, code, em, list, paragraph, quote, scrollFixture, section, spans, strong, subheading } from './build';

/**
 * Original fixture documents (labelled: they are test and gallery data, not product content).
 * Their numbers and statements illustrate rendering; they make no factual claim.
 */

const LOAD_CHECK = `def deck_load(span_m, traffic_kn):
    dead = 18.5 * span_m          # the bridge's own weight, kN
    live = traffic_kn * 1.35      # traffic with an allowance
    return dead + live

limit = 4200
checked = deck_load(120, 600)
print("safe" if checked < limit else "check again")`;

export function codeBlock(id: string, caption?: string): BlockOfType<'code'> {
  return {
    id,
    type: 'code',
    version: 1,
    a11y: { label: 'Code: a small load check' },
    fallbackText:
      'A short Python function adds the bridge deck weight to the traffic load and compares the total with a limit.',
    essential: false,
    gesture: 'horizontal',
    data: {
      language: 'python',
      title: 'load check',
      code: LOAD_CHECK,
      highlightLines: [2, 3],
      ...(caption === undefined ? {} : { caption }),
    },
  };
}

export function disclosureBlock(id: string): BlockOfType<'disclosure'> {
  return {
    id,
    type: 'disclosure',
    version: 1,
    a11y: { label: 'Why a safety factor?' },
    fallbackText:
      'Engineers design for more load than they expect, because real loads, materials and ageing are never exactly as drawn.',
    essential: false,
    gesture: 'none',
    data: {
      summary: 'Why a safety factor?',
      blocks: [
        paragraph(
          'safety-why',
          spans(
            'Real loads are messier than drawings. Steel varies a little, ice and wind arrive together, and a bridge ages for a century. A ',
            strong('safety factor'),
            ' is the margin that covers all of that.',
          ),
          false,
        ),
        list('safety-list', 'bullet', [
          spans('Materials are never exactly as specified.'),
          spans('Loads can arrive together.'),
          spans('Time wears every joint.'),
        ]),
        callout('safety-note', 'note', spans('The factor is chosen from long experience, not from a single formula.')),
      ],
    },
  };
}

const bridgeSections = (extra: Block[] = []): ReturnType<typeof section>[] => [
  section('opening', null, [
    paragraph(
      'p-open-1',
      spans(
        'A bridge has one job: carry weight from where it is to where it can safely go. ',
        em('How'),
        ' it does that is a story about two forces.',
      ),
    ),
    paragraph(
      'p-open-2',
      spans(
        'Pushing squeezes a material. Pulling stretches it. ',
        strong('Every shape'),
        ' a bridge takes is a decision about where to put each.',
      ),
    ),
    quote('q-pull', 'pull', spans('The shape is the argument.')),
  ]),
  section('forces', 'Pushing and pulling', [
    paragraph(
      'p-forces-1',
      spans(
        'Stone likes to be squeezed and hates to be stretched, so an old arch puts all of its stone in compression. Steel cable is the other way round: it is happiest pulled tight, which is why a suspension bridge hangs from it.',
      ),
    ),
    figureBlock('fig-arch'),
    list('l-forces', 'bullet', [
      spans(strong('Compression'), ' pushes the ends of a part toward each other.'),
      spans(strong('Tension'), ' pulls the ends of a part apart.'),
      spans('Most real parts feel a mix, and a good design keeps each part doing the one thing it is best at.'),
    ]),
    comparisonBlock('cmp-hold'),
    callout(
      'c-key',
      'key-idea',
      spans('Put each material where its strength lives: stone and concrete in compression, steel in tension.'),
      'The whole idea',
    ),
    subheading('s-where', 'Where the force goes'),
    paragraph(
      'p-where',
      spans(
        'Follow any load from the deck and you will find it travelling in a line, from part to part, until it reaches the ground. Engineers call that line the ',
        code('load path'),
        ', and a bridge is well designed when every part of it is on one.',
      ),
    ),
    ...extra,
    quote(
      'q-saying',
      'quotation',
      spans('Build it as if it will be tested by the worst day of the century.'),
      'A saying among bridge builders',
    ),
    callout(
      'c-example',
      'example',
      spans(
        'A footbridge made from a plank is in bending. The top of the plank is squeezed and the bottom is stretched, so even a plank is a small lesson in both forces.',
      ),
      'A plank',
    ),
  ]),
  section('check', 'Reading a load check', [
    paragraph(
      'p-check',
      spans(
        'Before anything is built, someone adds up the loads. The sum is not complicated, and the habit of writing it down is the point.',
      ),
    ),
    codeBlock('code-load', 'The numbers here are for illustration.'),
    tableBlock('t-loads'),
    barChart('chart-designs'),
    callout(
      'c-limit',
      'limit',
      spans(
        'A sum like this cannot tell you whether a real bridge is safe. It shows the shape of the reasoning, not an engineer’s calculation.',
      ),
      'What this cannot do',
    ),
    disclosureBlock('d-safety'),
    callout(
      'c-try',
      'try-it',
      spans(
        'Change the span in the check above in your head: if the span doubles, what happens to the deck’s own weight?',
      ),
    ),
  ]),
];

/** The poster template: opening card, the text-family blocks, code, a disclosure, a figure, a comparison, a table, a chart and a stepped diagram. */
export function bridgesPoster(revision = 1): ScrollDocument {
  return scrollFixture({
    assetId: 'fixture-bridges',
    revision,
    template: 'poster',
    family: 'systems',
    kicker: 'Engineering',
    title: 'Why bridges stay up',
    dek: 'Every bridge is a deal between pushing and pulling, and the shape is the deal.',
    sections: bridgeSections([loadPathDiagram('diagram-load')]),
  });
}

/**
 * The same revision as the server negotiates it for a client that lacks `diagram` (`negotiate`:
 * the `fallback` block stands in, and the document carries its `rendition` hash).
 */
export function bridgesWithServerFallback(): ScrollDocument {
  const outcome = negotiate(bridgesPoster(), {
    documentSchemas: [SCROLL_DOCUMENT_SCHEMA_VERSION],
    blocks: Object.fromEntries(
      BLOCK_TYPES.filter((type) => type !== 'diagram').map((type) => [type, [BLOCK_VERSIONS[type]]]),
    ),
  });
  if (outcome.kind !== 'negotiated') throw new Error(`the fixture could not be negotiated: ${outcome.kind}`);
  return outcome.document;
}

/** A hypothetical Scroll with a persistent correction, for the framing and correction notices. */
export function lighthouseEditorial(): ScrollDocument {
  return scrollFixture({
    assetId: 'fixture-lighthouse',
    template: 'editorial',
    family: 'past',
    kicker: 'Essay · The age of lamps',
    title: 'How lighthouse keepers kept the night',
    dek: 'Before automation, a lamp on a rock depended on a person who never slept on watch.',
    framing: {
      kind: 'hypothetical',
      assumptions: ['The lamp has no clockwork and must be turned by hand.'],
      kept: ['The coast, the weather and the ships are as they were.'],
    },
    corrections: [
      { on: '2026-10-14', summary: 'The second paragraph now says the lamp was trimmed, not replaced, each watch.' },
    ],
    sections: [
      section('watch', null, [
        paragraph(
          'p-watch-1',
          spans(
            'For a century the safest thing on a dangerous coast was a person awake at the right moment. The lamp itself was simple: a flame, a lens and a reflector. What made it work was the watch.',
          ),
        ),
        paragraph(
          'p-watch-2',
          spans(
            'Each night the keeper trimmed the wick, polished the glass and wound the weights that turned the lens. The work was small and it was never finished, because ',
            em('finished'),
            ' would have meant the light going out.',
          ),
        ),
        subheading('s-log', 'The log'),
        paragraph(
          'p-watch-3',
          spans(
            'Every watch ended with an entry in the log: the weather, the oil used, the ships seen. The log was not for the sailors. It was for the next keeper, who would take the lamp over in the dark and needed to know what the last one had learned.',
          ),
        ),
        quote(
          'q-keeper',
          'quotation',
          spans('A light that is almost always lit is a light no one trusts.'),
          'A keeper’s rule, as the story goes',
        ),
        figureBlock('fig-lamp', 'fixture-lamp'),
        timelineBlock('tl-century'),
        audioBlock('audio-bearings'),
      ]),
    ],
  });
}

/** The poster template with the interactive and visual blocks: four simulations (every view), a stepper, three diagrams and every chart kind. */
export function experimentsPoster(): ScrollDocument {
  return scrollFixture({
    assetId: 'fixture-experiments',
    template: 'poster',
    family: 'learning-machines',
    kicker: 'Try it',
    title: 'Small experiments you can run',
    dek: 'Move a slider, drag a weight, step through a plan: each block is a small experiment with its own words.',
    framing: { kind: 'perspective', lens: 'a workshop bench' },
    sections: [
      section('swing', null, [
        paragraph(
          'p-swing',
          spans(
            'A weight on a string is the oldest clock there is. How long it takes to swing depends on one thing you can change.',
          ),
        ),
        pendulumSimulation('sim-pendulum'),
        callout(
          'c-swing',
          'try-it',
          spans('Make the string four times longer. Does the swing take four times as long?'),
        ),
      ]),
      section('rooms', 'Rooms and pots', [
        floorSimulation('sim-floor'),
        altitudeSimulation('sim-altitude'),
        interestSimulation('sim-interest'),
      ]),
      section('plans', 'Plans', [
        sequenceBlock('seq-size'),
        weightDiagram('diagram-weight'),
        cycleDiagram('diagram-cycle'),
        layersDiagram('diagram-layers'),
        gridDiagram('diagram-grid'),
      ]),
      section('data', 'Reading the numbers', [
        lineChart('chart-line'),
        horizontalBarChart('chart-span'),
        scatterChart('chart-scatter'),
        heatmapChart('chart-heat'),
        comparisonBlock('cmp-three', 3),
      ]),
    ],
  });
}
