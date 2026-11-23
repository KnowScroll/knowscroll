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
      'How a name becomes an address. The Domain Name System is a hierarchical, distributed naming system, often compared to the phone book of the internet: responsibility for each part of the name space is delegated to a zone, and the name space is a tree. Go through a lookup in which a resolver follows the name from the root of that tree downward, being referred from name server to name server until one returns the answer, and say that caching means the root servers are asked relatively rarely. Name no provider, and do not imply that DNS shows the content of a page.',
    pages: ['https://en.wikipedia.org/wiki/Domain_Name_System', 'https://en.wikipedia.org/wiki/Root_name_server'],
    scrollV3: {
      shape: 'mechanism',
      sections: [
        'DNS is a hierarchical, distributed naming system: a tree of zones',
        'A resolver breaks the name into labels and is referred downward, starting at a root server',
        'A name server finally returns the answer; caching means the root is asked relatively rarely',
      ],
      pictures: [
        {
          kind: 'flow',
          purpose:
            'A lookup from the top of the tree down, using www.example.com as the name: the resolver breaks the name into labels from right to left and asks a root server about the top-level domain; the root answers with a referral to the authoritative servers for that top-level domain; each name server asked returns more specific name servers; a name server finally returns the answer to the original query. Name no provider.',
        },
      ],
      misconception: { kind: 'none' },
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
    scrollV3: {
      shape: 'mechanism',
      sections: [
        'TLS protects a connection in three ways: encryption, integrity, authentication',
        'The handshake agrees on a TLS version and a cipher suite, and the server proves who it is',
        'What encryption protects, and what a secure connection does not promise',
      ],
      pictures: [
        {
          kind: 'flow',
          purpose:
            'The handshake in order: the client connects and an initial handshake sets the security parameters; client and server agree on a version of TLS; they agree on a cipher suite (the algorithms for key agreement, authentication, encryption and message authentication); the server proves who it is with a certificate that binds its keys to its domain name; the data they then exchange is encrypted in transit.',
        },
        {
          kind: 'statement',
          purpose:
            'A three-item list of what TLS secures, one line each: encryption (data in transit cannot be read by attackers), integrity (an attacker cannot secretly modify it) and authentication (each side can prove it is who it claims to be).',
        },
      ],
      misconception: { kind: 'none' },
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
      'Why a page often loads faster the second time. A web cache keeps copies of content it has already fetched, so a repeat request can be answered from a copy instead of going back to the origin server, which can mean less overall delay. Compare how a cache decides what to do with a copy: freshness lets a response be used without re-checking the origin server, validation checks whether a stale copy is still good, and invalidation drops a copy after another request. Do not imply a cache always serves current content, or that it is always safe for private data.',
    pages: ['https://en.wikipedia.org/wiki/Web_cache'],
    scrollV3: {
      shape: 'mechanism',
      sections: [
        'A web cache keeps copies so a repeat request skips the trip to the origin',
        'Freshness, validation and invalidation decide whether a copy may be used',
        'Where caches sit, and why a copy is not always current',
      ],
      pictures: [
        {
          kind: 'grid',
          purpose:
            'A comparison of the three controls: rows freshness, validation, invalidation; columns what it does and an example. Freshness: a response can be used without re-checking the origin server (an Expires date, a max-age). Validation: a stale copy is checked with a conditional request (Last-Modified, ETag). Invalidation: usually a side effect of another request, such as a POST, PUT or DELETE to the same URL.',
        },
      ],
      misconception: { kind: 'none' },
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
    scrollV3: {
      shape: 'mechanism',
      sections: [
        'The browser turns markup and style rules into trees',
        'It combines them, works out where each element goes, then paints',
        'A page waiting on heavy resources shows up late',
      ],
      pictures: [
        {
          kind: 'flow',
          purpose:
            'The critical rendering path in order: HTML parsed into the DOM tree; CSS parsed into the CSSOM; the two combined into the render tree; layout sets size and position; pixels are painted.',
        },
        {
          kind: 'statement',
          purpose:
            'One labelled list of two things that hold a page back: the browser waits for all the CSS before it renders; some requests halt the parsing of the rest of the HTML.',
        },
      ],
      misconception: { kind: 'none' },
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
      'How a web page takes its messages one at a time. An event loop keeps asking for the next event and dispatching it; a web page and its JavaScript typically run in a single thread, with a queue of messages waiting their turn. Explain the queue, that messages are handled one at a time, and that the next message is taken only when the one before it is finished. Do not say JavaScript is multi-threaded by default; do not say a page freezes or how long anything takes, which the passages do not state.',
    pages: ['https://en.wikipedia.org/wiki/Event_loop'],
    scrollV3: {
      shape: 'mechanism',
      sections: [
        'An event loop keeps asking for the next event and dispatching it',
        'A page and its JavaScript typically run in one thread, fed from a queue',
        'The next message is taken only when the one before it is finished',
      ],
      pictures: [
        {
          kind: 'cycle',
          purpose:
            'The loop as a ring: take the next message or event from the queue; run its handler; go back for the next one, one at a time. Centre: the queue of waiting messages.',
        },
      ],
      misconception: { kind: 'none' },
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
    scrollV3: {
      shape: 'mechanism',
      sections: [
        "A script may read another page's data only from the same origin",
        'Same origin means the same scheme, host and port; anything else is cross-origin',
        'Why this protects a signed-in session, and how sites opt in to sharing',
      ],
      pictures: [
        {
          kind: 'grid',
          purpose:
            "A comparison of a same-origin case and a cross-origin case: rows same origin and cross-origin, columns what counts and what the browser does with a script's read request. Same origin: the scheme, host name and port are all exactly the same, and the browser permits the script to access data in the other page. Cross-origin: any one of the three differs, and the browser denies read access to the response.",
        },
        {
          kind: 'flow',
          purpose:
            'How the policy protects a signed-in session, in order: you stay signed in to a banking website; you visit another site that has malicious JavaScript; the script asks the banking site for data, and your session cookie goes with the request; the browser denies the script read access to the response, because it comes from another origin.',
        },
      ],
      misconception: { kind: 'none' },
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
      'How to compare algorithms by how their work grows with the size of the input, not by a stopwatch. Time complexity describes the amount of time an algorithm takes as a function of input size, usually for the worst case. Compare constant, logarithmic and linear growth as the input gets larger, in words and with an example of each, with binary search as the logarithmic example; use no made-up numbers, because the supplied passages give no sample counts. Do not claim the notation predicts running time exactly.',
    pages: ['https://en.wikipedia.org/wiki/Time_complexity'],
    scrollV3: {
      shape: 'mechanism',
      sections: [
        'Compare algorithms by how their work grows with input size, not by stopwatch',
        'Constant, logarithmic and linear growth as the input gets larger',
        'Binary search is the logarithmic example',
      ],
      pictures: [
        {
          kind: 'grid',
          purpose:
            'A comparison of three growth rates: rows constant, logarithmic, linear; columns what happens to the work as the input gets larger, and an example. Constant: the work stays within a bound that does not change with the input size (accessing an element of an array). Logarithmic: the ratio of operations to input size shrinks toward zero (binary search, looking a word up in a sorted dictionary). Linear: the work grows in step with the input (finding the smallest item in an unsorted array, adding up a list).',
        },
      ],
      misconception: { kind: 'none' },
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
    scrollV3: {
      shape: 'mechanism',
      sections: [
        'Real data often contains stretches already in order',
        'Timsort finds those runs and merges them, using insertion sort on short ones',
        'What stable means, and why only neighbouring runs are merged',
      ],
      pictures: [
        {
          kind: 'flow',
          purpose:
            'Timsort in order: scan the data and collect natural runs; extend a run shorter than the minimum run size with insertion sort; push runs on a stack; merge the runs on top when they meet the merge criterion; merge what is left two at a time until one sorted run remains.',
        },
        {
          kind: 'statement',
          purpose:
            'A short list of how Timsort uses order already in the data, one line each: it merges ordered runs instead of fixed-size sub-lists, which decreases the total number of comparisons; it reverses strictly descending runs; it merges only consecutive runs, which keeps equal keys in their order (stable).',
        },
      ],
      misconception: { kind: 'none' },
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
      'How a hash table finds an item almost instantly. A hash function turns a key into a position in an array of buckets; because two keys can land in the same place, collisions are handled by chaining or by probing for another slot, and performance falls as the table fills. Show how a key lands in a slot and what a collision looks like. Do not claim lookups are always constant time.',
    pages: ['https://en.wikipedia.org/wiki/Hash_table'],
    scrollV3: {
      shape: 'mechanism',
      sections: [
        'A hash function turns a key into a position in an array of buckets',
        'Collisions are handled by chaining or by probing for another slot',
        'Lookups are fast on average, and slow down as the table fills',
      ],
      pictures: [
        {
          kind: 'flow',
          purpose:
            'A lookup in order: the key is hashed; the hash function computes an index into an array of buckets or slots; the value is found at that index (after any collision handling).',
        },
        {
          kind: 'grid',
          purpose:
            'A comparison of the two collision strategies: rows separate chaining and open addressing, columns what it does and how performance changes as the table fills. Separate chaining stores several elements in one slot with linked lists, and its performance declines gradually as the load factor grows. Open addressing searches for the next free slot by a probing sequence, and its performance becomes very bad as the load factor approaches 1.',
        },
      ],
      misconception: { kind: 'none' },
    },
  },
} as const satisfies SystemRecipes<typeof computingSystem>;
