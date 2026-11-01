import type { Interactive } from '../model';
import { ForkBody } from './fork';
import { BlockFrame, useTextVersion } from './frame';
import { ChartBody } from './growing-chart';
import { ScaleBody } from './scale';
import { SortBody } from './sort';

export { GuideView } from './guide';

/** What each play block is called to the reader, and to a screen reader when it names the block's text switch. */
const NAMES: Readonly<Record<Interactive['type'], { readonly name: string; readonly label: string }>> = {
  sort: { name: 'Sort it', label: 'sort' },
  fork: { name: 'Fork', label: 'fork' },
  scale: { name: 'To scale', label: 'scale' },
  chart: { name: 'Growing chart', label: 'chart' },
};

/**
 * The play block of a read stop (D-207): a sort, a fork, a scale or a growing chart, each drawn from its
 * own data and each with a text version. It is played on the device and reports nothing: no event, no
 * kind and no store carries what the reader chose, ordered or revealed (D-063, D-209).
 * `readerAsText` is the reader's "Text version" (the T key); the block's own switch overrides it.
 */
export function PlayBlockView({
  interactive,
  readerAsText,
}: {
  readonly interactive: Interactive;
  readonly readerAsText: boolean;
}) {
  const { asText, toggle } = useTextVersion(readerAsText);
  const { name, label } = NAMES[interactive.type];
  return (
    <BlockFrame name={name} label={label} asText={asText} onToggleText={toggle} testID={`play-${interactive.type}`}>
      {interactive.type === 'sort' ? (
        <SortBody sort={interactive} asText={asText} />
      ) : interactive.type === 'fork' ? (
        <ForkBody fork={interactive} asText={asText} />
      ) : interactive.type === 'scale' ? (
        <ScaleBody scale={interactive} asText={asText} />
      ) : (
        <ChartBody chart={interactive} asText={asText} />
      )}
    </BlockFrame>
  );
}
