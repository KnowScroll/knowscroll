import type { LibrarySystem, SystemRecipes } from './plan.js';

/** Machine learning: attention, transformers, training and the cost of running a model. */
export const machineLearningSystem = {
  id: 'machine-learning',
  meaning: 'How computers learn patterns from data, and how modern language models work.',
  sceneFamily: 'ridged.v1',
  haze: 'teal',
  topics: [
    {
      id: 'machine-learning.attention',
      meaning: 'Attention lets a model weigh which parts of its input matter for each part of its output.',
      sceneFamily: 'terraced.v1',
      facets: [
        {
          id: 'machine-learning.attention.mechanism',
          meaning: 'Queries, keys and values turn similarity scores into weights over the input.',
        },
        {
          id: 'machine-learning.attention.example',
          meaning: 'A worked case shows which input words a model weighs when producing each output word.',
        },
        {
          id: 'machine-learning.attention.limits',
          meaning: 'Attention weights are not a full explanation, and attention has its own costs.',
        },
      ],
    },
    {
      id: 'machine-learning.transformers',
      meaning: 'The transformer is the network design behind most modern language models.',
      facets: [
        {
          id: 'machine-learning.transformers.architecture',
          meaning: 'A stack of similar blocks combines attention with feed-forward layers.',
        },
        {
          id: 'machine-learning.transformers.embeddings',
          meaning: 'Tokens become vectors whose geometry carries part of their meaning.',
        },
        {
          id: 'machine-learning.transformers.generation',
          meaning: 'A language model writes text by predicting one token at a time.',
        },
      ],
    },
    {
      id: 'machine-learning.training',
      meaning: 'Training adjusts a network’s numbers from data so that its predictions improve.',
      sceneFamily: 'archipelago.v1',
      facets: [
        {
          id: 'machine-learning.training.optimization',
          meaning: 'Gradient descent nudges parameters in the direction that lowers a loss.',
        },
        {
          id: 'machine-learning.training.examples',
          meaning: 'Training examples strengthen or weaken the connections between a network’s units.',
        },
        {
          id: 'machine-learning.training.generalization',
          meaning: 'A useful model does well on new data, not only on the data it learned from.',
        },
      ],
    },
    {
      id: 'machine-learning.efficiency',
      meaning: 'Designs and encodings that keep large models affordable to train and run.',
      sceneFamily: 'terraced.v1',
      facets: [
        {
          id: 'machine-learning.efficiency.long-inputs',
          meaning: 'Attention cost and memory grow quickly with input length, and designs reduce them.',
        },
        {
          id: 'machine-learning.efficiency.sparsity',
          meaning: 'Mixture of experts uses only part of a model for each input.',
        },
        {
          id: 'machine-learning.efficiency.tokens',
          meaning: 'Subword tokenization turns text into a manageable vocabulary of pieces.',
        },
      ],
    },
  ],
} as const satisfies LibrarySystem;

const system = 'machine-learning';

export const machineLearningRecipes = {
  'attention-mechanism': {
    explanationUnitId: 'machine-learning-attention-mechanism-v1',
    assetId: '548ef54f-db6f-416e-85f5-3819243e8e03',
    systemId: system,
    topicId: 'machine-learning.attention',
    facetId: 'machine-learning.attention.mechanism',
    interactive: true,
    interactiveKind: 'simulation',
    brief:
      'How attention decides what to look at. Each word is given an importance relative to the other words in the sequence, computed from queries and keys, scaled so that no single word dominates, and used to weight what the model passes on. Let the reader change one word’s score and watch the weights shift, using small made-up numbers labelled as illustrative. Do not imply that attention works like human attention.',
    pages: ['https://en.wikipedia.org/wiki/Attention_(machine_learning)'],
    scrollV2: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-weighted-glance', name: 'The Weighted Glance' },
    },
  },
  'attention-example': {
    explanationUnitId: 'machine-learning-attention-example-v1',
    assetId: '826377f5-a198-4b25-b300-3a92bcdc251a',
    systemId: system,
    topicId: 'machine-learning.attention',
    facetId: 'machine-learning.attention.example',
    interactive: true,
    interactiveKind: 'diagram',
    brief:
      'A worked example of attention in translation. A model that squeezes a whole source sentence into one fixed summary loses detail; attention lets the decoder look back at the source words that matter for each word it writes. Follow an English-to-French example and let the reader pick an output word to see which input words it leans on, flagged as an illustrative picture and not a measurement from a real model. Do not claim the model understands the sentence the way a person does.',
    pages: ['https://en.wikipedia.org/wiki/Seq2seq'],
    scrollV2: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-aligned-words', name: 'The Aligned Words' },
    },
  },
  'attention-limits': {
    explanationUnitId: 'machine-learning-attention-limits-v1',
    assetId: '8a415156-1be7-4821-b187-1041ded396af',
    systemId: system,
    topicId: 'machine-learning.attention',
    facetId: 'machine-learning.attention.limits',
    interactive: false,
    interactiveKind: null,
    brief:
      'What attention weights do and do not show. Heat maps of attention scores are a routine way to look inside a model, but they show where information flowed and are not a full account of why a model gave its answer. Also explain that comparing every word with every other makes the attention matrix grow with the square of the input length. Do not say attention maps prove reasoning, and do not say the cost problem is solved.',
    pages: ['https://en.wikipedia.org/wiki/Attention_(machine_learning)'],
    scrollV2: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-edge-of-attention', name: 'The Edge of Attention' },
    },
  },
  'transformer-architecture': {
    explanationUnitId: 'machine-learning-transformers-architecture-v1',
    assetId: '4a12c755-085a-4b24-8d28-5e0dd634d251',
    systemId: system,
    topicId: 'machine-learning.transformers',
    facetId: 'machine-learning.transformers.architecture',
    interactive: true,
    interactiveKind: 'diagram',
    brief:
      'How a transformer differs from the recurrent networks before it. Text becomes tokens, each token becomes a vector, and layers of attention let every token take account of the others at once, so that the work can run in parallel instead of one token at a time. Let the reader step from the older word-by-word design to the transformer design. Make no claims about any named product’s size or training data.',
    pages: ['https://en.wikipedia.org/wiki/Transformer_(deep_learning)'],
    scrollV2: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-stacked-blocks', name: 'The Stacked Blocks' },
    },
  },
  'token-embeddings': {
    explanationUnitId: 'machine-learning-transformers-embeddings-v1',
    assetId: '4014609c-968b-423c-8617-ca7f3a66ff8a',
    systemId: system,
    topicId: 'machine-learning.transformers',
    facetId: 'machine-learning.transformers.embeddings',
    interactive: false,
    interactiveKind: null,
    brief:
      'How words become numbers a model can use. Each word or token is mapped to a list of numbers, called an embedding, learned so that tokens used in similar ways end up close together. Explain what closeness captures and what it misses, such as a word with several senses, which later token-level embeddings address. Do not call the numbers definitions or distance a dictionary of meaning.',
    pages: ['https://en.wikipedia.org/wiki/Word_embedding'],
    scrollV2: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-word-map', name: 'The Word Map' },
    },
  },
  'next-token-generation': {
    explanationUnitId: 'machine-learning-transformers-generation-v1',
    assetId: '2973a191-5795-49c1-aab3-1beed81dfa8d',
    systemId: system,
    topicId: 'machine-learning.transformers',
    facetId: 'machine-learning.transformers.generation',
    interactive: true,
    interactiveKind: 'sequence',
    brief:
      'How a language model writes text. A generative pre-trained model learns to predict the next word or token from the text so far, then the chosen token is added to the text and the prediction repeats. Step the reader through a short sentence being built one token at a time, with made-up probabilities labelled as illustrative. Say that such models are often fine-tuned afterwards to follow instructions. Do not say the model plans a whole answer in advance.',
    pages: ['https://en.wikipedia.org/wiki/Large_language_model'],
    scrollV2: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-next-word', name: 'The Next Word' },
    },
  },
  'gradient-descent': {
    explanationUnitId: 'machine-learning-training-gradient-descent-v1',
    assetId: 'de9fccf7-d8b5-4dce-8f89-fbda41fd41e9',
    systemId: system,
    topicId: 'machine-learning.training',
    facetId: 'machine-learning.training.optimization',
    interactive: true,
    interactiveKind: 'simulation',
    brief:
      'How a model learns by taking small downhill steps. Gradient descent repeatedly steps opposite to the gradient of the function it is minimising, like a walker feeling the slope on a foggy mountain. Let the reader change the step size, the learning rate, on a one-parameter example and see steps that are too small and slow, about right, or so large that they overshoot, labelled as illustrative. Do not claim real training has one smooth valley or always finds the best answer.',
    pages: ['https://en.wikipedia.org/wiki/Gradient_descent'],
    scrollV2: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-downhill-walk', name: 'The Downhill Walk' },
    },
  },
  'training-by-example': {
    explanationUnitId: 'machine-learning-training-examples-v1',
    assetId: 'cd3f16dc-5649-4cad-917d-c0ed5074270c',
    systemId: system,
    topicId: 'machine-learning.training',
    facetId: 'machine-learning.training.examples',
    interactive: true,
    interactiveKind: 'sequence',
    brief:
      'How a network learns from examples. A network is made of connected units whose connections carry weights; training shows it many labelled examples, such as images known to show a starfish or a sea urchin, and the weights come to link features such as a ring-textured outline to the right label. Step the reader through one example and show how a weak or misleading association can make a mistake. Do not name the update algorithm unless a supplied passage does, and do not say the network works like a brain.',
    pages: ['https://en.wikipedia.org/wiki/Neural_network_(machine_learning)'],
    scrollV2: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-example-trail', name: 'The Example Trail' },
    },
  },
  overfitting: {
    explanationUnitId: 'machine-learning-training-overfitting-v1',
    assetId: 'f327b241-c332-4865-9e56-a1e240b3de1e',
    systemId: system,
    topicId: 'machine-learning.training',
    facetId: 'machine-learning.training.generalization',
    interactive: true,
    interactiveKind: 'chart',
    brief:
      'Why doing well on training data is not enough. A model that matches its training data too closely, or is trained too long, can fit noise and then do worse on new data, while a model that is too simple underfits; techniques such as cross-validation and regularisation lessen overfitting. Let the reader compare a simple, a balanced and a very flexible model on illustrative curves. Do not imply that bigger models always overfit or that a held-out score guarantees real-world performance.',
    pages: ['https://en.wikipedia.org/wiki/Overfitting'],
    scrollV2: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-too-close-fit', name: 'The Too-Close Fit' },
    },
  },
  'long-input-cost': {
    explanationUnitId: 'machine-learning-efficiency-long-inputs-v1',
    assetId: '48d8860f-7e0b-445c-8945-af6022bc2e40',
    systemId: system,
    topicId: 'machine-learning.efficiency',
    facetId: 'machine-learning.efficiency.long-inputs',
    interactive: true,
    interactiveKind: 'chart',
    brief:
      'Why long inputs are expensive and how designs ease it. Standard self-attention compares every token with every other, so its computation and memory grow with the square of the input length. Researchers have proposed sparse attention and memory-efficient designs that reduce the cost and allow longer context windows. Let the reader compare how the cost grows for a short and a long input, in illustrative units. Do not say the cost is eliminated, and name no product or price.',
    pages: ['https://en.wikipedia.org/wiki/Generative_pre-trained_transformer'],
    scrollV2: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-growing-bill', name: 'The Growing Bill' },
    },
  },
  'mixture-of-experts': {
    explanationUnitId: 'machine-learning-efficiency-sparsity-v1',
    assetId: 'ec74b8e9-c781-47a1-a079-badb4ac1b805',
    systemId: system,
    topicId: 'machine-learning.efficiency',
    facetId: 'machine-learning.efficiency.sparsity',
    interactive: true,
    interactiveKind: 'diagram',
    brief:
      'How a model can be large yet cheap to run. In a mixture of experts several expert networks share a job and a gating function decides how to weight them; in deep learning the key goal is to reduce computing cost, so for each input only a small subset of experts is used. Let the reader compare using every expert with using only the top few. Do not claim every large model uses this design.',
    pages: ['https://en.wikipedia.org/wiki/Mixture_of_experts'],
    scrollV2: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-specialist-team', name: 'The Specialist Team' },
    },
  },
  'subword-tokens': {
    explanationUnitId: 'machine-learning-efficiency-tokens-v1',
    assetId: 'a208655b-0cb0-479d-b91c-0c60b16bd33e',
    systemId: system,
    topicId: 'machine-learning.efficiency',
    facetId: 'machine-learning.efficiency.tokens',
    interactive: true,
    interactiveKind: 'sequence',
    brief:
      'How text is cut into tokens. Byte-pair encoding began as a compression method that repeatedly replaces the most common pair of symbols with a new symbol, and a modified form builds the vocabularies of large language models by repeatedly merging common pairs of characters. Step the reader through a few merges on a tiny example. Say what happens to a symbol the vocabulary cannot encode. Do not claim every model tokenizes the same way.',
    pages: ['https://en.wikipedia.org/wiki/Byte_pair_encoding'],
    scrollV2: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-word-pieces', name: 'The Word Pieces' },
    },
  },
} as const satisfies SystemRecipes<typeof machineLearningSystem>;
