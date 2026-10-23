import type { LibrarySystem, SystemRecipes } from './plan.js';

/**
 * History: one planet, the Industrial Revolution, told as a mix of agreed facts and live debate.
 * Recipes name no dates or statistics unless the research pages support them.
 */
export const historySystem = {
  id: 'history',
  meaning: 'How past events and ideas shaped the world, told with their uncertainties.',
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
      'Why industrialisation began where it did. Historians point to several enabling factors, such as high agricultural productivity that freed workers from the land, and they debate the start, the end and the pace of the change. Lay the factors out in an order a reader can follow, without years, noting that no single cause is accepted by all. Do not present one cause as settled or Britain’s lead as inevitable.',
    pages: ['https://en.wikipedia.org/wiki/Industrial_Revolution'],
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
      'How the steam engine turned heat into motion. The Watt engine is described as the first truly efficient steam engine and was a driving force of the Industrial Revolution; it improved on the earlier atmospheric engine. Let the reader step through the cycle of a simple engine. Do not credit a single inventor with creating steam power, and give no invented efficiencies.',
    pages: ['https://en.wikipedia.org/wiki/Watt_steam_engine'],
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
      'How factories changed the way goods were made. The factory system was first adopted in Britain at the start of the Industrial Revolution and replaced the putting-out, or domestic, system. Compare the two ways of working in terms of where work happened and who controlled it. Do not romanticise either way of working.',
    pages: ['https://en.wikipedia.org/wiki/Factory_system'],
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
      'How industrialisation moved people to towns. For most of history the great majority of people worked the land; with the agricultural and Industrial Revolutions of the late eighteenth century, workers freed from farming converged on new industrial cities such as Manchester and Birmingham and urban populations grew as never before. Explain what pulled people in. Give no statistics the research page does not support, and do not reduce it to a verdict of good or bad.',
    pages: ['https://en.wikipedia.org/wiki/Urbanization'],
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
      'Why did Western Europe pull ahead, and when? The Great Divergence is the term for that shift, and scholars have proposed many explanations, including mineral deposits, geography, institutions and culture, while the timing is disputed among historians. Compare the main kinds of explanation and what evidence each leans on. Do not declare a winner, and do not present Europe’s lead as inevitable.',
    pages: ['https://en.wikipedia.org/wiki/Great_Divergence'],
  },
} as const satisfies SystemRecipes<typeof historySystem>;
