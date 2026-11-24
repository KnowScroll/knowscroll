import type { LibrarySystem, SystemRecipes } from './plan.js';

/**
 * History: one planet, the Industrial Revolution, told as a mix of agreed facts and live debate.
 * Recipes name no dates or statistics unless the research pages support them.
 */
export const historySystem = {
  id: 'history',
  meaning: 'How past events and ideas shaped the world, told with their uncertainties.',
  sceneFamily: 'ridged.v1',
  haze: 'pink',
  topics: [
    {
      id: 'history.industrial-revolution',
      meaning: 'The shift from hand tools and farms to machines and factories, beginning in Britain.',
      facets: [
        {
          id: 'history.industrial-revolution.causes',
          meaning: 'Why industrialisation began where and when it did, and which causes historians weigh.',
        },
        {
          id: 'history.industrial-revolution.technology',
          meaning: 'New machines and power sources changed how goods were made.',
        },
        {
          id: 'history.industrial-revolution.consequences',
          meaning: 'Industrialisation changed where people lived and how they worked.',
        },
        {
          id: 'history.industrial-revolution.interpretation',
          meaning: 'Historians disagree about why and when Western Europe pulled ahead.',
        },
      ],
    },
  ],
} as const satisfies LibrarySystem;

const system = 'history';

export const historyRecipes = {
  'industrial-causes': {
    explanationUnitId: 'history-industrial-revolution-causes-v1',
    assetId: '9b82e818-5e5e-41c9-9a61-db8d78442de7',
    systemId: system,
    topicId: 'history.industrial-revolution',
    facetId: 'history.industrial-revolution.causes',
    interactive: true,
    interactiveKind: 'timeline',
    brief:
      'Why industrialisation began where it did. Historians point to several enabling factors, such as high agricultural productivity that freed workers from the land, and they debate the start, the end and the pace of the change. Lay the factors out in an order a reader can follow, without years. Do not present one cause as settled or Britain’s lead as inevitable.',
    pages: ['https://en.wikipedia.org/wiki/Industrial_Revolution'],
    scrollV3: {
      shape: 'argument',
      sections: [
        'A debated start: historians disagree about when it began and how fast it went',
        'Enabling factors: food and workers, transport, resources, stability, capital',
        'Several factors worked together, and the debate over how sudden it was goes on',
      ],
      pictures: [
        {
          kind: 'statement',
          purpose:
            'A short list of five enabling factors, one line each: high agricultural productivity (spare workers and food); ports, rivers, canals and roads; coal, iron and waterfalls; political stability and a legal system that supported business; financial capital to invest.',
        },
      ],
      misconception: { kind: 'none' },
    },
  },
  'steam-power': {
    explanationUnitId: 'history-industrial-revolution-steam-v1',
    assetId: '76be558c-8736-4a27-a38a-e41a8929be55',
    systemId: system,
    topicId: 'history.industrial-revolution',
    facetId: 'history.industrial-revolution.technology',
    interactive: true,
    interactiveKind: 'diagram',
    brief:
      'How the steam engine turned heat into motion. The Watt engine is described as the first truly efficient steam engine and was a driving force of the Industrial Revolution; it improved on the earlier atmospheric engine. Go through the cycle of the engine stroke by stroke. Do not credit a single inventor with creating steam power, and give no invented efficiencies.',
    pages: ['https://en.wikipedia.org/wiki/Watt_steam_engine'],
    scrollV3: {
      shape: 'mechanism',
      sections: [
        'Earlier engines used steam, then a cold-water jet, wasting heat each stroke',
        'Watt added a separate condenser so the working cylinder stayed hot',
        'One cycle of the simple engine, stroke by stroke',
      ],
      pictures: [
        {
          kind: 'cycle',
          purpose:
            'One Watt-engine cycle as a ring: the power cylinder fills with steam; a valve opens to a separate water-cooled condenser; steam flows in and condenses, which draws the steam from the main cylinder and causes the power stroke; the valve closes; the power cylinder refills with steam as the piston moves to the top; repeat.',
        },
      ],
      misconception: { kind: 'none' },
    },
  },
  'factory-system': {
    explanationUnitId: 'history-industrial-revolution-factory-v1',
    assetId: '0c45799b-08a8-43e7-b90d-d84c4f8398b7',
    systemId: system,
    topicId: 'history.industrial-revolution',
    facetId: 'history.industrial-revolution.technology',
    interactive: false,
    interactiveKind: null,
    brief:
      'How factories changed the way goods were made. The factory system was first adopted in Britain at the start of the Industrial Revolution and replaced the putting-out, or domestic, system. Compare the two ways of working in terms of where work happened and who owned the machinery. Do not romanticise either way of working.',
    pages: ['https://en.wikipedia.org/wiki/Factory_system'],
    scrollV3: {
      shape: 'argument',
      sections: [
        'Before: much making was done in homes under the putting-out system',
        'After: machinery, supervision and division of labour in one place',
        'What changed: where work happened, who owned the machinery, and the skill needed',
      ],
      pictures: [
        {
          kind: 'grid',
          purpose:
            'A comparison of two ways of working: rows where work happened and who owned the machinery; columns putting-out (domestic) system and factory system. Putting-out: work carried out in homes, often with a single loom or spinning wheel, with machinery beyond what cottage workers could afford. Factory: workers and equipment centralised under supervision, with the equipment privately owned by wealthy individuals or corporations.',
        },
      ],
      misconception: { kind: 'none' },
    },
  },
  'industrial-towns': {
    explanationUnitId: 'history-industrial-revolution-towns-v1',
    assetId: 'efc43005-b9cc-4035-b30b-b95fd4f05782',
    systemId: system,
    topicId: 'history.industrial-revolution',
    facetId: 'history.industrial-revolution.consequences',
    interactive: false,
    interactiveKind: null,
    brief:
      'How industrialisation moved people to towns. For most of history the great majority of people worked the land; with the agricultural and Industrial Revolutions of the late eighteenth century, workers freed from farming converged on new industrial cities such as Manchester and Birmingham and urban populations grew as never before. Explain what pulled people in. Give no statistics the supplied passages do not support, and do not reduce it to a verdict of good or bad.',
    pages: ['https://en.wikipedia.org/wiki/Urbanization'],
    scrollV3: {
      shape: 'story',
      sections: [
        'For most of history nearly everyone worked the land',
        'Farming needed fewer hands, and workers converged on new industrial cities',
        'Towns grew as never before, with costs as well as chances',
      ],
      pictures: [
        {
          kind: 'chart',
          purpose:
            'Bars of the share of the population urbanised in 1891, on the broader definition of urbanisation: England and Wales 72, Prussia 41, France 37, United States 28. Unit: %.',
        },
      ],
      misconception: { kind: 'none' },
    },
  },
  'industrial-debate': {
    explanationUnitId: 'history-industrial-revolution-debate-v1',
    assetId: '547d4699-c765-4626-8099-3694135ca438',
    systemId: system,
    topicId: 'history.industrial-revolution',
    facetId: 'history.industrial-revolution.interpretation',
    interactive: false,
    interactiveKind: null,
    brief:
      'Why did Western Europe pull ahead, and when? The Great Divergence is the term for that shift, and scholars have proposed many explanations, including mineral deposits, geography, culture, institutions and luck, while the timing is disputed among historians. Compare the main views of when it began and what each leans on, and say what the supplied passages state about coal, technology and culture. Do not declare a winner, and do not present Europe’s lead as inevitable.',
    pages: ['https://en.wikipedia.org/wiki/Great_Divergence'],
    scrollV3: {
      shape: 'argument',
      sections: [
        'The Great Divergence: Western Europe pulled ahead of other Eurasian powers',
        'Kinds of explanation proposed: mineral deposits, geography, culture, institutions and luck',
        'The timing is disputed: the 16th century, around 1700, or the 19th century',
      ],
      pictures: [
        {
          kind: 'grid',
          purpose:
            'A comparison of three views of when the divergence began: rows the traditional dating, the dating around 1700 and the California school; columns when it began and what each leans on. Traditional: as early as the 16th (or even 15th) century, with Europe on a trajectory of higher growth since then, pointing to the early modern era. Around 1700: grain wages diverging more sharply from the early 18th century. California school: the period of most rapid divergence was the 19th century, because the surge in productivity came with the Industrial Revolution, citing nutrition data and European trade deficits.',
        },
      ],
      misconception: { kind: 'none' },
    },
  },
} as const satisfies SystemRecipes<typeof historySystem>;
