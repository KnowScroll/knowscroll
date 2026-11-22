import { ReviewScrollScreen } from '../../../../features/operator-review/review-scroll-screen';

/** `/operator/review/<assetId>/<revision>`: one held Scroll, read as a reader sees it, to release or reject (#780). */
export default function OperatorReviewScroll() {
  return <ReviewScrollScreen />;
}
