import { RedeemScreen } from '../../features/auth/redeem-screen';

/** Where a sign-in link lands: `/redeem#token=…` (D-018). Not under `/auth`, which is the API's (D-008). */
export default function Redeem() {
  return <RedeemScreen />;
}
