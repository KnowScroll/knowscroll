export class AskAnswerError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
    this.name = 'AskAnswerError';
  }
}
export type Route = {
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
  answer_ttl_seconds: number;
  enabled: boolean;
};
export type RequestRow = {
  id: string;
  ask_id: string;
  universe_id: string;
  privacy_epoch: number;
  session_id: string;
  client_request_id: string;
  policy_version: string;
  job_id: string;
  step_id: string;
  context_id: string;
  request_id: string;
  request_hash: string | null;
  input_bytes: number | null;
  job_bucket_id: string;
  requested_at: Date;
};
