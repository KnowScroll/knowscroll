import { SubPage } from '../privacy/privacy-screen';
import { SharedLinksSection } from './shared-links-section';

/** `/account/privacy/shared-links`: the links panel on a page of its own, back to the Privacy hub. */
export function SharedLinksScreen() {
  return (
    <SubPage title="Shared links">
      <SharedLinksSection titled={false} />
    </SubPage>
  );
}
