export {
  apiProblem,
  apiKeepPlaceProblem,
  createApiClient,
  resolveApiOrigin,
  type ApiClient,
  type ApiClientOptions,
  type ApiOrigin,
  type ApiOriginOptions,
} from './api-client';
export { createQueryClient, queryRetryDelay, shouldRetryQuery } from './query-client';
export { healthQueryKey, healthQueryOptions } from './health';
export {
  SCOPED_STORAGE_PREFIX,
  ScopeEndedError,
  createAccountScope,
  fencedFetch,
  memoryStore,
  purgeStorage,
  scopeIdOf,
  type AccountScope,
  type AccountScopeOptions,
  type ConnectScope,
  type KeyValueStore,
  type ScopeConnection,
  type ScopedStorage,
} from './account-scope';
export {
  createAccountScopeManager,
  type AccountScopeManager,
  type AccountScopeManagerOptions,
  type AccountScopeState,
  type SessionTokenStore,
  type SignInBinding,
} from './account-scope-manager';
export { connectScopeSocket, type SocketContext } from './account-scope-socket';
export {
  createAuthClient,
  type AuthClient,
  type AuthClientOptions,
  type PeekOutcome,
  type RedeemOutcome,
  type RequestLinkOutcome,
  type SessionOutcome,
} from './auth-client';
export { base64UrlOfBase64, base64UrlOfBytes } from './sign-in-binding';
export {
  OUTBOX_STORAGE_KEY,
  RECORDER_INSTRUMENTATION_VERSION,
  ReadingTracker,
  createObservationOutbox,
  createScrollRecorder,
  createReelRecorder,
  type PlaybackSample,
  type ReelRecorder,
  type ReelRecorderOptions,
  deliverBatch,
  outboxRetryDelay,
  scopeOutbox,
  type InteractionKind,
  type Interval,
  type ObservationOutbox,
  type ObservationOutboxOptions,
  type OutboxStatus,
  type OutboxStorage,
  type OutboxTimers,
  type ReadingObserver,
  type ReadingReport,
  type RecordedExposure,
  type RecorderClock,
  type RecorderTimers,
  type ScrollRecorder,
  type ScrollRecorderOptions,
  type SendOutcome,
} from './recorder';
export {
  createScopedBlockStateStore,
  type EarlierBlockState,
  type ScrollBlockKey,
  type ScrollBlockStateStore,
} from './scroll-state';
export {
  createUniverseSceneSession,
  UNIVERSE_SCENE_LIMITS,
  type UniverseGeography,
  type UniverseSceneSnapshot,
  type UniverseSceneReason,
  type UniverseSceneState,
  type UniverseSceneSession,
} from './universe-scene';

export {
  createKeepPlaceSession,
  KEEP_PLACE_LIMITS,
  type KeepPlaceState,
  type KeepPlaceHandle,
  type KeepPlaceSession,
} from './keep-place';

export { PRIVACY_CLEAR_ACKNOWLEDGEMENT, type PrivacyClearState, type PrivacyClearSession } from './privacy-clear';
