import type { AccountScope } from '@knowscroll/client-core';
import type { OperatorEvidencePanel as OperatorEvidencePanelComponent } from './operator-evidence-panel';

/**
 * The dev evidence panel exists only in builds made with `EXPO_PUBLIC_KS_DEV_EVIDENCE=1`, exactly
 * like the developer gallery: production builds inline the variable, so the condition is constant
 * and Metro drops the branch together with its `require`. The panel's code is not in a production
 * export (the client CI job checks the exported bundle), and the consumer UI never shows evidence,
 * scores or operational state (blueprint §26).
 */
const Panel: typeof OperatorEvidencePanelComponent | null =
  process.env.EXPO_PUBLIC_KS_DEV_EVIDENCE === '1'
    ? // eslint-disable-next-line @typescript-eslint/no-require-imports -- a conditional require is what lets the bundler drop the panel from production builds
      (require('./operator-evidence-panel') as { OperatorEvidencePanel: typeof OperatorEvidencePanelComponent })
        .OperatorEvidencePanel
    : null;

export function EvidencePanel(props: { readonly scope: AccountScope; readonly exposureId: string }) {
  return Panel === null ? null : <Panel {...props} />;
}
