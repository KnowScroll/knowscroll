import { SubPage } from '../privacy/privacy-screen';
import { VisibilitySection } from './visibility-section';

/** `/account/privacy/visibility`: the sharing panel on a page of its own, back to the Privacy hub. */
export function VisibilityScreen() {
  return (
    <SubPage title="Who can visit your universe">
      <VisibilitySection titled={false} />
    </SubPage>
  );
}
