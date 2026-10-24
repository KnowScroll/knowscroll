import type { ReelOnRecord } from './fingerprint.js';

/**
 * The fingerprints of the fourteen Reel scripts v1 ordered (`content/reel-scripts/`, frozen in Git),
 * stopped ones included: the repetition rule is deliberately cautious and keeps them all. Template
 * `3d8d42d5`, shared by every four-scene script, is what refused tides-v2 and sunburn-v2.
 * `legacy-corpus.test.ts` recomputes every row from the frozen files, so this list cannot drift.
 */
export const LEGACY_REELS_ON_RECORD: readonly ReelOnRecord[] = [
  {
    label: 'greenhouse',
    templateSha256: '3d8d42d5717360b2f25ac27086dc99a48fb9a172523d9267326fe30ec79a4795',
    argumentSha256: 'd93566b0e3bad1bd6554639b9e1b4a696ed539185c565b54fcbd680d48a427ab',
    bridgeSha256: '4b6359b7a1b4e2a1e776f6eff245aa0233236eea6f724eeb2b2326c14434bf95',
  },
  {
    label: 'seasons-v2',
    templateSha256: '3d8d42d5717360b2f25ac27086dc99a48fb9a172523d9267326fe30ec79a4795',
    argumentSha256: '97357468e1af6a8d1b586030682502e1aec3bb67c268c92efc74a771340986a7',
    bridgeSha256: '3d31341fb8f2c0bfb1e80dd39d5238b97b3c0e00be230cd386dffe9b5a05c163',
  },
  {
    label: 'seasons-v3',
    templateSha256: '9261ca4c99ad269310fa42e4213cc069e9f016058eb0083ad8a306346495a2d1',
    argumentSha256: '0425156ed146bb895ff106a1398160315136c905569429e231660122a1ee48d1',
    bridgeSha256: 'dcc89d34474f108a7be0c6a45113d985576ba9b7eb71a640481fad1293a85ace',
  },
  {
    label: 'seasons-v4',
    templateSha256: '9261ca4c99ad269310fa42e4213cc069e9f016058eb0083ad8a306346495a2d1',
    argumentSha256: '5cc47fbab38e8b3975cebc87250361589d17c67b21302f1b4f66d8abd0ddd4e3',
    bridgeSha256: 'cae00411e81398edf1bc6671110aef6aa9ba1cae2474a2edbc0aa452c9fdf6ef',
  },
  {
    label: 'seasons-v5',
    templateSha256: '9261ca4c99ad269310fa42e4213cc069e9f016058eb0083ad8a306346495a2d1',
    argumentSha256: 'cf34802414eb2bedd0e5ca1ebbc33b7c3930b9a3da835e74945d4a178880987a',
    bridgeSha256: '732702760fe26dfc88dc12ad05db8fff5922a26332ade1eaa0b02465e3dc1de8',
  },
  {
    label: 'seasons',
    templateSha256: '3d8d42d5717360b2f25ac27086dc99a48fb9a172523d9267326fe30ec79a4795',
    argumentSha256: 'bfa973f0d0200f93e88cba759eba699c7408dec2244e889dd6680b52211a87d1',
    bridgeSha256: '4666821c0e213ce2eda186aad42125da66a88582811364cc9379ef78fe70895c',
  },
  {
    label: 'sunburn-v2',
    templateSha256: '3d8d42d5717360b2f25ac27086dc99a48fb9a172523d9267326fe30ec79a4795',
    argumentSha256: 'c3005fbcbdeb25216157c6565fb9043eb093a146d12e1b4982e952f409345722',
    bridgeSha256: '793a721f4318bf835ebc8e7e43cd7c507f01801105df8026da6a48e2e61bf8c9',
  },
  {
    label: 'sunburn-v3',
    templateSha256: 'b3cc663680ab5acaf4ff72c34ce6281a1629a82cfceaa9e2a36f863ec1577929',
    argumentSha256: '82b0841c0f9ce53913908f42441d7aef37f4a10e3fbabbe23af8326e9da79b98',
    bridgeSha256: '543e7be8f9fa6c9fcf43f354e2599dd204280387897d86c5796115cd42f2f038',
  },
  {
    label: 'sunburn-v4',
    templateSha256: '8dd7535e8fabb8b0cbc2f55f3fff622e5931544ac4cfa2bf73907354e11046e7',
    argumentSha256: '36a8adc55d6e46296f4504371b2053338a1843943ba3d136ceaf2030732e6d7a',
    bridgeSha256: 'f7c361187d9a4c98d406f8ff401718beb12dbe936e1fbbee9e167d607ccacddf',
  },
  {
    label: 'sunburn',
    templateSha256: '3d8d42d5717360b2f25ac27086dc99a48fb9a172523d9267326fe30ec79a4795',
    argumentSha256: '7ddacea0ea44b58f22a9fa592404cb2e1b6436f95871a95cd1cf7fc0b5860651',
    bridgeSha256: '8d840250d26e01c0e351c4e9ffe586b2978655ae2d7a963043af0d6ed9574fb7',
  },
  {
    label: 'tides-v2',
    templateSha256: '3d8d42d5717360b2f25ac27086dc99a48fb9a172523d9267326fe30ec79a4795',
    argumentSha256: '30793c57665e6d3475fb563bbbbdae21ceab0929409ae0108f040d8432c6bac3',
    bridgeSha256: 'f6e999606331a8f737d615f6db819594555f40cf60805c822d3f7b247b2bfc38',
  },
  {
    label: 'tides-v3',
    templateSha256: '67ca101dc4328e0b79d89d60d2b410fee2530d52cbbd73106170ec1a5f272233',
    argumentSha256: 'a4e68fad6eae9baa2ec9dee07a6b5f86707ea4db96b0ed3d4d59e47e69e89121',
    bridgeSha256: '37eb2f3a2beaae5a8de91b223e7b3de0b04729e696e31791c1bb8169c1d155ee',
  },
  {
    label: 'tides-v4',
    templateSha256: 'b8e498146644c7b98916ad4cd35c05a91d089cc6e02eec6ed3443259a2598df7',
    argumentSha256: 'b76b327a2d7cd01456fe8647edbf51660bf78c039e58da2c01f11f194c4fd8fb',
    bridgeSha256: 'b38276a9fb0e730d6d7fbc044b81de07079ab7058278194647e48b410ddc439c',
  },
  {
    label: 'tides',
    templateSha256: '3d8d42d5717360b2f25ac27086dc99a48fb9a172523d9267326fe30ec79a4795',
    argumentSha256: '09d31b343645014eba352eb60b6d0c3b4eb7363296a3c8bfd7543e7975bb711d',
    bridgeSha256: 'bb50a7207adf90cc2deac5db01eb328cf9ada646048b4a26b64dc0fb2b65f3c4',
  },
];
