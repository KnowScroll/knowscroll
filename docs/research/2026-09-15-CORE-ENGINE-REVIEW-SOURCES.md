> Research snapshot from 2026-09-15. Findings informed target direction; provider/contract details may drift. Current decisions and pinned boundaries take precedence.

---
status: evidence
authority: review-source-manifest
date: 2026-09-15
---

# Core-engine review: sources and verification

Companion to the [architecture review](2026-09-15-CORE-ENGINE-ARCHITECTURE-REVIEW.md).

## Snapshot and method

- KnowScroll repository: `/Volumes/Mrigesh SSD/Knowscroll-v2`. HEAD: `3e8991ea62ee5f5abb28ec8b9417fe292b961e95`. Working tree was clean before these two additive review files.
- Cutroom: `401f36fa1d80bd309de29a6b9000818dba877f10`, fetched through authenticated GitHub access on 2026-09-15. Contract and five schema files inspected; no engine invocation.
- Primary author read the requested product/core documents, inspected the pinned Cutroom contract/source, researched primary literature, constructed failure cases, and checked arithmetic. Read-only MiniMax-M3 workers supplied an independent critique and supporting-document coverage. Worker conclusions were treated as suggestions and checked against sources.
- Worker tool records were audited for actual read ranges. Two truncated research tails and the build-document tail were completed in a follow-up pass. All 21 core-engine Markdown files and all eight founding Markdown files received complete text reads.
- The two bundled Kiosk/Hybrid pages were additionally decoded at their `__bundler/template` payload. Their complete authored text was inspected; neither decoded template contains inline interaction JavaScript. Their companion text exports were read. Compressed library/font payloads were not treated as architecture sources. Other listed prototype HTML files received full source reads.
- The supplied render sheets were inspected as visual overviews. This was not a browser interaction, responsive-layout, accessibility or deployed-runtime audit. SVG diagram sources were read.
- Historical research extracts were read as historical evidence. External references were followed selectively to primary sources relevant to the review, not recursively through every bibliography, vendor SDK file, or dependency repository. Current capability claims are limited to the sources actually inspected.
- No original specification, accepted decision, code, configuration, or memory file was changed. No user experiment or paid media-generation experiment was performed.

## Coverage and source fingerprints

85 local source files are listed below. “Full text” describes document/source reading, not implemented behavior. SHA-256 values identify the exact bytes inspected.

| Source | Inspection | SHA-256 |
|---|---|---|
| [CLAUDE.md](../../CLAUDE.md) | Project instructions read by primary author | `55e2e54f5e2310f758c89fc21f884c71ad84169624c0174eea0089150caef71f` |
| [apps/api/src/app.ts](../../apps/api/src/app.ts) | Source inspection only; no execution | `431e18251d1d51700b1e0d4d01beff342421ce42ea32a985a40d14fba6669a05` |
| [apps/api/src/system.ts](../../apps/api/src/system.ts) | Source inspection only; no execution | `d8495ff256cbbbbde3153587c7d9ba7842a533c7ecbcfb1156c2c223761c7ef1` |
| [db/PLAN.md](../../db/PLAN.md) | Full text/source | `53bb54c8a1f7b95e4b835ce9fade25029edd5233808ca3fdce8f78339c970945` |
| [docs/design/2026-09-06-living-atlas.html](../design/2026-09-06-living-atlas.html) | Full text/source | `c875480bf5acee44b98164904229cdfc07f6baeb20a705358bdd071641218f46` |
| [docs/design/2026-09-06-zoom-ladder-talk.md](../design/2026-09-06-zoom-ladder-talk.md) | Full text/source | `ea829bdab2f3f2fd925257db99f46495395910479e11e7f040b831107ae31385` |
| [docs/design/2026-09-06-zoom-ladder-wireboard.html](../design/2026-09-06-zoom-ladder-wireboard.html) | Full text/source | `ec99c86dba7b7ef754851336fb34e8f79825c011c764f2a784fe6e3bbbb71845` |
| [docs/design/2026-09-07-voyage.html](../design/2026-09-07-voyage.html) | Full text/source | `a530a6ec8a5e815c5f6d4ba025558ff5ea66cb4b54bf73628a61e8c0c1ae17d1` |
| [docs/design/2026-09-08-cosmos.html](../design/2026-09-08-cosmos.html) | Full text/source | `33af432f01c2310232709408a6b273c8c7b47bb820709ecee487055f1e335f4f` |
| [docs/design/DESIGN_CONTRACT.md](../design/DESIGN_CONTRACT.md) | Full text/source | `1799990ffb554d16e8ec7b4942d7a23682cd588cddee06470a5bc462f70a6496` |
| [docs/design/hybrid-set.render.jpg](../design/hybrid-set.render.jpg) | Visual overview; text cross-checked in template/export | `f0928ab88cb41728b8bbfc2b129ee39b9960e7cd2a3cf0acf66666016ae10a8d` |
| [docs/design/hybrid-set.standalone.html](../design/hybrid-set.standalone.html) | Decoded authored template text + companion text; bundle internals excluded | `ea45a1d148cbb17e84fecdba8122109df5d91d3c529dac570b5189902eb994ba` |
| [docs/design/hybrid-set.text.txt](../design/hybrid-set.text.txt) | Full text/source | `d39e00878db005df24bd9b6c95f29e8cf5becc690983e0f9f8e2b0005410b757` |
| [docs/design/kiosk-set.render.jpg](../design/kiosk-set.render.jpg) | Visual overview; text cross-checked in template/export | `a4d56c8baec1559360452e35af50d67223cc1792c0722595feb0638a73115e17` |
| [docs/design/kiosk-set.standalone.html](../design/kiosk-set.standalone.html) | Decoded authored template text + companion text; bundle internals excluded | `8ea28393d80849eb699d37c90c8b9f882bcea0495f4ee0ed6c2f8ed3875f8816` |
| [docs/design/kiosk-set.text.txt](../design/kiosk-set.text.txt) | Full text/source | `a7e4ed2478ec76091e5ea2c05697e0d065fe20cef94eb333a764be35ad34cab6` |
| [docs/founding/2026-09-08-CORE-ENGINE.md](2026-09-08-CORE-ENGINE.md) | Full text/source | `5252faca3ea7ae641df1f1c7b0752df47f2b7015723d7b066e01877658a58740` |
| [docs/founding/2026-09-08-DECISIONS-AND-EXPERIMENTS.md](2026-09-08-DECISIONS-AND-EXPERIMENTS.md) | Full text/source | `367a87680912639942f890060bee47f34ebe211fc7d58aee9c88c84faeff5273` |
| [docs/founding/2026-09-08-RESEARCH.md](2026-09-08-RESEARCH.md) | Full text/source | `ac5c872d9594e8b357e02a572927f5ca297298ee5a86801a9d6f351db7be77b7` |
| [docs/founding/2026-09-08-VIDEO-ORCHESTRATION.md](2026-09-08-VIDEO-ORCHESTRATION.md) | Full text/source | `cf8ae28a7524da996250431e9226408e509738172ab025435da8d910613ddf5f` |
| [docs/founding/2026-09-08-diagrams/core-engine.svg](2026-09-08-diagrams/core-engine.svg) | Full SVG source | `c8bd524a3e65c12b1579237664b15c4621150a977411b02a78aaf506fcbc1da0` |
| [docs/founding/2026-09-08-diagrams/video-production.svg](2026-09-08-diagrams/video-production.svg) | Full SVG source | `3c85704a47f5bc42c42d235f80ebffee1802c8752c221019540e8644abc6fdf8` |
| [docs/founding/2026-09-08-diagrams/world-evolution.svg](2026-09-08-diagrams/world-evolution.svg) | Full SVG source | `ee7bdce643e472004bc649edc7338f91ecc580b0acd786756842e422248d03d6` |
| [docs/founding/ARCHITECTURE.md](ARCHITECTURE.md) | Full text/source | `1271008bdd4b293522ceeef52c8ef856f77e32ef1434dfcb60fe338790d78a68` |
| [docs/founding/PROMPT_SESSION_00.md](PROMPT_SESSION_00.md) | Full text/source | `3311ffa670b3b9d377aef0bcecd7dba64b3ddb948dd906d4abaf7a552f2eafe2` |
| [docs/founding/README.md](README.md) | Full text/source | `d7e0cd55ba4dde1133ca1770a49441f74b1e1483f4bc1f9e37d99b450ab69968` |
| [docs/founding/RESEARCH.md](RESEARCH.md) | Full text/source | `713c408ded5cfa8522acfc5dabd38689737e31b3ca5f9ecff29498d2259a1130` |
| [docs/founding/core-engine/00-README.md](core-engine/00-README.md) | Full text/source | `83f0646789e9d53e9ebb97023c65482b5cc8e8200e3111c78cdd334e60a4eb08` |
| [docs/founding/core-engine/01-OVERVIEW.md](core-engine/01-OVERVIEW.md) | Full text/source | `d487cc657088393e52aecb34840558de2d6ff955fd173a9809177d36e6c12904` |
| [docs/founding/core-engine/02-RESEARCH-FINDINGS.md](core-engine/02-RESEARCH-FINDINGS.md) | Full text/source | `f90d6fe3575cc38654748ae590612ca096ee78ebfdc590d4ee410828d1cf11be` |
| [docs/founding/core-engine/03-ARCHITECTURE.md](core-engine/03-ARCHITECTURE.md) | Full text/source | `102211bd3b0b9bcde7ff1b038defd2ebfc5f3954248ab3e38603cee1cfd2842f` |
| [docs/founding/core-engine/04-EVENT-ARCHITECTURE.md](core-engine/04-EVENT-ARCHITECTURE.md) | Full text/source | `37db62abfadc496a1292a99993e0a874d187c92168d1e9f676176ea5fd418dbc` |
| [docs/founding/core-engine/05-DATA-STATE-MODEL.md](core-engine/05-DATA-STATE-MODEL.md) | Full text/source | `f3e89b03a38eece8309a15fda05c08f3ba933495dc1801b8914bdd5fbf003265` |
| [docs/founding/core-engine/06-USER-WORLD-MODEL.md](core-engine/06-USER-WORLD-MODEL.md) | Full text/source | `e9cb87ce671982622eb48889379f51b418d57c9257e90da45aab05733d8c9628` |
| [docs/founding/core-engine/07-UNIVERSE-EVOLUTION.md](core-engine/07-UNIVERSE-EVOLUTION.md) | Full text/source | `acfd9701ed3ef910be0b5f3c71a066a12f57d76cc2db49ce7ffe25003a58eff6` |
| [docs/founding/core-engine/08-RECOMMENDATION.md](core-engine/08-RECOMMENDATION.md) | Full text/source | `059cd7b27d103e11517d8399da18d4b5add7786912d7f0badd3eabc028998d05` |
| [docs/founding/core-engine/09-INTERDIMENSIONAL-CABLE.md](core-engine/09-INTERDIMENSIONAL-CABLE.md) | Full text/source | `12c7c1523ef36982ffed95e670b7e56e90c5252ef590bd2540b858eec1330b66` |
| [docs/founding/core-engine/10-CORE-AGENT.md](core-engine/10-CORE-AGENT.md) | Full text/source | `6633e4a152641c594f7f0c79d0966f804dc2e740be82a6fa66fd24d4e4acbf6b` |
| [docs/founding/core-engine/11-IDEA-ROOMS.md](core-engine/11-IDEA-ROOMS.md) | Full text/source | `55b44fcbddd9ec682789705942db450f3f51c465925e73f675ae4f19a3256324` |
| [docs/founding/core-engine/12-PERSISTENT-AGENTS.md](core-engine/12-PERSISTENT-AGENTS.md) | Full text/source | `b4a1e2985428638a28550db2bf9278703be3caf509899412615ef26b1025d2f7` |
| [docs/founding/core-engine/13-SOCIAL-BLEND.md](core-engine/13-SOCIAL-BLEND.md) | Full text/source | `4953c3c1f57ad570b8120139d604996863ba3d5d8c31fb2ff0f0a4c105ea54b3` |
| [docs/founding/core-engine/14-QUALITY-ANTI-SLOP.md](core-engine/14-QUALITY-ANTI-SLOP.md) | Full text/source | `f6e77a34eaa3bc90edd5ae77aa663710660141ae027da384d6a74aca0bae7d8c` |
| [docs/founding/core-engine/15-VIDEO-SDK-INTEGRATION.md](core-engine/15-VIDEO-SDK-INTEGRATION.md) | Full text/source | `8c6cd6a9ff910697dd78212048429f66fe9a596d7334a6eaf168d24fa4c2eafb` |
| [docs/founding/core-engine/16-FEEDBACK-LOOPS.md](core-engine/16-FEEDBACK-LOOPS.md) | Full text/source | `34b90bb861bfaafc255fd15a7057b451c4a90d3ff3af42ee354ee955907fbdbd` |
| [docs/founding/core-engine/17-SCALING-COST.md](core-engine/17-SCALING-COST.md) | Full text/source | `18a3100cf0c9202264cf0e227dbb5dcfea5699650a23cf8abbb3018b4dc46467` |
| [docs/founding/core-engine/18-IMPLEMENTATION-PHASES.md](core-engine/18-IMPLEMENTATION-PHASES.md) | Full text/source | `1ee193ef9a6369b0d41b3096f0991028b6fa7ade967da535b57574494d957364` |
| [docs/founding/core-engine/19-OPEN-QUESTIONS.md](core-engine/19-OPEN-QUESTIONS.md) | Full text/source | `34e99c9f03d0feb523f818935b4f42d7441c4a4800b00d0caa2517b2b04b94f3` |
| [docs/founding/core-engine/20-WORKED-TRACES.md](core-engine/20-WORKED-TRACES.md) | Full text/source | `06564c725a5b7d3a2b56b7f765fe64d8aa8c7c5d7ef53d47db9e51d255515cc2` |
| [docs/founding/video-harness/00-TALK.md](video-harness/00-TALK.md) | Full text/source | `78e2e4f75d1ec3d506b5e31aca15d963312f10730097702fb05f176c0de9b332` |
| [docs/founding/video-harness/01-WHAT-IT-IS.md](video-harness/01-WHAT-IT-IS.md) | Full text/source | `00dc7bfd03b7ff9b00608fe39893b8a1210c75ced70a8472ecdf46da806ba21d` |
| [docs/founding/video-harness/02-THE-CUT.md](video-harness/02-THE-CUT.md) | Full text/source | `8e8eca5d79161e66646e903ec134ef757d55698ea0a565d33a9c8df98be3d9c2` |
| [docs/founding/video-harness/03-HOW-IT-WORKS.md](video-harness/03-HOW-IT-WORKS.md) | Full text/source | `46b09eda8b0b5a7f83032197a44d441776afe0ebdc9d2c956b0b53e5183f6898` |
| [docs/founding/video-harness/04-FAST.md](video-harness/04-FAST.md) | Full text/source | `416d8b0fc9643eaae0b4a12801b6820d19728d7351b4fa1fd4985c5429aa127d` |
| [docs/founding/video-harness/05-PROVIDERS-AND-ENGINES.md](video-harness/05-PROVIDERS-AND-ENGINES.md) | Full text/source | `c21203f081d3def6bc66bf67982c84a956327076401ddbe1f3189b098979bfc3` |
| [docs/founding/video-harness/06-SDK-CLI-KNOWSCROLL.md](video-harness/06-SDK-CLI-KNOWSCROLL.md) | Full text/source | `decc05ea556934ec171e43e1b2eaa01667c053dfe5ab8f5591012dd7a0093dc0` |
| [docs/founding/video-harness/07-BUILD.md](video-harness/07-BUILD.md) | Full text/source | `cb6a386d4234a5ec691e4836117d89a32da7dd459932d3fa06a40ac8d918ccbd` |
| [docs/founding/video-harness/CUTROOM-EXPLAINER.html](video-harness/CUTROOM-EXPLAINER.html) | Full text/source | `a427fbc29a9b62bd247dd3058a244ab9a0a782af5391ed1cf81dde39f22e21b9` |
| [docs/founding/video-harness/README.md](video-harness/README.md) | Full text/source | `e076d61f4fc903cbfe6b72efc92a0fa3b4113c43282e3d5fbcfca0c5ebd679b5` |
| [docs/founding/video-harness/research/00-synthesis.md](video-harness/research/00-synthesis.md) | Full text/source | `15054a9422429503ebb4b01950ef90c551c3320be2d96c8b8420cc834e5432bb` |
| [docs/founding/video-harness/research/01-agent-harnesses.md](video-harness/research/01-agent-harnesses.md) | Full text/source | `39e2bde7313fd65e08faa63c143a88950b78fc4d80ffbfc53cf065fc368c8b18` |
| [docs/founding/video-harness/research/02-video-representations-and-editors.md](video-harness/research/02-video-representations-and-editors.md) | Full text/source | `555616d66efd06cc11c04739ec911f517b7b90ff7ae666a495dda68f63c5c33a` |
| [docs/founding/video-harness/research/03-agentic-video-generation-continuity-eval.md](video-harness/research/03-agentic-video-generation-continuity-eval.md) | Full text/source | `9109806d2c526ee40d71599b05207faccf0acf054662e61126392fe8da7dd4e4` |
| [docs/research/KnowScroll-risks.md](../research/KnowScroll-risks.md) | Full text/source | `f818b613bd0efef50444c254aed7b47105a8f482253144be8221a6464ab95505` |
| [docs/research/building-blocks.md](../research/building-blocks.md) | Full text/source | `ea631900abc9f625ee47f3093e72ae94f015030abbfa74d1b49677d1f7b16e33` |
| [docs/research/extracts/building-blocks.md](../research/extracts/building-blocks.md) | Full text/source | `dd49ea9f2e689143c22f8babf45fd0c49de6ab7775977f36e99c3ae017d5cacd` |
| [docs/research/extracts/harness-sdks.md](../research/extracts/harness-sdks.md) | Full text/source | `78ab83ebc45b7540676fe2606955548965c0ad10e4518b842ff2e3ac6e0c0a03` |
| [docs/research/extracts/minimax-h3.md](../research/extracts/minimax-h3.md) | Full text/source | `d67fa44efecff7fa12ef9c0870e6f197b883756aa0c3616889958c2309888476` |
| [docs/research/extracts/steering-systems.md](../research/extracts/steering-systems.md) | Full text/source | `5bcd9509a5cf2afacbdebbd50a72642c16ecd4bf869572e480f6ad2a8a3f086f` |
| [docs/research/harness-sdks.md](../research/harness-sdks.md) | Full text/source | `127d3c5471cea8058d59fa2377333900fa8c88a235aa2cae0d2bc46eeaa76bc6` |
| [docs/research/minimax-h3.md](../research/minimax-h3.md) | Full text/source | `243c71cf04e97e1e76a739f51e8bb5896ec4262f9fba15ed0d0f5ed121bd26d7` |
| [docs/research/steering-systems.md](../research/steering-systems.md) | Full text/source | `8857a0d4cedcec96f8e7e8290cb293ba681f74e556288ee0f69b5293e862f45b` |
| [packages/contracts/src/jobs.ts](../../packages/contracts/src/jobs.ts) | Source inspection only; no execution | `e6317bbf0ed26085ff72e1ab4d39ecb8c285c098c31d21054c6e09cf1c773f00` |
| [steering/BUDGET.md](../../steering/BUDGET.md) | Full text/source | `b22cfa8b373c452e7d0aa45f611ea191da9b6c00001f2ca37075a15e8b58bbe2` |
| [steering/DECISIONS.md](../../steering/DECISIONS.md) | Full text/source | `4dad54e761b6c1618aef0230fd7f5d7d62e97084bc8cd0053b48efe64a8b0f9b` |
| [steering/JOURNAL.md](../../steering/JOURNAL.md) | Full text/source | `5d15a8cf683bc03e66a21838e9c572539fc90dcb3198c699aad33b3432e66dc5` |
| [steering/QUESTIONS.md](../../steering/QUESTIONS.md) | Full text/source | `9dbf80ff45ae005fc23d5762c5180e5625d9aa265a81eda37eab98b666d8e73d` |
| [steering/STATE.md](../../steering/STATE.md) | Full text/source | `b3d62521bf014dc5f9f555d783d4f10c318e21cc3d3ae63418dd6d10f0b3d17a` |
| [steering/SYSTEM.md](../../steering/SYSTEM.md) | Full text/source | `41c737fb9eee932c6f59aa6815a265f73ad990ce40792ca59732949273d51046` |
| [steering/features/system-runtime-abi.md](../../steering/features/system-runtime-abi.md) | Full text/source | `097a65997eea955f5a3435d290d0dd5b6ad61eb01bd12b89add7bf0a7acf5b4a` |
| [steering/features/system-runtime-facts.md](../../steering/features/system-runtime-facts.md) | Full text/source | `58cec03edcc4a3381e1301f780c8ddb2fecdea5377b6ff9a244d7559747fa310` |
| [steering/features/system-truth.md](../../steering/features/system-truth.md) | Full text/source | `847c7b0b53f69f6a01e576dd8577eac532415778e667c6b06651d593f5423ad8` |
| [steering/features/truth-node-engine.md](../../steering/features/truth-node-engine.md) | Full text/source | `b086ae0faef86a0d6178e99fecfb70e5e37c00eb34db0b309a1bc8dd75a8470f` |
| [steering/features/validation-gate.md](../../steering/features/validation-gate.md) | Full text/source | `4c2177831580b95fc8f60822f078bf1e5f6495427b5332b1c72be1874c6a43fa` |
| [steering/handoffs/2026-09-03-system-runtime-facts.md](../../steering/handoffs/2026-09-03-system-runtime-facts.md) | Full text/source | `37df9668d7da25bc40cfe59b053c1a30699b68cc49f21a7a7b9171f09b6196f6` |
| [steering/handoffs/2026-09-03-validation-gate.md](../../steering/handoffs/2026-09-03-validation-gate.md) | Full text/source | `0efb9558a2ddbd21f561eaad9ca7387da96e69ef0100f361dbb7fb05b9148f6d` |

## Pinned Cutroom inputs

| Source at pinned commit | SHA-256 |
|---|---|
| [docs/features/reel-contract.md](https://github.com/KnowScroll/Cutroom/blob/401f36fa1d80bd309de29a6b9000818dba877f10/docs/features/reel-contract.md) | `374197542a54f38394a29f33ba9d6cf011232f61f298f5b1736c578a0ce0b8a8` |
| [packages/reel-contract/src/request.ts](https://github.com/KnowScroll/Cutroom/blob/401f36fa1d80bd309de29a6b9000818dba877f10/packages/reel-contract/src/request.ts) | `82150483be29bbbdbef5560b3a8c9f8f5a32b320ae03c3bf99e4bd48dc346b02` |
| [packages/reel-contract/src/responses.ts](https://github.com/KnowScroll/Cutroom/blob/401f36fa1d80bd309de29a6b9000818dba877f10/packages/reel-contract/src/responses.ts) | `f10820f9992aadf3392ef83a36a77897869049442ac2a9e0276d27ff3a6128a7` |
| [packages/reel-contract/src/events.ts](https://github.com/KnowScroll/Cutroom/blob/401f36fa1d80bd309de29a6b9000818dba877f10/packages/reel-contract/src/events.ts) | `f04fe6a515cc9d2fcf358f74fae86d019c89a3c60dcd128ecbbb1b27e6a35527` |
| [packages/reel-contract/src/record.ts](https://github.com/KnowScroll/Cutroom/blob/401f36fa1d80bd309de29a6b9000818dba877f10/packages/reel-contract/src/record.ts) | `04cafb52da57154198fdc2aef26b0da3846e128682414415b36439914a5cfa01` |
| [packages/reel-contract/src/version.ts](https://github.com/KnowScroll/Cutroom/blob/401f36fa1d80bd309de29a6b9000818dba877f10/packages/reel-contract/src/version.ts) | `2315bf14736f6c7809bfb9267adc3f10969eefe2659d24907874c9e1bc76455a` |

## Reference resolution and limits

- Core index `../../steering/DECISIONS.md` resolves incorrectly from its folder; the intended existing file at repository-root `steering/DECISIONS.md` was read. Bare STATE, DECISIONS, BUDGET and QUESTIONS references were resolved to `steering/`.
- `docs/UX.md` is explicitly described in the founding prompt as deleted. The current design contract and supplied design sets were used instead.
- References to future `docs/design/ADDITIONS.md`, `docs/research/model-benchmark.md`, `docs/RUNBOOK.md`, `docs/system/CURRENT_SYSTEM.md` and `docs/system/MIGRATIONS.md` do not identify present files in this checkout. They were treated as planned deliverables, not as unseen evidence.
- The older `knowscroll-atlas.html` named in the founding prompt is absent. The existing Living Atlas, Voyage, Cosmos and wireboard prototypes were inspected. A proof-bundle `owner.md` is a requested future verdict, not evidence that a user accepted the current design.
- The MiniMax-H3 repository prompt-template path and vendor source trees mentioned inside historical research are secondary references in this review. No claim is made that every external repository file or linked literature item was reread. Historical provider prices, quotas and latency were not adopted as current facts.
- Recorded STATE, feature statuses and proof narratives establish what the repository reports. They do not establish today’s running process, actual deployment, model reliability or user outcomes.

## Checks performed

- Confirmed all 18 requested top-level sections in order, all eleven named subsystems, A–E traces, a concrete contract diff, latency/cost analysis, migration and v0.1 scope.
- Checked internal document links, code-fence balance and JSON example parsing. Mermaid diagrams were inspected as source; no claim of browser-rendered diagram QA.
- Independently calculated: passive daily mass `0.5 / (1 - 2**(-1/21)) = 15.3997`; initial mass 4 falls below 1 just after day 42, then requires 30 days below the threshold; `30*60*365 = 657000` playback events/year at 1 Hz.
- Checked event-scale scenario: `1e6*500/86400 = 5787.04` average events/second, `1e6*500*1000 = 500 GB/day` decimal before overhead.
- Checked C17 row sum `409000` tokens/day, rounded `410000`; `410000*1e6 = 410 billion` tokens/day. Cost scenarios are assumptions, not provider invoices.
- Constructed the offered-only day-by-day counterexample and quota-feasibility counterexample directly from the documented rules. They are logical stress tests, not runs of an implemented engine.

## Delegated reading records

These are `pio`-reported worker totals, including cache-read tokens. Costs are runner-reported and cover these reading jobs only; they are not the cost of this entire review or a forecast for KnowScroll. All four runs completed with exit code 0.

| Run | Role | tokens.total | tokens.cost_usd |
|---|---|---:|---:|
| `20260915-071122-read-only-independent-kn-1eba` | Independent architecture critique | 203863 | 0.029571 |
| `20260915-071515-bounded-read-only-source-e92b` | Supporting research and diagrams | 241184 | 0.022327 |
| `20260915-073314-read-only-completion-pas-9cf0` | Read-tail and prototype completion | 253458 | 0.019792 |
| `20260915-073636-final-bounded-read-only-b06c` | Research extracts and recorded implementation context | 71413 | 0.010052 |

Review artifact SHA-256: `4b8989a68a350523501625844825158c75f29c02688b65991f643b3fb351c912`.


## 2026-09-15 extension: runtime and global execution

The [runtime and shared-execution review](2026-09-15-RUNTIME-AND-GLOBAL-EXECUTION-REVIEW.md) adds all 23 requested sections. The original architecture review received only a dated extension notice; its preceding analysis remains intact. The artifact hash recorded above identifies the earlier snapshot, not the notice-extended file.

- Pre-notice architecture-review SHA-256: `4b8989a68a350523501625844825158c75f29c02688b65991f643b3fb351c912`.
- Notice-extended architecture-review SHA-256: `1031baecfd00e7423b5692c50280844f322ecb6f493d0228ebe2a86d6b06ae22`.
- Runtime-review SHA-256: `ac875221efade7d6eb14a4d9ebdede259bd29a278804d8ba74bd09ca7848f9c4`.
- KnowScroll source HEAD remains `3e8991ea62ee5f5abb28ec8b9417fe292b961e95`; accepted decisions, product authority and application source were not modified.
- Pi inspected at `8a7b0c03dfb702663acafb6dc29f8acaa4ffe391`; Prime Agent at `ad426c672327696c42d641379840212ca5a8b85b`; Codex at `2fdcdeaf0e219eea34c710e01de2ee0571ddeeb5`. Source paths and primary URLs are in the extension.
- Cutroom refreshed to `d57e0921a662a0ce976faa1b7ba190820ff11529`; `reel-contract.md` Git blob `667f88547fa458580e52548eb6d6a7310d5548d8` is unchanged from the prior pin. Return-time model receipts and image/video-only planning estimates were checked in the newer source. No live engine execution was performed.
- Two research workers completed with exit code 0. Their runner-reported totals were 131,083 tokens / $0.009506 and 157,369 tokens / $0.010835. These include cache-read tokens and do not represent total review cost.
- Worker claims were checked against source. The final review specifically corrects unproven all-call interception through a main-loop wrapper, daemon-as-durability claims, and forced-tool support inferred from MiniMax overview wording.
- Validation: all 23 sections present and ordered; local Markdown links resolve; code fences balanced; capacity and cost arithmetic recalculated. Mermaid source was structurally inspected, not rendered. TypeScript examples are interface sketches, not compiled implementation. No paid application-provider compatibility tests were run.

### Fresh MiniMax documentation snapshots

Direct official Markdown responses fetched on 2026-09-15 supplied M3 details that some search-indexed HTML excerpts omitted. These digests identify the retrieved page bodies; they are not claims about account access or measured provider behavior. The current URLs are listed in the extension.

| Official documentation path | Retrieved body SHA-256 |
|---|---|
| `guides/models-intro.md` | `647190c20bafd9febb4ad61b5b1846b764ea755e573b5c66ab6229199242fa6a` |
| `api-reference/text-anthropic-api.md` | `a9da220235a4be025ef085a14c0ba6a65d29e905274abd4bf15099722b3bcad0` |
| `api-reference/text-chat-anthropic.md` | `0397ec721bb275084ecf1b7cf80afbb3688b7e1c81912746377c215b12e0f6ca` |
| `api-reference/text-openai-api.md` | `843901ed9bb23eaf3cbedff886db9b37cb0838e360dd6c8375cd11a92005c41c` |
| `api-reference/text-chat-openai.md` | `5a59281c6171f6356e1bf5214a176623dfb52b6faaf69e31a65edd172712dffd` |
| `api-reference/responses-create.md` | `5f73dbcde25e7fc193bd3cea664b902bac1c98529e06c2839a2e78f51b0a6267` |
| `guides/text-m3-function-call.md` | `2ede82cab383c5ba63842b88714f37757dece431263a81d8b0adcd9e26602a95` |
| `guides/rate-limits.md` | `b3c8a8d8f2907bacd70bcc53ae9eb20848f15072c5c2c7f35ba240f150d10caa` |
| `guides/pricing-paygo.md` | `13c3fcdbb08f22333055e0b358633a68ae1928b609f80d815adf736486e5f0ea` |
| `api-reference/text-prompt-caching.md` | `13cb8a9fbae285e14b40e791eb3f2c31b254224b75be489941a4a2d58e64ee21` |
| `api-reference/anthropic-api-compatible-cache.md` | `db34d83255b626d173acc0e8ba2dec8b5db65871a45857246850e44475b6c8e5` |
| `api-reference/text-ai-sdk.md` | `05662054745236b52a73a1c78936fad065790027f34834f1b752e3f7e482430a` |
| `api-reference/errorcode.md` | `14d5229b65d49e69e8ed9dd983083557df8b5eaedd288b27fe679f4678dda578` |
