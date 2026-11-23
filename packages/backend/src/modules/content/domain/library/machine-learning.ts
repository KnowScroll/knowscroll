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
      'How attention decides what to look at. Each word is given an importance, as a weight, relative to the other words in the sequence; the weights come from a scaled dot-product of queries and keys passed through a softmax, and they weight the value vectors the model passes on. Say this in words, with no made-up numbers. Do not imply that attention works like human attention.',
    pages: ['https://en.wikipedia.org/wiki/Attention_(machine_learning)'],
    scrollV3: {
      shape: 'mechanism',
      sections: [
        'Attention gives each word an importance relative to the other words',
        'A scaled dot-product of queries and keys passes through a softmax to give weights',
        'The weights decide how much of each word’s value is passed on',
      ],
      misconception: { kind: 'none' },
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
      'A worked example of attention in translation. A model that squeezes a whole source sentence into one fixed summary loses detail when the input is long; attention lets the decoder look back at the parts of the source that matter for each word it writes. Follow the English-to-French example in which “the zone of international control” becomes “la zone de contrôle international”, and give no attention weights or word alignments for it, because the supplied passages show none. Do not claim the model understands the sentence the way a person does.',
    pages: ['https://en.wikipedia.org/wiki/Seq2seq'],
    scrollV3: {
      shape: 'mechanism',
      sections: [
        'One fixed summary of a whole sentence loses detail',
        'Attention lets the decoder look back at the parts of the source that matter',
        'English to French: "the zone of international control" written one word at a time',
      ],
      pictures: [
        {
          kind: 'flow',
          purpose:
            "What attention does at each step of the decoder, in order: the encoder turns the source sentence into hidden vectors; at each decoder step an alignment model scores how well each input matches the decoder's state; a softmax turns the scores into attention weights; the weighted sum of the input hidden vectors becomes the context vector; the decoder uses it, with the words it has already written, to produce the next word.",
        },
      ],
      misconception: { kind: 'none' },
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
      'What attention does and what it costs. Attention gives each token a weight relative to the other tokens in a sequence, so a token has direct access to any part of a sentence. Say what the supplied passages state about its limits: without positional encoding it does not see order, a decoder cannot attend to future outputs, and comparing every token with every other makes the computational and memory cost grow quadratically with the sequence length. Do not say attention weights prove reasoning, do not claim they are a full account of why a model gave its answer, and do not say the cost problem is solved.',
    pages: [
      'https://en.wikipedia.org/wiki/Attention_(machine_learning)',
      'https://en.wikipedia.org/wiki/Transformer_(deep_learning)',
    ],
    scrollV3: {
      shape: 'argument',
      sections: [
        'Attention gives each token a weight and direct access to the whole sentence',
        'What it leaves out: order without positional encoding, and no looking ahead when decoding',
        'Comparing every token with every other grows with the square of the length',
      ],
      misconception: { kind: 'none' },
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
      'How a transformer differs from the recurrent networks before it. Text becomes tokens, each token becomes a vector, and layers of attention let every token take account of the others at once, so that the work can run in parallel instead of one token at a time. Compare the older word-by-word design with the transformer design. Make no claims about any named product’s size or training data.',
    pages: ['https://en.wikipedia.org/wiki/Transformer_(deep_learning)'],
    scrollV3: {
      shape: 'mechanism',
      sections: [
        'Before transformers, recurrent networks read text one token at a time',
        'A transformer lets every token take account of the others at once',
        'That lets the work run in parallel instead of in sequence',
      ],
      pictures: [
        {
          kind: 'grid',
          purpose:
            'A comparison of the older recurrent design and the transformer: rows how tokens are processed, how earlier text is kept for later, and whether training can run in parallel; columns recurrent and transformer. Recurrent: one token at a time, so no parallel operation, and information about earlier text poorly preserved in a fixed-size vector. Transformer: each token is contextualised with the other tokens by attention, and tokens can be processed in parallel during training.',
        },
      ],
      misconception: { kind: 'none' },
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
    scrollV3: {
      shape: 'argument',
      sections: [
        'A model turns each token into a list of numbers called an embedding',
        'Tokens used in similar ways end up close together',
        'What closeness misses: a word with several senses',
      ],
      misconception: { kind: 'none' },
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
      'How a language model writes text. A generative pre-trained model learns to predict the next word or token from the text so far, and a decoder writes its output one element at a time, considering the elements it has already produced. Say that such models are often fine-tuned afterwards to follow instructions. Give no probabilities, because the supplied passages state none. Do not say the model plans a whole answer in advance.',
    pages: ['https://en.wikipedia.org/wiki/Large_language_model', 'https://en.wikipedia.org/wiki/Seq2seq'],
    scrollV3: {
      shape: 'mechanism',
      sections: [
        'A language model learns to predict the next token from the text so far',
        'A decoder writes one token at a time, considering what it has already written',
        'Fine-tuning then teaches such models to follow instructions',
      ],
      misconception: { kind: 'none' },
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
      'How a model learns by taking small downhill steps. Gradient descent repeatedly steps opposite to the gradient of the function it is minimising, like a walker feeling the slope on a foggy mountain. Say what a step size that is too small and one that is too large do, and that finding a good step size is an important practical problem; give no made-up numbers. Do not claim real training has one smooth valley or always finds the best answer.',
    pages: ['https://en.wikipedia.org/wiki/Gradient_descent'],
    scrollV3: {
      shape: 'mechanism',
      sections: [
        'Learning as walking downhill in a fog',
        'Each step goes against the gradient; the step size sets how far',
        'Too small is slow, too large overshoots; real training is not one valley',
      ],
      pictures: [
        {
          kind: 'cycle',
          purpose:
            'The repeating step: measure the steepness of the slope where you stand; step in the direction opposite the gradient (downhill) for a chosen step size; measure again. Centre: the minimum you are looking for.',
        },
        {
          kind: 'grid',
          purpose:
            'A 2 x 2 of step sizes: rows too small and too large, columns what happens and the word for it. Too small: slows convergence. Too large: overshoot and divergence.',
        },
      ],
      misconception: { kind: 'none' },
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
      'How a network learns from examples. A network is made of connected units whose connections carry weights; training shows it many labelled examples, such as images known to show a starfish or a sea urchin, and the weights come to link features such as a ring-textured outline to the right label. Go through one example and show how a weak or misleading association can make a mistake. Do not name the update algorithm unless a supplied passage does, and do not say the network works like a brain.',
    pages: ['https://en.wikipedia.org/wiki/Neural_network_(machine_learning)'],
    scrollV3: {
      shape: 'mechanism',
      sections: [
        'A network is connected units whose connections carry weights',
        'Training on labelled examples links features such as texture to labels',
        'One example: a weak association can give a mistaken answer',
      ],
      pictures: [
        {
          kind: 'grid',
          purpose:
            'A 2 x 2 of what training links together: rows starfish and sea urchin, columns texture and outline.',
        },
        {
          kind: 'flow',
          purpose:
            'How a mistake arises, in order: training includes one ring-textured sea urchin; a weak link forms between ringed texture and sea urchin; a new starfish image is correctly detected; the weak link also gives a weak signal for sea urchin; an oval shell adds another weak signal, which may give a false positive.',
        },
      ],
      misconception: { kind: 'none' },
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
      'Why doing well on training data is not enough. A model that matches its training data too closely, or is trained too long, can fit noise and then do worse on new data, while a model that is too simple underfits; techniques such as cross-validation and regularisation lessen overfitting. Explain in words how a model that is too simple, one that fits too closely and a balance between them differ; use no made-up curves or numbers. Do not imply that bigger models always overfit or that a held-out score guarantees real-world performance.',
    pages: ['https://en.wikipedia.org/wiki/Overfitting'],
    scrollV3: {
      shape: 'argument',
      sections: [
        'Doing well on training data is not enough',
        'Fit the noise, or train too long, and the model does worse on new data',
        'Too simple a model underfits; cross-validation and regularisation help',
      ],
      pictures: [
        {
          kind: 'grid',
          purpose:
            'A 2 x 2 of the two failures: rows underfitting and overfitting, columns what goes wrong and the sign. Underfitting: the model cannot capture the underlying structure of the data, and its predictions are poor. Overfitting: the model matches the training data too closely and extracts noise as if it were structure; performance on training examples still rises while performance on unseen data becomes worse.',
        },
      ],
      misconception: { kind: 'none' },
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
      'Why long inputs are expensive and how designs ease it. Standard self-attention compares every token with every other, so its computation and memory grow with the square of the input length. Researchers have proposed sparse attention and memory-efficient designs that reduce the cost and allow longer context windows. Say that the cost grows with the square of the input length in words, with no made-up numbers. Do not say the cost is eliminated, and name no product or price.',
    pages: ['https://en.wikipedia.org/wiki/Generative_pre-trained_transformer'],
    scrollV3: {
      shape: 'mechanism',
      sections: [
        'Self-attention compares every token with every other token',
        'So computation and memory grow with the square of the input length',
        'Sparse and memory-efficient designs ease the cost but do not remove it',
      ],
      pictures: [
        {
          kind: 'flow',
          purpose:
            'How the cost grows and is eased, in order: the input gets longer; standard self-attention has quadratic complexity in the input length, so computation and memory requirements increase significantly; researchers proposed sparse attention mechanisms and memory-efficient architectures; these reduce computational costs while supporting longer context windows. Name no product.',
        },
      ],
      misconception: { kind: 'none' },
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
      'How a model can be large yet cheap to run. In a mixture of experts several expert networks share a job and a gating function decides how to weight them; in deep learning the key goal is to reduce computing cost, so for each input only a small subset of experts is used. Compare using every expert with using only a small subset of them. Do not claim every large model uses this design.',
    pages: ['https://en.wikipedia.org/wiki/Mixture_of_experts'],
    scrollV3: {
      shape: 'mechanism',
      sections: [
        'Several expert networks share a job; a gating function weights them',
        "In the classic version every expert's output is weighted and summed",
        'In deep learning only the top few experts run, to cut computing cost',
      ],
      pictures: [
        {
          kind: 'grid',
          purpose:
            'A 2 x 2 contrasting classic and deep-learning mixture of experts: rows classic and deep learning, columns how many experts answer and why.',
        },
      ],
      misconception: { kind: 'none' },
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
      'How text is cut into tokens. Byte-pair encoding began as a compression method that repeatedly replaces the most common pair of symbols with a new symbol, and a modified form builds the vocabularies of large language models by repeatedly merging common pairs of characters. Go through a few merges on a tiny example. Say what happens to a symbol the vocabulary cannot encode. Do not claim every model tokenizes the same way.',
    pages: ['https://en.wikipedia.org/wiki/Byte_pair_encoding'],
    scrollV3: {
      shape: 'mechanism',
      sections: [
        'Byte-pair encoding began as compression: swap the commonest pair for a symbol',
        "A modified form repeats the merge to build a language model's vocabulary",
        'A symbol the vocabulary cannot encode becomes UNK; byte-level BPE avoids that',
      ],
      pictures: [
        {
          kind: 'flow',
          purpose:
            'Merges on a tiny example, one per step: start with the data aaabdaaabac, whose most frequent pair is aa; replace aa with an unused symbol Z; repeat with the pair ab and replace it with Y; optionally continue by replacing ZY with X; stop when no pair occurs more than once. Do not write out the intermediate strings.',
        },
      ],
      misconception: { kind: 'none' },
    },
  },
} as const satisfies SystemRecipes<typeof machineLearningSystem>;
