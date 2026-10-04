export class InquiryError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
    this.name = 'InquiryError';
  }
}
export type InquiryRoute = {
  policy_version: string;
  route_id: string;
  route_profile_version: string;
  transport: 'fixture' | 'minimax';
  model: string;
  max_input_tokens: number;
  max_output_tokens: number;
  global_bucket_id: string;
  provider_account_bucket_id: string;
  route_quota_bucket_id: string;
  remote_concurrency_bucket_id: string;
  owner_capacity: string;
  job_capacity: string;
  coalescing_delay_seconds: number;
  job_ttl_seconds: number;
  enabled: boolean;
  thinking: 'disabled' | 'adaptive';
  max_continuation_steps: number;
  max_children: number;
};
export type InquiryRow = {
  id: string;
  universe_id: string;
  privacy_epoch: number;
  kind: string;
  status: string;
  first_mail_at: Date;
  policy_version: string | null;
  job_id: string | null;
  step_id: string | null;
  context_id: string | null;
  request_id: string | null;
  job_bucket_id: string | null;
  through_sequence: string | null;
  pairs:
    | { a: { code: string; name: string }; b: { code: string; name: string } }[]
    | null;
  opened_at: Date | null;
  request_hash: string | null;
  input_bytes: number | null;
  attempt_id: string | null;
  proposal_id: string | null;
  reasons: string[];
  closed_at: Date | null;
  role: 'single' | 'parent' | 'child';
  parent_id: string | null;
  sent: boolean | null;
};
