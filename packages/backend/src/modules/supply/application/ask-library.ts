import type { ContentRef, ReadLibraryPassages } from '../../content/public.js';
import type { ReasoningHarness } from '../../../reasoning/public.js';
import {
  ASK_LIBRARY_POLICY_VERSION,
  MAX_LIBRARY_CHOICES,
  askLibraryContext,
  askLibraryRole,
  libraryChoice,
  libraryVerdict,
  type LibraryChoice,
  type LibraryVerdict,
} from './ask-library-role.js';
import { catalogueBrief, inventory } from './inventory.js';
import type { CatalogueMatch } from './match-role.js';
import type { SupplyPorts } from './ports.js';

/** The run of the library check for one question, derived from the request: a redelivery asks the ledger, never pays twice. */
export const askLibraryRunId = (p: Pick<SupplyPorts, 'idFor'>, requestId: string): string =>
  p.idFor(`supply.ask-library:${requestId}`);

type Authority = Parameters<SupplyPorts['withScope']>[0];

/** What a library check needs: the ports, the personal harness and the shared read of a library Scroll's prose. */
export interface AskLibraryDeps {
  readonly p: SupplyPorts;
  readonly harness: ReasoningHarness;
  readonly readLibrary: ReadLibraryPassages;
}

/**
 * The library Scrolls on the matched subject that could answer a question, read in a short transaction of their own
 * under the same rules as the final decision (the Scroll being read is skipped, and each Scroll must still be admitted).
 */
async function candidatesOf(
  deps: AskLibraryDeps,
  authority: Authority,
  requestId: string,
  match: CatalogueMatch,
): Promise<readonly { readonly ref: ContentRef; readonly title: string }[]> {
  const { p } = deps;
  const read = await p.withScope(authority, async (scope) => {
    if (!(await p.ownerActive(scope))) return [];
    const d = await p.store.read(scope, requestId);
    if (d?.status !== 'matching') return [];
    const { servable } = await inventory(p, scope, d.command, catalogueBrief(d.command, match, 'scroll'));
    return servable.slice(0, MAX_LIBRARY_CHOICES).flatMap((head) =>
      head.encounter === undefined
        ? []
        : [
            {
              ref: { assetId: head.encounter.assetId, assetRevision: head.encounter.assetRevision },
              title: head.encounter.metadata.title,
            },
          ],
    );
  });
  return read.kind === 'entered' ? read.value : [];
}

/** The candidates with their prose, read from shared content outside every transaction. A Scroll with no prose is not offered. */
async function choicesOf(
  deps: AskLibraryDeps,
  match: CatalogueMatch,
  candidates: readonly { readonly ref: ContentRef; readonly title: string }[],
): Promise<readonly LibraryChoice[]> {
  const choices: LibraryChoice[] = [];
  for (const candidate of candidates) {
    const [source] = await deps.readLibrary({ kind: 'planet', id: match.topicId }, 1, candidate.ref);
    if (source !== undefined && source.blocks.length > 0)
      choices.push(
        libraryChoice(
          choices.length,
          candidate.ref,
          candidate.title,
          source.blocks.map((block) => block.text),
        ),
      );
  }
  return choices;
}

/**
 * Decides whether a library Scroll answers a question asked from a Scroll (D-251): the checker reads the question
 * against the text of each candidate on the matched subject (at most three) and offers one only with the words of it
 * that answer, which code finds in the text. A Scroll about the same subject that does not answer is not offered.
 * No candidate is no offer, without a model call.
 *
 * Authority: a `system` actor for the job's universe and epoch, rechecked in the candidate transaction; the verdict is
 * applied in the caller's transaction, which reads the candidates again. No model call and no read of shared prose
 * runs inside a transaction. Failure/retry: the run is derived from the request, so a redelivery answers from the
 * ledger and never pays twice; an attempt of unknown outcome is never resent.
 */
export async function checkLibraryMatch(
  deps: AskLibraryDeps,
  authority: Authority,
  input: { readonly requestId: string; readonly question: string; readonly match: CatalogueMatch },
  signal: AbortSignal,
): Promise<LibraryVerdict> {
  const candidates = await candidatesOf(deps, authority, input.requestId, input.match);
  const choices = await choicesOf(deps, input.match, candidates);
  if (choices.length === 0) return { kind: 'none' };
  const outcome = await deps.harness.propose(
    {
      run: {
        id: askLibraryRunId(deps.p, input.requestId),
        authority,
        ownerModule: 'supply',
        purpose: 'ask-library',
        policyVersion: ASK_LIBRARY_POLICY_VERSION,
      },
      role: askLibraryRole(choices),
      context: askLibraryContext(input.requestId, input.question, choices),
      limits: { allowRepair: true },
    },
    signal,
  );
  return libraryVerdict(outcome, choices);
}
