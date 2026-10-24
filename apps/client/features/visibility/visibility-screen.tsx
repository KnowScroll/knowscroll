import { SubPage } from '../privacy/privacy-screen';
import { VisibilitySection } from './visibility-section';

/** `/account/privacy/visibility`: the sharing panel on a page of its own, back to the Privacy hub. */
export function VisibilityScreen() {
  return (
    <SubPage title="Sharing & visibility">
      <VisibilitySection titled={false} />
    </SubPage>
  );
}
