import { z } from 'zod';
import {
  ConfigurationError,
  PortSchema,
  PostgresUrlSchema,
  WorldSchema,
  checkEnvironment,
  combineChecks,
  positiveInteger,
  type Checked,
  type Environment,
} from './environment.js';
import { OPERATOR_WORLDS, operatorAddressMatcher } from '../../modules/identity/public.js';
import { checkReleaseIdentity, type ReleaseIdentity } from './release.js';

/** Connection settings for one process's PostgreSQL pool. `url` is a credential: never log it. */
export interface DatabaseSettings {
  readonly url: string;
  readonly applicationName: string;
  readonly poolMax: number;
  readonly statementTimeoutMs: number;
}

/**
 * How the API resolves an authenticated caller. `session` (the default and the only production
 * adapter): the identity module's sessions, from the web cookie or a native bearer token (S1.3).
 * `test-bearer`: a CI fixture that trusts `Bearer test.<accountId>`; refused unless
 * `NODE_ENV=test` and `KS_WORLD` is `ci` or `local`.
 */
export type AuthAdapter = 'session' | 'test-bearer';

/**
 * How sign-in mail is sent. `agentmail` (the default; production accepts nothing else): one
 * request to AgentMail per link (`AGENTMAIL_API_KEY` and `AGENTMAIL_INBOX_ID` are credentials:
 * never log them). `fixture`: a CI fixture that records each mail (to `KS_FIXTURE_MAIL_FILE` when
 * set); refused unless `NODE_ENV=test` and `KS_WORLD` is `ci` or `local`.
 */
export type MailSettings =
  | {
      readonly sender: 'agentmail';
      readonly apiKey: string;
      readonly inboxId: string;
      readonly baseUrl: string;
      readonly timeoutMs: number;
    }
  | { readonly sender: 'fixture'; readonly outboxFile: string | undefined };

/** Sign-in settings of the API (D-007, D-022). */
export interface IdentitySettings {
  /** The world's own origin (`KS_PUBLIC_ORIGIN`): links point here and browser requests must come from it. */
  readonly publicOrigin: string;
  /** HTTPS origin: the session cookie is `__Host-` prefixed and Secure. */
  readonly secureCookies: boolean;
  readonly mail: MailSettings;
  /**
   * `KS_ALLOW_OPERATOR_SIGN_IN=1` in an allow-listed world (dev, stage, ci, local) with a
   * disposable-address pattern (`KS_OPERATOR_SIGN_IN_PATTERN`): operator-minted links may be
   * redeemed here, for addresses the pattern matches only. `undefined` everywhere else.
   */
  readonly operatorSignIn: { readonly pattern: string } | undefined;
  /**
   * `KS_NATIVE_SIGN_IN_BINDING=1`: native apps may bind their links with a code challenge.
   * Off by default on every world until the native app ships (re-review N1): while off, a
   * request carrying a challenge is refused (422).
   */
  readonly nativeSignInBinding: boolean;
}

/** The real AgentMail API; a different base URL is accepted only outside production (tests). */
export const AGENTMAIL_BASE_URL = 'https://api.agentmail.to';

/** The live world. Operator sign-in is refused there, as in every world outside `OPERATOR_WORLDS`. */
export const LIVE_WORLD = 'live';

/** The only worlds in which test-only adapters may run. */
export const TEST_ADAPTER_WORLDS: readonly string[] = ['ci', 'local'];

export interface ApiConfig extends ReleaseIdentity {
  readonly mediaRoot?: string;
  readonly database: DatabaseSettings;
  readonly listen: { readonly host: string; readonly port: number };
  readonly bodyLimitBytes: number;
  readonly shutdownGraceMs: number;
  /** Personal-scope lock wait; always shorter than the statement timeout. */
  readonly scopeLockTimeoutMs: number;
  readonly authAdapter: AuthAdapter;
  /** How long a socket subscription's authorisation may be reused before it is rechecked. */
  readonly socketAuthorisationCacheMs: number;
  readonly identity: IdentitySettings;
  /**
   * Addresses (or one-`*` patterns) whose accounts may use the operator routes and the Operator
   * screen (`KS_OPERATOR_ACCOUNTS`, D-044). Empty means nobody can.
   */
  readonly operatorAccounts: readonly string[];
  /** Shared Scroll productions that people's requests may start per UTC day; 0 turns Create off. */
  readonly supplyCreateDailyCap: number;
  /** Productions the Planner's demand may start per UTC day; never above `supplyCreateDailyCap`. */
  readonly supplyPlannerCreateDailyCap: number;
  /** Branches of threads Quartermaster may order per UTC day (D-049); 0 turns scenario Create off. */
  readonly supplyScenarioDailyCap: number;
  /** Branches one thread may have ordered over its life. */
  readonly supplyScenarioThreadCap: number;
  /**
   * `KS_REASONING_ROOM_ENABLED`: residents may speak unprompted (D-162). The API schedules their checks only when it
   * is on, so a world that leaves it off queues nothing. The worker reads the same variable.
   */
  readonly roomResidentsEnabled: boolean;
  /** `KS_ROOMS_STARS_PER_DAY`: the most stars one room earns on a UTC day (D-174); three unless a world raises it. */
  readonly roomStarsPerDay: number;
  /** `KS_COMPOSER_POLICY`: the policy navigation ranks new decisions under (D-190). */
  readonly composerPolicy: 'v0' | 'v1';
}

/** The operator sign-in command (`dist/operator.js`), refused unless enabled outside live. */
export interface OperatorConfig {
  readonly world: string;
  readonly database: DatabaseSettings;
  readonly publicOrigin: string;
  readonly scopeLockTimeoutMs: number;
  /** The disposable-address pattern operator links may be issued for. */
  readonly pattern: string;
}

/**
 * The content operator command's configuration (`dist/operator.js content import-editorial`): the
 * world (an allow-listed one) and its database. Nothing about sign-in: admitting shared content
 * touches no person's data.
 */
export interface ContentOperatorConfig {
  readonly world: string;
  readonly database: DatabaseSettings;
}

export interface WorkerConfig extends ReleaseIdentity {
  /** Planner execution gate; default off until a separately approved role allowance. */
  readonly plannerEnabled: boolean;
  readonly cartographerEnabled: boolean;
  /** Jev's optional semantic assessment in the Composer buffer job; default off, on for dev. */
  readonly jevEnabled: boolean;
  /** `KS_COMPOSER_POLICY`: the policy the buffer job ranks new decisions under (D-190); default `v0`. */
  readonly composerPolicy: 'v0' | 'v1';
  /** Shared Scroll productions that people's requests may start per UTC day; 0 turns Create off. */
  readonly supplyCreateDailyCap: number;
  /** Productions the Planner's demand may start per UTC day; never above `supplyCreateDailyCap`. */
  readonly supplyPlannerCreateDailyCap: number;
  /** The production scope generation the `content.produce-scroll` consumer works under. */
  readonly scrollProductionGeneration: number;
  readonly database: DatabaseSettings;
  readonly shutdownGraceMs: number;
  /** Personal-scope lock wait; always shorter than the statement timeout. */
  readonly scopeLockTimeoutMs: number;
  /** The reasoning harness: provider, budgets and protected request limits (S2.2). */
  readonly reasoning: ReasoningSettings;
}

/** Text models the MiniMax token-plan key serves (`MiniMax-M3.1-Flash-Preview` is not one). */
export const MINIMAX_MODELS = ['MiniMax-M3.1-Flash', 'MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed'] as const;

/** Daily caps of one budget dimension. */
export interface ReasoningCap {
  readonly requestsPerDay: number;
  readonly tokensPerDay: number;
}

/**
 * Reasoning harness settings (worker only). `provider: none` (the default) means no role can
 * propose: every call is refused before anything is reserved. `minimax.apiKey` is a credential:
 * pass it only to the MiniMax adapter, never to a log.
 */
export interface ReasoningSettings {
  readonly provider: 'none' | 'minimax';
  /** Worker-only nonpersonal production grant; root enabled/generation are checked separately. */
  readonly productionEnabled: boolean;
  /**
   * Residents may speak unprompted (D-162): the rooms scope's switch. Off by default; the `rooms` root in the
   * database (`reasoning.production_scopes`) must be enabled at `roomGeneration` too.
   */
  readonly roomEnabled: boolean;
  /** The generation of the `rooms` root this worker's resident jobs run under. */
  readonly roomGeneration: number;
  readonly minimax?: {
    readonly apiKey: string;
    readonly model: (typeof MINIMAX_MODELS)[number];
    readonly requestTimeoutMs: number;
    readonly quotaFloorPercent: number;
  };
  readonly caps: {
    readonly global: ReasoningCap;
    /** Per personal scope (one person's universe). */
    readonly scope: ReasoningCap;
    /** The nonpersonal production scope (`scroll-supply`), which seeds and extends the library. */
    readonly productionScope: ReasoningCap;
    /** The nonpersonal rooms scope (`rooms`), which pays for residents speaking on their own (D-162). */
    readonly roomScope: ReasoningCap;
    readonly roleDefault: ReasoningCap;
  };
  /**
   * Whole percent (0 to 100) of the global cap and of each person's cap that background roles
   * (Jev, Cartographer, Planner) may use together; the rest is kept for roles a person asks for.
   */
  readonly backgroundSharePercent: number;
  /**
   * Whole percent (0 to 100) of the global cap that ambient roles (a room's residents speaking on their own)
   * may use together; the rest is kept for roles a person asks for.
   */
  readonly ambientSharePercent: number;
  readonly maxRequestBytes: number;
  readonly requestRetentionSeconds: number;
}

/**
 * The worker operator command's configuration (`dist/operator.js` in the worker release tree: the
 * reasoning write-off). Distinct from {@link OperatorConfig}, the API tree's operator sign-in command.
 */
export interface WorkerOperatorConfig {
  readonly world: string;
  readonly database: DatabaseSettings;
}

export interface MigrateConfig {
  readonly world: string;
  readonly database: DatabaseSettings;
}

/**
 * `KS_SUPPLY_CREATE_DAILY_CAP`: how many shared Scroll productions Quartermaster's Create may start
 * per UTC day (each is one writer call and at most one repair). 0 turns Create off, so a request for
 * missing supply closes honestly. Default 20 in `local`, 0 in every other world (D-037).
 */
const supplyCreateCapVariable = z.coerce.number().int().min(0).max(500).optional();

function supplyCreateDailyCap(configured: number | undefined, world: string): number {
  return configured ?? (world === 'local' ? 20 : 0);
}

/**
 * `KS_SUPPLY_PLANNER_CREATE_DAILY_CAP`: the productions the Planner's own demand may start per UTC day.
 * It is counted apart from people's asks, so the Planner cannot use up what a person's explicit ask
 * needs, and it is never above the cap for people: switching Create off switches it off too. Default 5.
 */
const supplyPlannerCapVariable = z.coerce.number().int().min(0).max(500).default(5);

/**
 * `KS_SUPPLY_SCENARIO_DAILY_CAP`: how many branches of content threads (a what-if or another perspective,
 * each one writer call and at most one repair) Quartermaster may order per UTC day. It is counted apart
 * from every other Create cap. 0 turns scenario Create off. Default 20 in `local`, 0 in every other
 * world (D-049).
 */
const supplyScenarioDailyCapVariable = z.coerce.number().int().min(0).max(500).optional();
/** `KS_SUPPLY_SCENARIO_THREAD_CAP`: the branches one thread may have ordered in all. Default 6. */
const supplyScenarioThreadCapVariable = z.coerce.number().int().min(1).max(100).default(6);
/**
 * `KS_COMPOSER_POLICY`: the Composer policy new decisions are made under (D-190). `v0` until the numbers of v1 are
 * chosen. Replay of a stored decision does not read it: a decision names its own policy.
 */
const composerPolicyVariable = z.enum(['v0', 'v1']).default('v0');

const databaseVariables = {
  DATABASE_URL: PostgresUrlSchema,
  KS_DB_STATEMENT_TIMEOUT_MS: positiveInteger(15_000, 600_000),
};

function databaseSettings(
  parsed: { DATABASE_URL: string; KS_DB_STATEMENT_TIMEOUT_MS: number },
  applicationName: string,
  poolMax: number,
): DatabaseSettings {
  return {
    url: parsed.DATABASE_URL,
    applicationName,
    poolMax,
    statementTimeoutMs: parsed.KS_DB_STATEMENT_TIMEOUT_MS,
  };
}

/**
 * Cross-variable rules, checked after each variable is valid on its own: the lock wait must end
 * before the statement timeout (so a lock wait is reported as retryable busy, not as a cancelled
 * statement), and a test-only adapter needs `NODE_ENV=test` in a CI or local world.
 */
function crossChecks(rules: readonly (readonly [boolean, string])[]): void {
  const problems = rules.filter(([violated]) => violated).map(([, problem]) => problem);
  if (problems.length > 0) throw new ConfigurationError(problems);
}

/**
 * API process configuration. Variables: `DATABASE_URL`, `PORT`, `KS_LISTEN_HOST` (default
 * `127.0.0.1`), `KS_DB_POOL_MAX` (default 10), `KS_DB_STATEMENT_TIMEOUT_MS` (default 15000),
 * `KS_BODY_LIMIT_BYTES` (default 65536), `KS_SHUTDOWN_GRACE_SECONDS` (default 20),
 * `KS_SCOPE_LOCK_TIMEOUT_MS` (default 5000, below the statement timeout), `KS_AUTH_ADAPTER`
 * (default `session`; `test-bearer` only with `NODE_ENV=test` and `KS_WORLD` `ci` or `local`),
 * `KS_SOCKET_AUTH_CACHE_MS` (default 30000, at most 30000), the sign-in variables of
 * {@link checkIdentitySettings}, plus the release identity variables of
 * {@link checkReleaseIdentity}. Throws one `ConfigurationError` listing every problem.
 */
export function readApiConfig(env: Environment): ApiConfig {
  const processCheck = checkEnvironment(
    z.object({
      ...databaseVariables,
      PORT: PortSchema,
      KS_MEDIA_ROOT: z.string().regex(/^\//).optional(),
      KS_LISTEN_HOST: z.string().min(1).default('127.0.0.1'),
      KS_DB_POOL_MAX: positiveInteger(10, 100),
      KS_BODY_LIMIT_BYTES: positiveInteger(65_536, 10 * 1024 * 1024),
      KS_SHUTDOWN_GRACE_SECONDS: positiveInteger(20, 300),
      KS_SCOPE_LOCK_TIMEOUT_MS: positiveInteger(5_000, 60_000),
      KS_AUTH_ADAPTER: z.enum(['session', 'test-bearer']).default('session'),
      KS_SOCKET_AUTH_CACHE_MS: z.coerce.number().int().min(0).max(30_000).default(30_000),
      KS_SUPPLY_CREATE_DAILY_CAP: supplyCreateCapVariable,
      KS_SUPPLY_PLANNER_CREATE_DAILY_CAP: supplyPlannerCapVariable,
      KS_SUPPLY_SCENARIO_DAILY_CAP: supplyScenarioDailyCapVariable,
      KS_SUPPLY_SCENARIO_THREAD_CAP: supplyScenarioThreadCapVariable,
      KS_REASONING_ROOM_ENABLED: z.enum(['0', '1']).default('0'),
      KS_ROOMS_STARS_PER_DAY: positiveInteger(3, 50),
      KS_COMPOSER_POLICY: composerPolicyVariable,
    }),
    pick(env, [
      'DATABASE_URL',
      'KS_DB_STATEMENT_TIMEOUT_MS',
      'PORT',
      'KS_MEDIA_ROOT',
      'KS_LISTEN_HOST',
      'KS_DB_POOL_MAX',
      'KS_BODY_LIMIT_BYTES',
      'KS_SHUTDOWN_GRACE_SECONDS',
      'KS_SCOPE_LOCK_TIMEOUT_MS',
      'KS_AUTH_ADAPTER',
      'KS_SOCKET_AUTH_CACHE_MS',
      'KS_SUPPLY_CREATE_DAILY_CAP',
      'KS_SUPPLY_PLANNER_CREATE_DAILY_CAP',
      'KS_SUPPLY_SCENARIO_DAILY_CAP',
      'KS_SUPPLY_SCENARIO_THREAD_CAP',
      'KS_REASONING_ROOM_ENABLED',
      'KS_ROOMS_STARS_PER_DAY',
      'KS_COMPOSER_POLICY',
    ]),
  );
  const [release, parsed, identity, operatorAccounts] = combineChecks(
    checkReleaseIdentity(env),
    processCheck,
    checkIdentitySettings(
      env,
      { nodeEnv: env['NODE_ENV'] ?? 'development', world: env['KS_WORLD'] ?? '' },
      processCheck.ok ? processCheck.value.PORT : 0,
    ),
    checkOperatorAccounts(env, env['KS_WORLD'] ?? ''),
  );
  crossChecks([
    [
      parsed.KS_SCOPE_LOCK_TIMEOUT_MS >= parsed.KS_DB_STATEMENT_TIMEOUT_MS,
      'KS_SCOPE_LOCK_TIMEOUT_MS: must_be_below_statement_timeout',
    ],
    [parsed.KS_AUTH_ADAPTER === 'test-bearer' && release.nodeEnv !== 'test', 'KS_AUTH_ADAPTER: refused_outside_test'],
    [
      parsed.KS_AUTH_ADAPTER === 'test-bearer' && !TEST_ADAPTER_WORLDS.includes(release.world),
      'KS_AUTH_ADAPTER: refused_in_this_world',
    ],
  ]);
  return {
    ...release,
    database: databaseSettings(parsed, `knowscroll-api-${release.world}`, parsed.KS_DB_POOL_MAX),
    listen: { host: parsed.KS_LISTEN_HOST, port: parsed.PORT },
    bodyLimitBytes: parsed.KS_BODY_LIMIT_BYTES,
    shutdownGraceMs: parsed.KS_SHUTDOWN_GRACE_SECONDS * 1000,
    scopeLockTimeoutMs: parsed.KS_SCOPE_LOCK_TIMEOUT_MS,
    authAdapter: parsed.KS_AUTH_ADAPTER,
    socketAuthorisationCacheMs: parsed.KS_SOCKET_AUTH_CACHE_MS,
    identity,
    operatorAccounts,
    supplyCreateDailyCap: supplyCreateDailyCap(parsed.KS_SUPPLY_CREATE_DAILY_CAP, release.world),
    supplyPlannerCreateDailyCap: parsed.KS_SUPPLY_PLANNER_CREATE_DAILY_CAP,
    supplyScenarioDailyCap: supplyCreateDailyCap(parsed.KS_SUPPLY_SCENARIO_DAILY_CAP, release.world),
    supplyScenarioThreadCap: parsed.KS_SUPPLY_SCENARIO_THREAD_CAP,
    roomResidentsEnabled: parsed.KS_REASONING_ROOM_ENABLED === '1',
    roomStarsPerDay: parsed.KS_ROOMS_STARS_PER_DAY,
    composerPolicy: parsed.KS_COMPOSER_POLICY,
    ...(parsed.KS_MEDIA_ROOT === undefined ? {} : { mediaRoot: parsed.KS_MEDIA_ROOT }),
  };
}

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * `KS_PUBLIC_ORIGIN`: a bare `http(s)://host[:port]` origin. Production requires HTTPS, except on a
 * loopback host (the release smoke test runs the production build on 127.0.0.1); elsewhere it
 * defaults to `http://127.0.0.1:<PORT>`.
 */
function checkPublicOrigin(
  value: string | undefined,
  nodeEnv: string,
  port: number,
): { readonly origin?: string; readonly problem?: string } {
  if (value === undefined || value === '') {
    return nodeEnv === 'production'
      ? { problem: 'KS_PUBLIC_ORIGIN: missing_or_wrong_type' }
      : { origin: `http://127.0.0.1:${port}` };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { problem: 'KS_PUBLIC_ORIGIN: invalid_format' };
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value.replace(/\/$/, ''))
    return { problem: 'KS_PUBLIC_ORIGIN: invalid_format' };
  if (nodeEnv === 'production' && url.protocol !== 'https:' && !loopbackHosts.has(url.hostname))
    return { problem: 'KS_PUBLIC_ORIGIN: https_required' };
  return { origin: url.origin };
}

/**
 * The API's sign-in variables (D-007, D-022), checked together so every problem is reported:
 * - `KS_PUBLIC_ORIGIN` (see {@link checkPublicOrigin});
 * - `KS_MAIL_SENDER` (default `agentmail`): `agentmail` needs `AGENTMAIL_API_KEY` and
 *   `AGENTMAIL_INBOX_ID` (credentials), takes `AGENTMAIL_TIMEOUT_MS` (default 10000, at most
 *   30000) and, outside production only, `AGENTMAIL_BASE_URL`; `fixture` (with an optional
 *   `KS_FIXTURE_MAIL_FILE`) is refused unless `NODE_ENV=test` in a `ci` or `local` world;
 * - `KS_ALLOW_OPERATOR_SIGN_IN`: unset, or exactly `1`, and then only in an allow-listed world
 *   (`dev`, `stage`, `ci`, `local`) with a valid `KS_OPERATOR_SIGN_IN_PATTERN`;
 * - `KS_NATIVE_SIGN_IN_BINDING`: unset (off) or exactly `1`.
 * Production therefore cannot start without AgentMail fully configured.
 */
function checkIdentitySettings(
  env: Environment,
  release: { readonly nodeEnv: string; readonly world: string },
  port: number,
): Checked<IdentitySettings> {
  const problems: string[] = [];
  const origin = checkPublicOrigin(env['KS_PUBLIC_ORIGIN'], release.nodeEnv, port);
  if (origin.problem !== undefined) problems.push(origin.problem);
  const sender = env['KS_MAIL_SENDER'] ?? 'agentmail';
  let mail: MailSettings | undefined;
  if (sender === 'agentmail') {
    const parsed = checkEnvironment(
      z.object({
        AGENTMAIL_API_KEY: z.string().min(1),
        AGENTMAIL_INBOX_ID: z.string().min(1).max(320),
        AGENTMAIL_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
        AGENTMAIL_TIMEOUT_MS: positiveInteger(10_000, 30_000),
      }),
      pick(env, ['AGENTMAIL_API_KEY', 'AGENTMAIL_INBOX_ID', 'AGENTMAIL_BASE_URL', 'AGENTMAIL_TIMEOUT_MS']),
    );
    if (!parsed.ok) problems.push(...parsed.problems);
    else if (parsed.value.AGENTMAIL_BASE_URL !== undefined && release.nodeEnv === 'production')
      problems.push('AGENTMAIL_BASE_URL: refused_in_production');
    else
      mail = {
        sender: 'agentmail',
        apiKey: parsed.value.AGENTMAIL_API_KEY,
        inboxId: parsed.value.AGENTMAIL_INBOX_ID,
        baseUrl: (parsed.value.AGENTMAIL_BASE_URL ?? AGENTMAIL_BASE_URL).replace(/\/+$/, ''),
        timeoutMs: parsed.value.AGENTMAIL_TIMEOUT_MS,
      };
  } else if (sender === 'fixture') {
    if (release.nodeEnv !== 'test') problems.push('KS_MAIL_SENDER: refused_outside_test');
    else if (!TEST_ADAPTER_WORLDS.includes(release.world)) problems.push('KS_MAIL_SENDER: refused_in_this_world');
    else mail = { sender: 'fixture', outboxFile: env['KS_FIXTURE_MAIL_FILE'] || undefined };
  } else {
    problems.push('KS_MAIL_SENDER: not_allowed');
  }
  const operator = checkOperatorSignIn(env, release.world);
  problems.push(...operator.problems);
  const binding = env['KS_NATIVE_SIGN_IN_BINDING'];
  if (binding !== undefined && binding !== '' && binding !== '1')
    problems.push('KS_NATIVE_SIGN_IN_BINDING: not_allowed');
  if (problems.length > 0 || origin.origin === undefined || mail === undefined)
    return { ok: false, problems: problems.length > 0 ? problems : ['KS_PUBLIC_ORIGIN: invalid_format'] };
  return {
    ok: true,
    value: {
      publicOrigin: origin.origin,
      secureCookies: origin.origin.startsWith('https:'),
      mail,
      operatorSignIn: operator.pattern === undefined ? undefined : { pattern: operator.pattern },
      nativeSignInBinding: binding === '1',
    },
  };
}

const MAX_OPERATOR_ACCOUNTS = 20;

/**
 * Who may use the operator routes (`KS_OPERATOR_ACCOUNTS`, D-044): a comma-separated list of
 * addresses, each in the grammar of `KS_OPERATOR_SIGN_IN_PATTERN` (one address, at most one `*` in
 * the local part, lower case). A pattern with `*` is accepted only in `OPERATOR_WORLDS`; live takes
 * exact addresses only. Unset: on `dev` with operator sign-in enabled, the sign-in pattern (every
 * disposable test account may look); everywhere else nobody.
 */
function checkOperatorAccounts(env: Environment, world: string): Checked<readonly string[]> {
  const configured = env['KS_OPERATOR_ACCOUNTS'];
  if (configured === undefined || configured === '') {
    const pattern = env['KS_OPERATOR_SIGN_IN_PATTERN'];
    const signInOnDev = world === 'dev' && env['KS_ALLOW_OPERATOR_SIGN_IN'] === '1' && pattern;
    return { ok: true, value: signInOnDev ? [signInOnDev] : [] };
  }
  const entries = configured.split(',').map((entry) => entry.trim());
  if (entries.length > MAX_OPERATOR_ACCOUNTS || entries.some((entry) => operatorAddressMatcher(entry) === undefined))
    return { ok: false, problems: ['KS_OPERATOR_ACCOUNTS: invalid_format'] };
  if (entries.some((entry) => entry.includes('*')) && !OPERATOR_WORLDS.includes(world))
    return { ok: false, problems: ['KS_OPERATOR_ACCOUNTS: wildcard_refused_in_this_world'] };
  return { ok: true, value: entries };
}

/**
 * The operator sign-in switch (D-007, review m2/m3): `KS_ALLOW_OPERATOR_SIGN_IN` is unset or
 * exactly `1`; `1` is accepted only in an allow-listed world (`OPERATOR_WORLDS`: dev, stage, ci,
 * local; never live or any other name) and only with `KS_OPERATOR_SIGN_IN_PATTERN`, a
 * disposable-address pattern such as `*@test.knowscroll.space` (one `*` in the local part, a
 * literal domain).
 */
function checkOperatorSignIn(
  env: Environment,
  world: string,
): { readonly pattern?: string; readonly problems: readonly string[] } {
  const flag = env['KS_ALLOW_OPERATOR_SIGN_IN'];
  if (flag === undefined || flag === '') return { problems: [] };
  if (flag !== '1') return { problems: ['KS_ALLOW_OPERATOR_SIGN_IN: not_allowed'] };
  const problems: string[] = [];
  if (!OPERATOR_WORLDS.includes(world)) problems.push('KS_ALLOW_OPERATOR_SIGN_IN: refused_in_this_world');
  const pattern = env['KS_OPERATOR_SIGN_IN_PATTERN'];
  if (pattern === undefined || pattern === '') problems.push('KS_OPERATOR_SIGN_IN_PATTERN: missing_or_wrong_type');
  else if (operatorAddressMatcher(pattern) === undefined) problems.push('KS_OPERATOR_SIGN_IN_PATTERN: invalid_format');
  return problems.length > 0 || pattern === undefined ? { problems } : { pattern, problems };
}

/**
 * The operator sign-in command's configuration (`dist/operator.js`, D-007): `KS_WORLD`,
 * `DATABASE_URL`, `KS_PUBLIC_ORIGIN` (as for the API; required), `KS_DB_STATEMENT_TIMEOUT_MS`,
 * `KS_SCOPE_LOCK_TIMEOUT_MS`, `KS_ALLOW_OPERATOR_SIGN_IN` (exactly `1`) and
 * `KS_OPERATOR_SIGN_IN_PATTERN`. Refused in every world outside `OPERATOR_WORLDS` (live
 * included, whatever it is called). Throws one `ConfigurationError` listing every problem.
 */
export function readOperatorConfig(env: Environment): OperatorConfig {
  const [parsed] = combineChecks(
    checkEnvironment(
      z.object({
        KS_WORLD: WorldSchema,
        ...databaseVariables,
        KS_SCOPE_LOCK_TIMEOUT_MS: positiveInteger(5_000, 60_000),
      }),
      pick(env, ['KS_WORLD', 'DATABASE_URL', 'KS_DB_STATEMENT_TIMEOUT_MS', 'KS_SCOPE_LOCK_TIMEOUT_MS']),
    ),
  );
  const origin = checkPublicOrigin(env['KS_PUBLIC_ORIGIN'] ?? '', 'production', 0);
  const operator = checkOperatorSignIn(env, parsed.KS_WORLD);
  crossChecks([
    [!OPERATOR_WORLDS.includes(parsed.KS_WORLD), 'KS_WORLD: operator_sign_in_refused_in_this_world'],
    [env['KS_ALLOW_OPERATOR_SIGN_IN'] !== '1', 'KS_ALLOW_OPERATOR_SIGN_IN: not_enabled'],
    ...operator.problems
      .filter((problem) => !problem.startsWith('KS_ALLOW_OPERATOR_SIGN_IN'))
      .map((problem) => [true, problem] as const),
    [origin.problem !== undefined, origin.problem ?? ''],
    [
      parsed.KS_SCOPE_LOCK_TIMEOUT_MS >= parsed.KS_DB_STATEMENT_TIMEOUT_MS,
      'KS_SCOPE_LOCK_TIMEOUT_MS: must_be_below_statement_timeout',
    ],
  ]);
  return {
    world: parsed.KS_WORLD,
    database: databaseSettings(parsed, `knowscroll-operator-${parsed.KS_WORLD}`, 2),
    publicOrigin: origin.origin ?? '',
    scopeLockTimeoutMs: parsed.KS_SCOPE_LOCK_TIMEOUT_MS,
    pattern: operator.pattern ?? '',
  };
}

/**
 * The largest request timeout the model transport accepts (`KS_MINIMAX_REQUEST_TIMEOUT_MS`). A job that
 * chains requests must outlast this many of them, so its queue derives its claim time from it.
 */
export const MINIMAX_REQUEST_TIMEOUT_MAX_MS = 300_000;

const reasoningVariables = z.object({
  KS_REASONING_PRODUCTION_ENABLED: z.enum(['0', '1']).default('0'),
  KS_REASONING_ROOM_ENABLED: z.enum(['0', '1']).default('0'),
  KS_REASONING_ROOM_GENERATION: positiveInteger(1, 2_147_483_647),
  KS_REASONING_PROVIDER: z.enum(['none', 'minimax']).default('none'),
  MINIMAX_API_KEY: z.string().optional(),
  KS_MINIMAX_MODEL: z.enum(MINIMAX_MODELS).default('MiniMax-M3.1-Flash'),
  // A reasoning model thinks before it answers: Scroll writer requests took up to 126 s, so a shorter
  // default would turn a healthy attempt into `unknown` (never resent) after the request left.
  KS_MINIMAX_REQUEST_TIMEOUT_MS: positiveInteger(240_000, MINIMAX_REQUEST_TIMEOUT_MAX_MS),
  // At least 1: a floor of 0 would switch the quota check off.
  KS_MINIMAX_QUOTA_FLOOR_PERCENT: z.coerce.number().int().min(1).max(100).default(25),
  KS_REASONING_GLOBAL_REQUESTS_PER_DAY: positiveInteger(300, 1_000_000),
  KS_REASONING_GLOBAL_TOKENS_PER_DAY: positiveInteger(3_000_000, 1_000_000_000),
  KS_REASONING_SCOPE_REQUESTS_PER_DAY: positiveInteger(60, 1_000_000),
  KS_REASONING_SCOPE_TOKENS_PER_DAY: positiveInteger(600_000, 1_000_000_000),
  // The production scope writes the whole library (about 70 writer requests, 1.4M tokens) and every
  // Create job after it, so it has its own, larger cap. The global and role caps still bound it.
  KS_REASONING_PRODUCTION_REQUESTS_PER_DAY: positiveInteger(200, 1_000_000),
  KS_REASONING_PRODUCTION_TOKENS_PER_DAY: positiveInteger(3_000_000, 1_000_000_000),
  // The rooms scope pays for residents answering on their own. Its own caps keep a busy room from reaching the
  // whole world's allowance; the global, role and ambient-share caps still bound it.
  KS_REASONING_ROOM_REQUESTS_PER_DAY: positiveInteger(100, 1_000_000),
  KS_REASONING_ROOM_TOKENS_PER_DAY: positiveInteger(1_000_000, 1_000_000_000),
  KS_REASONING_ROLE_REQUESTS_PER_DAY: positiveInteger(200, 1_000_000),
  KS_REASONING_ROLE_TOKENS_PER_DAY: positiveInteger(2_000_000, 1_000_000_000),
  // Background roles run because a person read or swiped, so they stop at half of the global and the
  // personal caps and the other half is always there for what the person asks for. 0 switches them
  // off; 100 keeps nothing back.
  KS_REASONING_BACKGROUND_SHARE_PERCENT: z.coerce.number().int().min(0).max(100).default(50),
  // Ambient roles (residents speaking on their own) stop at this share of the global cap, so the rest is always
  // there for what a person asks for. 0 switches them off; 100 keeps nothing back.
  KS_REASONING_AMBIENT_SHARE_PERCENT: z.coerce.number().int().min(0).max(100).default(30),
  KS_REASONING_MAX_REQUEST_BYTES: positiveInteger(262_144, 262_144),
  KS_REASONING_REQUEST_RETENTION_HOURS: positiveInteger(48, 720),
});

/**
 * Reasoning variables of the worker (blueprint §15; providers-and-secrets.md). `MINIMAX_API_KEY`
 * is required, and must be a token-plan key (`sk-cp-…`), only when `KS_REASONING_PROVIDER` is
 * `minimax`; it is never echoed in a problem.
 */
function reasoningSettings(parsed: z.infer<typeof reasoningVariables>): ReasoningSettings {
  const key = parsed.MINIMAX_API_KEY;
  crossChecks([
    [
      parsed.KS_REASONING_PROVIDER === 'minimax' && (key === undefined || key === ''),
      'MINIMAX_API_KEY: missing_or_wrong_type',
    ],
    [
      parsed.KS_REASONING_PROVIDER === 'minimax' &&
        key !== undefined &&
        key !== '' &&
        !/^sk-cp-[A-Za-z0-9_-]{16,}$/.test(key),
      'MINIMAX_API_KEY: invalid_format',
    ],
  ]);
  return {
    provider: parsed.KS_REASONING_PROVIDER,
    productionEnabled: parsed.KS_REASONING_PRODUCTION_ENABLED === '1',
    roomEnabled: parsed.KS_REASONING_ROOM_ENABLED === '1',
    roomGeneration: parsed.KS_REASONING_ROOM_GENERATION,
    ...(parsed.KS_REASONING_PROVIDER === 'minimax' && key !== undefined
      ? {
          minimax: {
            apiKey: key,
            model: parsed.KS_MINIMAX_MODEL,
            requestTimeoutMs: parsed.KS_MINIMAX_REQUEST_TIMEOUT_MS,
            quotaFloorPercent: parsed.KS_MINIMAX_QUOTA_FLOOR_PERCENT,
          },
        }
      : {}),
    caps: {
      global: {
        requestsPerDay: parsed.KS_REASONING_GLOBAL_REQUESTS_PER_DAY,
        tokensPerDay: parsed.KS_REASONING_GLOBAL_TOKENS_PER_DAY,
      },
      scope: {
        requestsPerDay: parsed.KS_REASONING_SCOPE_REQUESTS_PER_DAY,
        tokensPerDay: parsed.KS_REASONING_SCOPE_TOKENS_PER_DAY,
      },
      productionScope: {
        requestsPerDay: parsed.KS_REASONING_PRODUCTION_REQUESTS_PER_DAY,
        tokensPerDay: parsed.KS_REASONING_PRODUCTION_TOKENS_PER_DAY,
      },
      roomScope: {
        requestsPerDay: parsed.KS_REASONING_ROOM_REQUESTS_PER_DAY,
        tokensPerDay: parsed.KS_REASONING_ROOM_TOKENS_PER_DAY,
      },
      roleDefault: {
        requestsPerDay: parsed.KS_REASONING_ROLE_REQUESTS_PER_DAY,
        tokensPerDay: parsed.KS_REASONING_ROLE_TOKENS_PER_DAY,
      },
    },
    backgroundSharePercent: parsed.KS_REASONING_BACKGROUND_SHARE_PERCENT,
    ambientSharePercent: parsed.KS_REASONING_AMBIENT_SHARE_PERCENT,
    maxRequestBytes: parsed.KS_REASONING_MAX_REQUEST_BYTES,
    requestRetentionSeconds: parsed.KS_REASONING_REQUEST_RETENTION_HOURS * 3600,
  };
}

/**
 * The content operator command's configuration (`dist/operator.js content import-editorial`, D-005):
 * `KS_WORLD`, `DATABASE_URL` and `KS_DB_STATEMENT_TIMEOUT_MS`. Refused in every world outside
 * `OPERATOR_WORLDS` (dev, stage, ci, local: live included, whatever it is called), like the
 * operator sign-in command. Throws one `ConfigurationError` listing every problem.
 */
export function readContentOperatorConfig(env: Environment): ContentOperatorConfig {
  const [parsed] = combineChecks(
    checkEnvironment(
      z.object({ KS_WORLD: WorldSchema, ...databaseVariables }),
      pick(env, ['KS_WORLD', 'DATABASE_URL', 'KS_DB_STATEMENT_TIMEOUT_MS']),
    ),
  );
  crossChecks([[!OPERATOR_WORLDS.includes(parsed.KS_WORLD), 'KS_WORLD: operator_command_refused_in_this_world']]);
  return {
    world: parsed.KS_WORLD,
    database: databaseSettings(parsed, `knowscroll-operator-content-${parsed.KS_WORLD}`, 2),
  };
}

/**
 * Worker process configuration. Variables: `DATABASE_URL`, `KS_DB_POOL_MAX` (default 5),
 * `KS_DB_STATEMENT_TIMEOUT_MS`, `KS_SHUTDOWN_GRACE_SECONDS` (default 20),
 * `KS_SCOPE_LOCK_TIMEOUT_MS` (default 5000, below the statement timeout), the reasoning variables
 * of `reasoningVariables` (`KS_REASONING_PROVIDER` default `none`; `MINIMAX_API_KEY` only with
 * `minimax`; caps, model, timeouts and protected-request limits with defaults), plus the release
 * identity variables. Throws one `ConfigurationError` listing every problem.
 */
export function readWorkerConfig(env: Environment): WorkerConfig {
  const [release, parsed, reasoning] = combineChecks(
    checkReleaseIdentity(env),
    checkEnvironment(
      z.object({
        ...databaseVariables,
        KS_PLANNER_ENABLED: z.enum(['0', '1']).optional(),
        KS_CARTOGRAPHER_ENABLED: z.enum(['0', '1']).default('0'),
        KS_JEV_ENABLED: z.enum(['0', '1']).default('0'),
        KS_COMPOSER_POLICY: composerPolicyVariable,
        KS_SUPPLY_CREATE_DAILY_CAP: supplyCreateCapVariable,
        KS_SUPPLY_PLANNER_CREATE_DAILY_CAP: supplyPlannerCapVariable,
        KS_SCROLL_PRODUCTION_GENERATION: positiveInteger(1, 2_147_483_647),
        KS_DB_POOL_MAX: positiveInteger(5, 100),
        KS_SHUTDOWN_GRACE_SECONDS: positiveInteger(20, 300),
        KS_SCOPE_LOCK_TIMEOUT_MS: positiveInteger(5_000, 60_000),
      }),
      pick(env, [
        'KS_PLANNER_ENABLED',
        'KS_CARTOGRAPHER_ENABLED',
        'KS_JEV_ENABLED',
        'KS_COMPOSER_POLICY',
        'KS_SUPPLY_CREATE_DAILY_CAP',
        'KS_SUPPLY_PLANNER_CREATE_DAILY_CAP',
        'KS_SCROLL_PRODUCTION_GENERATION',
        'DATABASE_URL',
        'KS_DB_STATEMENT_TIMEOUT_MS',
        'KS_DB_POOL_MAX',
        'KS_SHUTDOWN_GRACE_SECONDS',
        'KS_SCOPE_LOCK_TIMEOUT_MS',
      ]),
    ),
    checkEnvironment(reasoningVariables, pick(env, Object.keys(reasoningVariables.shape))),
  );
  crossChecks([
    [
      parsed.KS_SCOPE_LOCK_TIMEOUT_MS >= parsed.KS_DB_STATEMENT_TIMEOUT_MS,
      'KS_SCOPE_LOCK_TIMEOUT_MS: must_be_below_statement_timeout',
    ],
  ]);
  return {
    ...release,
    plannerEnabled: (parsed.KS_PLANNER_ENABLED ?? (release.world === 'local' ? '1' : '0')) === '1',
    cartographerEnabled: parsed.KS_CARTOGRAPHER_ENABLED === '1',
    jevEnabled: parsed.KS_JEV_ENABLED === '1',
    composerPolicy: parsed.KS_COMPOSER_POLICY,
    supplyCreateDailyCap: supplyCreateDailyCap(parsed.KS_SUPPLY_CREATE_DAILY_CAP, release.world),
    supplyPlannerCreateDailyCap: parsed.KS_SUPPLY_PLANNER_CREATE_DAILY_CAP,
    scrollProductionGeneration: parsed.KS_SCROLL_PRODUCTION_GENERATION,
    database: databaseSettings(parsed, `knowscroll-worker-${release.world}`, parsed.KS_DB_POOL_MAX),
    shutdownGraceMs: parsed.KS_SHUTDOWN_GRACE_SECONDS * 1000,
    scopeLockTimeoutMs: parsed.KS_SCOPE_LOCK_TIMEOUT_MS,
    reasoning: reasoningSettings(reasoning),
  };
}

/**
 * Worker operator command configuration (`node dist/operator.js …` in the worker release tree,
 * run from a server shell with the world's environment): `KS_WORLD` (required), `DATABASE_URL` and
 * `KS_DB_STATEMENT_TIMEOUT_MS` (default 30000). Throws one `ConfigurationError` listing every
 * problem. (The API tree's own `dist/operator.js` is `readOperatorConfig`.)
 */
export function readWorkerOperatorConfig(env: Environment): WorkerOperatorConfig {
  const [parsed] = combineChecks(
    checkEnvironment(
      z.object({
        KS_WORLD: WorldSchema,
        DATABASE_URL: PostgresUrlSchema,
        KS_DB_STATEMENT_TIMEOUT_MS: positiveInteger(30_000, 600_000),
      }),
      pick(env, ['KS_WORLD', 'DATABASE_URL', 'KS_DB_STATEMENT_TIMEOUT_MS']),
    ),
  );
  return { world: parsed.KS_WORLD, database: databaseSettings(parsed, `knowscroll-operator-${parsed.KS_WORLD}`, 2) };
}

/**
 * Migration command configuration: `KS_WORLD` (required), `DATABASE_URL` and
 * `KS_DB_STATEMENT_TIMEOUT_MS` (default 15 minutes). Throws one `ConfigurationError` listing
 * every problem.
 */
export function readMigrateConfig(env: Environment): MigrateConfig {
  const [parsed] = combineChecks(
    checkEnvironment(
      z.object({
        KS_WORLD: WorldSchema,
        DATABASE_URL: PostgresUrlSchema,
        KS_DB_STATEMENT_TIMEOUT_MS: positiveInteger(900_000, 3_600_000),
      }),
      pick(env, ['KS_WORLD', 'DATABASE_URL', 'KS_DB_STATEMENT_TIMEOUT_MS']),
    ),
  );
  return { world: parsed.KS_WORLD, database: databaseSettings(parsed, `knowscroll-migrate-${parsed.KS_WORLD}`, 2) };
}

function pick(env: Environment, names: readonly string[]): Record<string, string | undefined> {
  return Object.fromEntries(names.map((name) => [name, env[name]]));
}

/** Worker operator only: the API never reads or holds the Cutroom origin/artifact root. */
export function readMediaImportConfig(env: Environment) {
  const base = readWorkerOperatorConfig(env);
  crossChecks([[!OPERATOR_WORLDS.includes(base.world), 'KS_WORLD: operator_command_refused_in_this_world']]);
  const [parsed] = combineChecks(
    checkEnvironment(
      z.object({
        KS_MEDIA_ROOT: z.string().regex(/^\//),
        KS_CUTROOM_ARTIFACT_ROOT: z.string().regex(/^\//),
        KS_CUTROOM_ORIGIN: z
          .string()
          .url()
          .refine((value) => {
            const url = new URL(value);
            return (
              url.protocol === 'http:' &&
              ['127.0.0.1', '[::1]'].includes(url.hostname) &&
              url.pathname === '/' &&
              !url.username &&
              !url.password &&
              !url.search &&
              !url.hash
            );
          }),
        KS_FFPROBE_PATH: z.string().regex(/^\//).default('/usr/bin/ffprobe'),
      }),
      pick(env, ['KS_MEDIA_ROOT', 'KS_CUTROOM_ARTIFACT_ROOT', 'KS_CUTROOM_ORIGIN', 'KS_FFPROBE_PATH']),
    ),
  );
  return {
    ...base,
    mediaRoot: parsed.KS_MEDIA_ROOT,
    cutroomOrigin: parsed.KS_CUTROOM_ORIGIN,
    cutroomArtifactRoot: parsed.KS_CUTROOM_ARTIFACT_ROOT,
    ffprobePath: parsed.KS_FFPROBE_PATH,
  };
}

/**
 * The room-face operator's settings (`dist/operator.js rooms kit|backdrop|…`, D-166, D-170): the world and database, the
 * rooms scope's harness settings, and where pictures are kept. `mediaRoot` is absent when `KS_MEDIA_ROOT` is not set;
 * then no picture can be made, and everything else still works.
 */
export interface RoomFaceOperatorConfig extends ContentOperatorConfig {
  readonly scopeLockTimeoutMs: number;
  readonly reasoning: ReasoningSettings;
  readonly mediaRoot: string | undefined;
}

/** Refuses worlds outside the content operator allowlist before composing a provider or database. */
export function readRoomFaceOperatorConfig(env: Environment): RoomFaceOperatorConfig {
  const content = readContentOperatorConfig(env);
  const [scope, reasoning] = combineChecks(
    checkEnvironment(
      z.object({
        KS_SCOPE_LOCK_TIMEOUT_MS: positiveInteger(5_000, 60_000),
        KS_MEDIA_ROOT: z.string().regex(/^\//).optional(),
      }),
      pick(env, ['KS_SCOPE_LOCK_TIMEOUT_MS', 'KS_MEDIA_ROOT']),
    ),
    checkEnvironment(reasoningVariables, pick(env, Object.keys(reasoningVariables.shape))),
  );
  crossChecks([
    [
      scope.KS_SCOPE_LOCK_TIMEOUT_MS >= content.database.statementTimeoutMs,
      'KS_SCOPE_LOCK_TIMEOUT_MS: must_be_below_statement_timeout',
    ],
  ]);
  return {
    ...content,
    scopeLockTimeoutMs: scope.KS_SCOPE_LOCK_TIMEOUT_MS,
    reasoning: reasoningSettings(reasoning),
    mediaRoot: scope.KS_MEDIA_ROOT,
  };
}

/** The bounded, nonpersonal Scroll operator's validated world, database and harness settings. */
export interface ScrollProductionOperatorConfig extends ContentOperatorConfig {
  readonly scopeLockTimeoutMs: number;
  readonly productionGeneration: number;
  readonly reasoning: ReasoningSettings;
}

/**
 * Refuses worlds outside the content operator allowlist before composing a provider or database.
 * Reads the same reasoning caps/transport settings as the worker; defaults never enable spending.
 */
export function readScrollProductionOperatorConfig(env: Environment): ScrollProductionOperatorConfig {
  const content = readContentOperatorConfig(env);
  const [scope, reasoning] = combineChecks(
    checkEnvironment(
      z.object({
        KS_SCOPE_LOCK_TIMEOUT_MS: positiveInteger(5_000, 60_000),
        KS_SCROLL_PRODUCTION_GENERATION: positiveInteger(1, 2_147_483_647),
      }),
      pick(env, ['KS_SCOPE_LOCK_TIMEOUT_MS', 'KS_SCROLL_PRODUCTION_GENERATION']),
    ),
    checkEnvironment(reasoningVariables, pick(env, Object.keys(reasoningVariables.shape))),
  );
  crossChecks([
    [
      scope.KS_SCOPE_LOCK_TIMEOUT_MS >= content.database.statementTimeoutMs,
      'KS_SCOPE_LOCK_TIMEOUT_MS: must_be_below_statement_timeout',
    ],
  ]);
  return {
    ...content,
    scopeLockTimeoutMs: scope.KS_SCOPE_LOCK_TIMEOUT_MS,
    productionGeneration: scope.KS_SCROLL_PRODUCTION_GENERATION,
    reasoning: reasoningSettings(reasoning),
  };
}
