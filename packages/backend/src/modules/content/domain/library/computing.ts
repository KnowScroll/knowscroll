import type { LibrarySystem, SystemRecipes } from './plan.js';

/** Computing and the web: how a page reaches a browser, how it is drawn, and how algorithms scale. */
export const computingSystem = {
  id: 'computing',
  meaning: 'How the web, browsers and everyday algorithms work.',
  sceneFamily: 'terraced.v1',
  haze: 'cobalt',
  topics: [
    {
      id: 'computing.web-requests',
      meaning: 'What happens between typing an address and seeing a page.',
      sceneFamily: 'archipelago.v1',
      facets: [
        {
          id: 'computing.web-requests.naming',
          meaning: 'The Domain Name System turns a name into the address of a server.',
        },
        {
          id: 'computing.web-requests.secure-transport',
          meaning: 'A secure connection lets a browser and server exchange data privately.',
        },
        {
          id: 'computing.web-requests.caching',
          meaning: 'Caches reuse earlier responses to save time and traffic.',
        },
      ],
    },
    {
      id: 'computing.browsers',
      meaning: 'How a browser turns code into a page you can use.',
      facets: [
        {
          id: 'computing.browsers.rendering',
          meaning: 'Parsing, styling, layout and painting turn markup into pixels.',
        },
        {
          id: 'computing.browsers.event-loop',
          meaning: 'Scripts run one task at a time, and events wait their turn.',
        },
        {
          id: 'computing.browsers.same-origin',
          meaning: 'The same-origin policy keeps one site’s pages from reading another’s data.',
        },
      ],
    },
    {
      id: 'computing.algorithms',
      meaning: 'Ways of solving problems with code, and how their cost grows with the size of the problem.',
      sceneFamily: 'ridged.v1',
      facets: [
        {
          id: 'computing.algorithms.growth',
          meaning: 'Cost is described by how the work grows with the size of the input.',
        },
        {
          id: 'computing.algorithms.sorting',
          meaning: 'Different sorting strategies trade speed, memory and stability.',
        },
        {
          id: 'computing.algorithms.hashing',
          meaning: 'Hash tables give fast lookups by turning keys into positions.',
        },
      ],
    },
  ],
} as const satisfies LibrarySystem;

const system = 'computing';

export const computingRecipes = {
  'dns-lookup': {
    explanationUnitId: 'computing-web-requests-dns-v1',
    assetId: '7617baa4-811c-49a7-b686-a4f32af3f974',
    systemId: system,
    topicId: 'computing.web-requests',
    facetId: 'computing.web-requests.naming',
    interactive: true,
    interactiveKind: 'sequence',
    brief:
      'How a name becomes an address. The Domain Name System is a hierarchical, distributed naming system, often compared to the phone book of the internet: responsibility for each part of the name space is delegated to a zone, and the name space is a tree. Step the reader through a lookup that follows the name from the top of that tree down to the zone that holds the answer. Name no provider, and do not imply that DNS shows the content of a page.',
    pages: ['https://en.wikipedia.org/wiki/Domain_Name_System'],
    scrollV2: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-address-book', name: 'The Address Book' },
    },
  },
  'https-handshake': {
    explanationUnitId: 'computing-web-requests-https-v1',
    assetId: 'ded6d8ef-0641-482d-ae4c-6faf786457e0',
    systemId: system,
    topicId: 'computing.web-requests',
    facetId: 'computing.web-requests.secure-transport',
    interactive: false,
    interactiveKind: null,
    brief:
      'How a browser sets up a private connection. Transport Layer Security lets the two sides agree on how to protect their traffic and prove who the server is before ordinary data flows. Explain the idea of the handshake in plain terms and what encryption protects. Do not say a secure connection makes a site trustworthy, and do not say it hides which site you visit completely.',
    pages: ['https://developer.mozilla.org/en-US/docs/Web/Security/Transport_Layer_Security'],
    scrollV2: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-secret-handshake', name: 'The Secret Handshake' },
    },
  },
  'web-caching': {
    explanationUnitId: 'computing-web-requests-caching-v1',
    assetId: '0199148f-9288-4acf-8f2b-d63542cb62d6',
    systemId: system,
    topicId: 'computing.web-requests',
    facetId: 'computing.web-requests.caching',
    interactive: true,
    interactiveKind: 'comparison',
    brief:
      'Why a page often loads faster the second time. A web cache stores copies of pages and images it has already fetched, so a repeat request can be answered from the copy instead of going back to the original server. Compare a request answered from a cache with one that has to go to the source. Do not imply a cache always serves current content, or that it is always safe for private data.',
    pages: ['https://en.wikipedia.org/wiki/Web_cache'],
    scrollV2: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-saved-copy', name: 'The Saved Copy' },
    },
  },
  'rendering-pipeline': {
    explanationUnitId: 'computing-browsers-rendering-v1',
    assetId: '1eb8e8f8-b42f-4df1-832f-28761d4f03e1',
    systemId: system,
    topicId: 'computing.browsers',
    facetId: 'computing.browsers.rendering',
    interactive: false,
    interactiveKind: null,
    brief:
      'From text to pixels. The browser turns the page’s markup and style rules into trees, works out where each element goes, and then paints it to the screen. Explain these steps in order and why a page that waits on heavy resources shows up late. Do not present one browser engine’s internals as universal.',
    pages: ['https://developer.mozilla.org/en-US/docs/Web/Performance/Guides/Critical_rendering_path'],
    scrollV2: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-pixel-path', name: 'The Pixel Path' },
    },
  },
  'event-loop': {
    explanationUnitId: 'computing-browsers-event-loop-v1',
    assetId: '66266597-8b3f-4af3-974b-19683c3a5b76',
    systemId: system,
    topicId: 'computing.browsers',
    facetId: 'computing.browsers.event-loop',
    interactive: false,
    interactiveKind: null,
    brief:
      'Why a busy script can freeze a page. An event loop keeps asking for the next event and dispatching it; a web page and its JavaScript typically run in a single thread, with a queue of tasks waiting their turn. Explain the queue and what a long task does to everything behind it. Do not say JavaScript is multi-threaded by default or promise exact timings.',
    pages: ['https://en.wikipedia.org/wiki/Event_loop'],
    scrollV2: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-patient-loop', name: 'The Patient Loop' },
    },
  },
  'same-origin-policy': {
    explanationUnitId: 'computing-browsers-same-origin-v1',
    assetId: '1fd7c725-e8b5-4689-8af8-431c5c936a93',
    systemId: system,
    topicId: 'computing.browsers',
    facetId: 'computing.browsers.same-origin',
    interactive: true,
    interactiveKind: 'comparison',
    brief:
      'Why one website cannot freely read another’s data in your browser. Under the same-origin policy a script on one page may access data from another only if both have the same origin, and sites can opt in to controlled sharing. Compare a same-origin case with a cross-origin case, including why this protects a signed-in session. Do not suggest the policy stops every kind of attack.',
    pages: ['https://en.wikipedia.org/wiki/Same-origin_policy'],
    scrollV2: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-wall-between-sites', name: 'The Wall Between Sites' },
    },
  },
  'big-o-growth': {
    explanationUnitId: 'computing-algorithms-growth-v1',
    assetId: '823c69ae-5f7d-4484-abfc-b52556515285',
    systemId: system,
    topicId: 'computing.algorithms',
    facetId: 'computing.algorithms.growth',
    interactive: true,
    interactiveKind: 'chart',
    brief:
      'How to compare algorithms by how their work grows with the size of the input, not by a stopwatch. Time complexity describes the amount of time an algorithm takes as a function of input size, usually for the worst case. Compare constant, logarithmic and linear growth as the input gets larger, in illustrative units, with binary search as the logarithmic example. Do not claim the notation predicts running time exactly.',
    pages: ['https://en.wikipedia.org/wiki/Time_complexity'],
    scrollV2: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-growth-curve', name: 'The Growth Curve' },
    },
  },
  'hybrid-sorting': {
    explanationUnitId: 'computing-algorithms-sorting-v1',
    assetId: '368b6a99-b649-45aa-bf03-c5ee5a3618e5',
    systemId: system,
    topicId: 'computing.algorithms',
    facetId: 'computing.algorithms.sorting',
    interactive: false,
    interactiveKind: null,
    brief:
      'Why real sorting code combines methods. Timsort is a stable hybrid of merge sort and insertion sort built for real data, which often already contains runs that are in order; it finds those runs and merges them. Explain what stable means and why exploiting existing order helps. Do not declare any one method the best for every situation.',
    pages: ['https://en.wikipedia.org/wiki/Timsort'],
    scrollV2: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-sorted-runs', name: 'The Sorted Runs' },
    },
  },
  'hash-tables': {
    explanationUnitId: 'computing-algorithms-hashing-v1',
    assetId: 'a0a38846-a07e-4ca8-9dc3-01952f623f81',
    systemId: system,
    topicId: 'computing.algorithms',
    facetId: 'computing.algorithms.hashing',
    interactive: true,
    interactiveKind: 'diagram',
    brief:
      'How a hash table finds an item almost instantly. A hash function turns a key into a position in an array of buckets; because two keys can land in the same place, collisions are handled by chaining or by probing for another slot, and performance falls as the table fills. Let the reader add keys and see where they land and what a collision looks like. Do not claim lookups are always constant time.',
    pages: ['https://en.wikipedia.org/wiki/Hash_table'],
    scrollV2: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-labelled-shelf', name: 'The Labelled Shelf' },
    },
  },
} as const satisfies SystemRecipes<typeof computingSystem>;
