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
    // The beat in order (the atria, then the ventricles), the four valves opening and shutting with the pressure
    // behind them, and the right side serving the lungs and the left the body are what the kit draws (D-201).
    stageKit: 'circulation.v1',
    interactive: true,
    interactiveKind: 'sequence',
    brief:
      'How one heartbeat moves blood. The cardiac cycle alternates a period when the heart muscle relaxes and refills with a period when it contracts and pumps. Step through the stages of filling and contraction, showing how the valves keep blood moving one way and how the right side serves the lungs while the left side serves the rest of the body. Keep to normal physiology: describe no diseases, and give no heart rate as a rule for any person.',
    pages: ['https://en.wikipedia.org/wiki/Cardiac_cycle'],
  },
  'blood-pressure': {
    explanationUnitId: 'human-body-heart-blood-pressure-v1',
    assetId: 'efbdc415-b0aa-4682-b704-28cc9c4adc62',
    systemId: system,
    topicId: 'human-body.heart-and-blood',
    facetId: 'human-body.heart-and-blood.pressure',
    // Pressure falling along the loop, the fall across a stretch as flow times resistance, and narrower or wider
    // arterioles are the pressure view, with relative pressures and no figure (D-201).
    stageKit: 'circulation.v1',
    interactive: true,
    interactiveKind: 'simulation',
    brief:
      'What sets blood pressure. Vascular resistance is the resistance blood must overcome to flow through the circulation, and in the fluid version of Ohm’s law the pressure difference equals the flow multiplied by the resistance. Narrowing the arteries and arterioles raises resistance and widening them lowers it. Let the reader change the flow and the resistance and see the pressure respond, as a labelled illustration with made-up round numbers. This is physiology, not medical advice: give no target numbers, diagnosis or treatment.',
    pages: ['https://en.wikipedia.org/wiki/Vascular_resistance'],
  },
  'oxygen-transport': {
    explanationUnitId: 'human-body-heart-oxygen-transport-v1',
    assetId: '24bdb613-1927-4527-96a2-7977e96c2c67',
    systemId: system,
    topicId: 'human-body.heart-and-blood',
    facetId: 'human-body.heart-and-blood.oxygen',
    // The S-shaped curve, haemoglobin loading in the lungs and giving some oxygen up in resting and in working
    // tissue, are the oxygen view; the effects of acidity and warmth are left out and the picture says so (D-201).
    stageKit: 'circulation.v1',
    interactive: true,
    interactiveKind: 'chart',
    brief:
      'How blood carries oxygen. Haemoglobin in red blood cells binds oxygen where it is plentiful, in the lungs, and releases it in tissues where it is scarcer, and the oxygen–haemoglobin dissociation curve is S-shaped rather than a straight line. Let the reader compare resting and active tissue on an illustrative curve. Give no numeric thresholds as medical guidance.',
    pages: ['https://en.wikipedia.org/wiki/Oxygen%E2%80%93hemoglobin_dissociation_curve'],
  },
  'action-potential': {
    explanationUnitId: 'human-body-nerves-action-potential-v1',
    assetId: 'fc9863c0-0ea1-47d8-8242-49dac1d401ab',
    systemId: system,
    topicId: 'human-body.nervous-system',
    facetId: 'human-body.nervous-system.signal',
    // Rest, threshold, rising, peak, falling and the undershoot, with the channels, the all-or-none rule and the
    // spike running one way along the axon are what the kit draws, from a model of the membrane (D-201).
    stageKit: 'nerve.v1',
    interactive: true,
    interactiveKind: 'diagram',
    brief:
      'How a nerve cell sends a signal. A resting neuron holds a voltage across its membrane; when it is pushed past a threshold, ion channels open in turn and a brief electrical spike, an action potential, travels along the cell. Let the reader step through rest, rising, falling and recovery. Do not say nerves carry electricity like a copper wire, and give no medical advice.',
    pages: ['https://en.wikipedia.org/wiki/Action_potential'],
  },
  'synapse-signalling': {
    explanationUnitId: 'human-body-nerves-synapse-v1',
    assetId: '6aa7d57d-85dc-451d-a19c-cd27156b178d',
    systemId: system,
    topicId: 'human-body.nervous-system',
    facetId: 'human-body.nervous-system.synapse',
    // The packets, the gap, the receptors and an exciting and an inhibiting connection are what the synapse view
    // draws; it names no chemical (D-201).
    stageKit: 'nerve.v1',
    interactive: false,
    interactiveKind: null,
    brief:
      'How a signal crosses from one nerve cell to the next. At a synapse the sending cell releases chemical messengers, called neurotransmitters, into a tiny gap; they bind to receptors on the next cell, which they can excite or inhibit. Compare an exciting and an inhibiting connection. Do not call any one chemical the happiness chemical, and give no advice about drugs.',
    pages: ['https://en.wikipedia.org/wiki/Synapse'],
  },
  'reflex-arc': {
    explanationUnitId: 'human-body-nerves-reflex-v1',
    assetId: '7abbb071-b217-4352-a01d-ab1d40a31642',
    systemId: system,
    topicId: 'human-body.nervous-system',
    facetId: 'human-body.nervous-system.reflex',
    // Sensor, sensory neuron, spinal cord, motor neuron and muscle, with the news still on its way to the brain
    // when the muscle responds, are the reflex view (D-201).
    stageKit: 'nerve.v1',
    interactive: false,
    interactiveKind: null,
    brief:
      'Why a reflex is faster than a decision. A reflex arc runs from a sensory receptor along a nerve to the spinal cord and straight back to a muscle, so the response does not wait for the brain. Explain what makes it fast and what a reflex cannot do. Do not say reflexes involve no brain at all or that they are conscious decisions.',
    pages: ['https://en.wikipedia.org/wiki/Reflex_arc'],
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
  },
} as const satisfies SystemRecipes<typeof humanBodySystem>;
