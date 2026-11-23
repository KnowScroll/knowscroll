import type { LibrarySystem, SystemRecipes } from './plan.js';

/**
 * The human body: how blood, nerves and the immune system work. Physiology only: no recipe gives
 * medical advice, diagnosis or treatment.
 */
export const humanBodySystem = {
  id: 'human-body',
  meaning: 'How the organs and systems of the human body work.',
  sceneFamily: 'archipelago.v1',
  haze: 'coral',
  topics: [
    {
      id: 'human-body.heart-and-blood',
      meaning: 'The heart and blood vessels move blood, and with it oxygen, around the body.',
      sceneFamily: 'ridged.v1',
      facets: [
        {
          id: 'human-body.heart-and-blood.pumping',
          meaning: 'The heart’s chambers and valves pump blood in a repeating cycle.',
        },
        {
          id: 'human-body.heart-and-blood.pressure',
          meaning: 'Blood pressure depends on the heart’s output and on how much the vessels resist flow.',
        },
        {
          id: 'human-body.heart-and-blood.oxygen',
          meaning: 'Haemoglobin picks up oxygen in the lungs and releases it where it is needed.',
        },
      ],
    },
    {
      id: 'human-body.nervous-system',
      meaning: 'Nerve cells send signals along their length and between one another.',
      facets: [
        {
          id: 'human-body.nervous-system.signal',
          meaning: 'A nerve cell fires a brief electrical impulse, an action potential, along its length.',
        },
        {
          id: 'human-body.nervous-system.synapse',
          meaning: 'Chemical messengers carry the signal across the gap between two cells.',
        },
        {
          id: 'human-body.nervous-system.reflex',
          meaning: 'Short circuits through the spinal cord produce fast, automatic responses.',
        },
      ],
    },
    {
      id: 'human-body.immune-system',
      meaning: 'The immune system recognises and responds to threats such as infections.',
      sceneFamily: 'terraced.v1',
      facets: [
        {
          id: 'human-body.immune-system.innate',
          meaning: 'Fast, general defences respond within hours without earlier exposure.',
        },
        {
          id: 'human-body.immune-system.adaptive',
          meaning: 'Lymphocytes learn a specific threat and tailor a response to it.',
        },
        {
          id: 'human-body.immune-system.memory',
          meaning: 'After exposure or vaccination, memory cells let the next response start faster.',
        },
      ],
    },
  ],
} as const satisfies LibrarySystem;

const system = 'human-body';

export const humanBodyRecipes = {
  'cardiac-cycle': {
    explanationUnitId: 'human-body-heart-cardiac-cycle-v1',
    assetId: 'c1410283-322e-4117-8fe4-0390bd790dbb',
    systemId: system,
    topicId: 'human-body.heart-and-blood',
    facetId: 'human-body.heart-and-blood.pumping',
    interactive: true,
    interactiveKind: 'sequence',
    brief:
      'How one heartbeat moves blood. The cardiac cycle alternates a period when the heart muscle relaxes and refills with a period when it contracts and pumps. Step through the stages of filling and contraction, showing how the valves keep blood moving one way and how the right side serves the lungs while the left side serves the rest of the body. Keep to normal physiology: describe no diseases, and give no heart rate as a rule for any person.',
    pages: ['https://en.wikipedia.org/wiki/Cardiac_cycle'],
    scrollV3: {
      shape: 'mechanism',
      sections: [
        'One heartbeat: the heart relaxes and refills, then contracts and pumps',
        'Valves open and close so blood keeps moving one way',
        'The right side serves the lungs; the left side serves the rest of the body',
      ],
      pictures: [
        {
          kind: 'cycle',
          purpose:
            'One heartbeat as a ring of five stages: ventricles relax and fill; atria contract; ventricles contract with all valves shut; ventricles eject blood as the outflow valves open; ventricles relax with the valves shut, then refill. Each note says which valves are open or shut.',
        },
        {
          kind: 'grid',
          purpose:
            'A 2 x 2 of the two sides of the heart: rows right side and left side, columns where blood arrives from and where it is pumped to.',
        },
      ],
      misconception: { kind: 'none' },
    },
  },
  'blood-pressure': {
    explanationUnitId: 'human-body-heart-blood-pressure-v1',
    assetId: 'efbdc415-b0aa-4682-b704-28cc9c4adc62',
    systemId: system,
    topicId: 'human-body.heart-and-blood',
    facetId: 'human-body.heart-and-blood.pressure',
    interactive: true,
    interactiveKind: 'simulation',
    brief:
      'What sets blood pressure. Vascular resistance is the resistance blood must overcome to flow through the circulation, and in the fluid version of Ohm’s law the pressure difference equals the flow multiplied by the resistance. Narrowing the arteries and arterioles raises resistance and widening them lowers it. Explain how the pressure difference responds to a change in flow and in resistance in words, with no numbers at all. This is physiology, not medical advice: give no target numbers, diagnosis or treatment.',
    pages: ['https://en.wikipedia.org/wiki/Vascular_resistance'],
    scrollV3: {
      shape: 'mechanism',
      sections: [
        'Blood pressure is what it takes to push blood through resistance',
        'Pressure difference equals flow times resistance',
        'Narrowing the small arteries raises resistance; widening them lowers it',
      ],
      pictures: [
        {
          kind: 'flow',
          purpose:
            'A chain of cause and effect: small arteries and arterioles narrow; vascular resistance rises (it varies inversely with the fourth power of vessel radius); a larger pressure difference is needed to push the same flow. No numbers other than "fourth power".',
        },
        {
          kind: 'statement',
          purpose:
            "A short labelled list of the three quantities in the fluid version of Ohm's law: pressure difference (like voltage), flow (like current), resistance (like electrical resistance).",
        },
      ],
      misconception: { kind: 'none' },
    },
  },
  'oxygen-transport': {
    explanationUnitId: 'human-body-heart-oxygen-transport-v1',
    assetId: '24bdb613-1927-4527-96a2-7977e96c2c67',
    systemId: system,
    topicId: 'human-body.heart-and-blood',
    facetId: 'human-body.heart-and-blood.oxygen',
    interactive: true,
    interactiveKind: 'chart',
    brief:
      'How blood carries oxygen. Haemoglobin in red blood cells binds oxygen where it is plentiful, in the lungs, and releases it in tissues where it is scarcer, and the oxygen–haemoglobin dissociation curve is S-shaped rather than a straight line. Compare the flat part of the curve, where the lungs load haemoglobin, with the steep part, where tissues unload it, and say that conditions of active tissue, such as exercise, shift the curve so haemoglobin gives up more oxygen. Give no figures from the curve and no numeric thresholds as medical guidance.',
    pages: ['https://en.wikipedia.org/wiki/Oxygen%E2%80%93hemoglobin_dissociation_curve'],
    scrollV3: {
      shape: 'mechanism',
      sections: [
        'Haemoglobin binds oxygen in the lungs and releases it in the tissues',
        'The curve is S-shaped: a flat top near the lungs, a steep part in tissues',
        'Active tissue shifts the curve so haemoglobin gives up more oxygen',
      ],
      pictures: [
        {
          kind: 'grid',
          purpose:
            'A 2 x 2 reading the S-shaped curve: rows the flat part (lungs, pulmonary capillaries) and the steep part (tissues, systemic capillaries), columns where it is and what haemoglobin does there.',
        },
        {
          kind: 'statement',
          purpose:
            'A list of what shifts the curve to the right, so haemoglobin lets go of oxygen more easily: a higher temperature, more hydrogen ions (acid), more 2,3-BPG, more carbon dioxide, and exercise as the time tissues need oxygen most.',
        },
      ],
      misconception: { kind: 'none' },
    },
  },
  'action-potential': {
    explanationUnitId: 'human-body-nerves-action-potential-v1',
    assetId: 'fc9863c0-0ea1-47d8-8242-49dac1d401ab',
    systemId: system,
    topicId: 'human-body.nervous-system',
    facetId: 'human-body.nervous-system.signal',
    interactive: true,
    interactiveKind: 'diagram',
    brief:
      'How a nerve cell sends a signal. A resting neuron holds a voltage across its membrane; when it is pushed past a threshold, ion channels open in turn and a brief electrical spike, an action potential, travels along the cell. Let the reader step through rest, rising, falling and recovery. Do not say nerves carry electricity like a copper wire, and give no medical advice.',
    pages: ['https://en.wikipedia.org/wiki/Action_potential'],
    scrollV3: {
      shape: 'mechanism',
      sections: [
        'A resting neuron holds a voltage across its membrane',
        'A push past threshold opens ion channels in turn and a spike travels on',
        'Rising, falling and recovery: the shape of one action potential',
      ],
      pictures: [
        {
          kind: 'statement',
          purpose:
            'A short labelled list of three: rest (the channels are shut, the voltage is around -70 mV); threshold (the channels begin to open, around -55 mV); the spike (the voltage shoots upward and back down, often ending below the resting level for a while).',
        },
        {
          kind: 'flow',
          purpose:
            'The phases in order: channels shut at rest; sodium channels open and sodium rushes in; the sodium channels inactivate; potassium channels open and potassium flows out; the voltage returns to rest after a brief dip below it.',
        },
      ],
      misconception: { kind: 'none' },
    },
  },
  'synapse-signalling': {
    explanationUnitId: 'human-body-nerves-synapse-v1',
    assetId: '6aa7d57d-85dc-451d-a19c-cd27156b178d',
    systemId: system,
    topicId: 'human-body.nervous-system',
    facetId: 'human-body.nervous-system.synapse',
    interactive: false,
    interactiveKind: null,
    brief:
      'How a signal crosses from one nerve cell to the next. At a synapse the sending cell releases chemical messengers, called neurotransmitters, into a tiny gap; they bind to receptors on the next cell, which they can excite or inhibit. Compare an exciting and an inhibiting connection. Do not call any one chemical the happiness chemical, and give no advice about drugs.',
    pages: ['https://en.wikipedia.org/wiki/Synapse'],
    scrollV3: {
      shape: 'mechanism',
      sections: [
        'A signal crosses between nerve cells as a chemical message',
        'Neurotransmitters cross a tiny gap and bind to receptors on the next cell',
        'Some connections excite the next cell and others inhibit it',
      ],
      pictures: [
        {
          kind: 'flow',
          purpose:
            'The crossing in order: electrical activity in the sending cell; it is converted into the release of a neurotransmitter; the neurotransmitter crosses the gap; it binds to receptors on the next cell; the next cell is excited or inhibited.',
        },
        {
          kind: 'grid',
          purpose:
            'A 2 x 2 contrast of an exciting and an inhibiting connection: rows excitatory and inhibitory, columns the effect on the next cell and the ion channels involved.',
        },
      ],
      misconception: { kind: 'none' },
    },
  },
  'reflex-arc': {
    explanationUnitId: 'human-body-nerves-reflex-v1',
    assetId: '7abbb071-b217-4352-a01d-ab1d40a31642',
    systemId: system,
    topicId: 'human-body.nervous-system',
    facetId: 'human-body.nervous-system.reflex',
    interactive: false,
    interactiveKind: null,
    brief:
      'Why a reflex is faster than a decision. A reflex arc runs from a sensory receptor along a nerve to the spinal cord and straight back to a muscle, so the response does not wait for the brain. Explain what makes it fast, and that the brain receives the input while the reflex is being carried out and analyses it afterwards. Do not say reflexes involve no brain at all or that they are conscious decisions.',
    pages: ['https://en.wikipedia.org/wiki/Reflex_arc'],
    scrollV3: {
      shape: 'mechanism',
      sections: [
        'A reflex answers a stimulus without waiting for a decision',
        'The arc: receptor, sensory nerve, spinal cord, motor nerve, muscle',
        'What makes it fast, and how the brain still takes part',
      ],
      pictures: [
        {
          kind: 'flow',
          purpose:
            'The somatic reflex path in order: a receptor; an afferent (sensory) nerve fibre carrying signals to the spinal cord; an integrating centre; an efferent (motor) nerve fibre; the effector muscle that carries out the response.',
        },
      ],
      misconception: { kind: 'none' },
    },
  },
  'innate-immunity': {
    explanationUnitId: 'human-body-immune-innate-v1',
    assetId: '6045eacb-8f65-4ecf-98bd-915f6c73c91a',
    systemId: system,
    topicId: 'human-body.immune-system',
    facetId: 'human-body.immune-system.innate',
    interactive: false,
    interactiveKind: null,
    brief:
      'The body’s first, fast response to threats. The immune system has layers; the innate layer answers many kinds of threat in much the same way without earlier exposure, through barriers and cells that engulf invaders. Explain what this general defence does well and why it is not enough on its own. Give no advice about treating infections.',
    pages: ['https://en.wikipedia.org/wiki/Immune_system'],
    scrollV2: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-first-guard', name: 'The First Guard' },
    },
  },
  'adaptive-immunity': {
    explanationUnitId: 'human-body-immune-adaptive-v1',
    assetId: '3e694644-2f27-4a20-9565-2c0a4903da05',
    systemId: system,
    topicId: 'human-body.immune-system',
    facetId: 'human-body.immune-system.adaptive',
    interactive: false,
    interactiveKind: null,
    brief:
      'How the immune system learns a specific threat. White blood cells called lymphocytes recognise particular molecules of an invader, and the matching cells multiply and make a tailored response, including antibodies. Explain recognition, multiplication and attack in plain terms. Do not describe immunity as all or nothing, and give no medical advice.',
    pages: ['https://en.wikipedia.org/wiki/Adaptive_immune_system'],
    scrollV2: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-tailored-defence', name: 'The Tailored Defence' },
    },
  },
  'immune-memory': {
    explanationUnitId: 'human-body-immune-memory-v1',
    assetId: '487b2849-52b5-4465-ae8d-49111f99a99f',
    systemId: system,
    topicId: 'human-body.immune-system',
    facetId: 'human-body.immune-system.memory',
    interactive: false,
    interactiveKind: null,
    brief:
      'Why a second exposure to a threat is handled faster. After an infection or a vaccine, memory cells remain, so a later encounter triggers a quicker and stronger response than the first. Explain that a vaccine lets the immune system practise on a harmless form of a threat. Give no vaccine schedules and no advice about any specific vaccine.',
    pages: ['https://en.wikipedia.org/wiki/Immunological_memory'],
    scrollV2: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-remembered-foe', name: 'The Remembered Foe' },
    },
  },
} as const satisfies SystemRecipes<typeof humanBodySystem>;
