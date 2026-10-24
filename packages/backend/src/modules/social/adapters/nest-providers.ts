import { createHash, randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import {
  READ_CONTENT_SEQUENCE,
  READ_PUBLIC_CONTENT,
  READ_SHAREABLE_CONTENT,
  RESOLVE_SNIPPET_ANCHOR,
  VALIDATE_SNIPPET_ANCHOR,
  type ReadContentSequence,
  type ReadPublicContent,
  type ReadShareableContent,
  type ResolveSnippetAnchor,
  type ValidateSnippetAnchor,
} from '../../content/public.js';
import { READ_VISITED_ASSETS, type ReadVisitedAssets } from '../../experience/public.js';
import { makeConversationCommands } from '../application/conversation-commands.js';
import { makeThreadCommands } from '../application/thread-commands.js';
import { makeThreadReads } from '../application/thread-reads.js';
import type { ThreadPorts } from '../application/thread-ports.js';
import { threadIdFor, threadStore } from './postgres-threads.js';
import { makeThreadGuest } from '../application/thread-guest.js';
import { makeAnnounceThread, makeReadThreadStanding, sequenceOf } from './postgres-thread-guest.js';
import { makeConversationReads } from '../application/conversation-reads.js';
import { makeContentShares } from '../application/content-shares.js';
import type { ConversationPorts } from '../application/conversation-ports.js';
import { conversationStore } from './postgres-conversations.js';
import { shareStore } from './postgres-shares.js';
import { makeReadRoster } from '../application/rosters.js';
import { makeInvites } from '../application/invites.js';
import { rosterStore } from './postgres-rosters.js';
import { inviteStore } from './postgres-invites.js';
import { rosterCursorCodec } from './roster-cursor.js';
import type { FenceAccountPair, FenceOwnAccount, WithPersonalScope } from '../../identity/public.js';
import { FENCE_ACCOUNT_PAIR, FENCE_OWN_ACCOUNT } from '../../identity/public.js';
import { uuidv7 } from '../../../infrastructure/ids/index.js';
import { requestHash, type CanonicalJson } from '../../../infrastructure/receipts/index.js';
import { makeReadProfile, makeSetProfile } from '../application/profiles.js';
import { makeLookupPerson, makeReadPair } from '../application/lookup-person.js';
import { makePairCommand } from '../application/pairs.js';
import {
  ANNOUNCE_THREAD,
  CONVERSATION_USE_CASES,
  READ_INBOX_REVISION,
  READ_THREAD_STANDING,
  SOCIAL_USE_CASES,
  THREAD_GUEST,
  THREAD_USE_CASES,
  type ThreadGuest,
  type ConversationUseCases,
  type ReadInboxRevision,
  type SocialUseCases,
  type ThreadUseCases,
} from '../public.js';
import { socialStore } from './postgres-store.js';
import type { SocialPorts } from '../application/ports.js';
interface SocialDeps {
  withScope: WithPersonalScope;
  fencePair: FenceAccountPair;
  fenceOwn: FenceOwnAccount;
  now?: () => Date;
  newId?: () => string;
  store?: SocialPorts['store'];
  cursor?: SocialPorts['cursor'];
}

function socialPorts(deps: SocialDeps): SocialPorts {
  return {
    ...deps,
    invites: inviteStore,
    rosters: rosterStore,
    cursor: deps.cursor ?? rosterCursorCodec(),
    secret: () => `ksfi_${randomBytes(32).toString('base64url')}`,
    digest: (secret) => createHash('sha256').update(secret).digest('hex'),
    store: deps.store ?? socialStore,
    newId: deps.newId ?? uuidv7,
    now: deps.now ?? (() => new Date()),
    hash: (operation, input) => requestHash(operation, input as CanonicalJson),
  };
}

/** Explicit backend use cases; only composition roots choose crypto and database adapters. */
export function socialUseCases(deps: SocialDeps): SocialUseCases {
  const ports = socialPorts(deps);
  return {
    ...makeInvites(ports),
    readFriends: makeReadRoster(ports, false),
    readRequests: makeReadRoster(ports, true),
    readProfile: makeReadProfile(ports),
    setProfile: makeSetProfile(ports),
    lookup: makeLookupPerson(ports),
    readPair: makeReadPair(ports),
    command: makePairCommand(ports),
  };
}

/** Conversations and share links over the same ports; `db` serves only reads for visitors with no account. */
export function conversationUseCases(
  deps: SocialDeps & {
    db: Kysely<Database>;
    readContent: ReadShareableContent;
    readPublicContent: ReadPublicContent;
  },
): ConversationUseCases {
  const ports: ConversationPorts = {
    ...socialPorts(deps),
    conversations: conversationStore(deps.readContent),
    shares: shareStore(deps.db, deps.readContent, deps.readPublicContent),
    shareToken: () => `kssh_${randomBytes(32).toString('base64url')}`,
  };
  return {
    conversations: { ...makeConversationCommands(ports), ...makeConversationReads(ports) },
    shares: makeContentShares(ports),
  };
}

interface ThreadDeps extends SocialDeps {
  readContent: ReadShareableContent;
  readSequence: ReadContentSequence;
  readVisited: ReadVisitedAssets;
  validateSnippet: ValidateSnippetAnchor;
  resolveSnippet: ResolveSnippetAnchor;
}

function threadPorts(deps: ThreadDeps): ThreadPorts {
  return {
    ...socialPorts(deps),
    conversations: conversationStore(deps.readContent),
    threads: threadStore,
    threadIdFor,
    readSequence: deps.readSequence,
    readVisited: deps.readVisited,
    validateSnippet: deps.validateSnippet,
    resolveSnippet: deps.resolveSnippet,
  };
}

/** Content threads over the same ports plus the content and experience reads they need. */
export function threadUseCases(deps: ThreadDeps): ThreadUseCases {
  const ports = threadPorts(deps);
  return { ...makeThreadCommands(ports), ...makeThreadReads(ports) };
}

/** What other modules may do inside a thread, over the same ports (see `ThreadGuest`). */
export function threadGuest(deps: ThreadDeps): ThreadGuest {
  return makeThreadGuest({ ...threadPorts(deps), sequenceOf });
}

/** The inbox revision of one account, read on the pool (the gateway has no scope). */
export function readInboxRevision(db: Kysely<Database>): ReadInboxRevision {
  return async (accountId) => {
    const head = await db
      .selectFrom('social.inbox_heads')
      .select('revision')
      .where('account_id', '=', accountId)
      .executeTakeFirst();
    return Number(head?.revision ?? 0);
  };
}
/** The tokens a thread's dependencies are injected from, in the order `threadDepsOf` takes them. */
const THREAD_INJECTIONS = (tokens: { readonly withPersonalScope: symbol }) => [
  tokens.withPersonalScope,
  FENCE_ACCOUNT_PAIR,
  FENCE_OWN_ACCOUNT,
  READ_SHAREABLE_CONTENT,
  READ_CONTENT_SEQUENCE,
  READ_VISITED_ASSETS,
  VALIDATE_SNIPPET_ANCHOR,
  RESOLVE_SNIPPET_ANCHOR,
];

function threadDepsOf(
  withScope: WithPersonalScope,
  fencePair: FenceAccountPair,
  fenceOwn: FenceOwnAccount,
  readContent: ReadShareableContent,
  readSequence: ReadContentSequence,
  readVisited: ReadVisitedAssets,
  validateSnippet: ValidateSnippetAnchor,
  resolveSnippet: ResolveSnippetAnchor,
): ThreadDeps {
  return { withScope, fencePair, fenceOwn, readContent, readSequence, readVisited, validateSnippet, resolveSnippet };
}

/**
 * What other modules may do inside a thread: the guest, the standing read and the inbox hint. A
 * process that needs only these (the worker) composes this and not all of `socialProviders`. Needs
 * the content, experience and identity tokens `THREAD_INJECTIONS` names.
 */
export function threadGuestProviders(tokens: { readonly withPersonalScope: symbol; readonly database: symbol }) {
  return [
    {
      provide: THREAD_GUEST,
      inject: THREAD_INJECTIONS(tokens),
      useFactory: (...args: Parameters<typeof threadDepsOf>) => threadGuest(threadDepsOf(...args)),
    },
    {
      provide: READ_THREAD_STANDING,
      inject: [tokens.database],
      useFactory: (db: Kysely<Database>) => makeReadThreadStanding(db),
    },
    {
      provide: ANNOUNCE_THREAD,
      inject: [tokens.database],
      useFactory: (db: Kysely<Database>) => makeAnnounceThread(db),
    },
  ];
}

export function socialProviders(tokens: { readonly withPersonalScope: symbol; readonly database: symbol }) {
  return [
    {
      provide: CONVERSATION_USE_CASES,
      inject: [
        tokens.withPersonalScope,
        FENCE_ACCOUNT_PAIR,
        FENCE_OWN_ACCOUNT,
        tokens.database,
        READ_SHAREABLE_CONTENT,
        READ_PUBLIC_CONTENT,
      ],
      useFactory: (
        withScope: WithPersonalScope,
        fencePair: FenceAccountPair,
        fenceOwn: FenceOwnAccount,
        db: Kysely<Database>,
        readContent: ReadShareableContent,
        readPublicContent: ReadPublicContent,
      ) => conversationUseCases({ withScope, fencePair, fenceOwn, db, readContent, readPublicContent }),
    },
    {
      provide: THREAD_USE_CASES,
      inject: THREAD_INJECTIONS(tokens),
      useFactory: (...args: Parameters<typeof threadDepsOf>) => threadUseCases(threadDepsOf(...args)),
    },
    ...threadGuestProviders(tokens),
    {
      provide: READ_INBOX_REVISION,
      inject: [tokens.database],
      useFactory: (db: Kysely<Database>) => readInboxRevision(db),
    },
    {
      provide: SOCIAL_USE_CASES,
      inject: [tokens.withPersonalScope, FENCE_ACCOUNT_PAIR, FENCE_OWN_ACCOUNT],
      useFactory: (withScope: WithPersonalScope, fencePair: FenceAccountPair, fenceOwn: FenceOwnAccount) =>
        socialUseCases({ withScope, fencePair, fenceOwn }),
    },
  ];
}
export { socialStore, privatePairId } from './postgres-store.js';
export type { SocialPorts } from '../application/ports.js';
