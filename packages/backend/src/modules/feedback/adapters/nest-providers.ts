import {
  CHECK_ASSET_AUDIENCE,
  FIND_ASSET_FOR_ACTION,
  type CheckAssetAudience,
  type FindAssetForAction,
} from '../../content/public.js';
import { FENCE_OWN_ACCOUNT, type FenceOwnAccount, type WithPersonalScope } from '../../identity/public.js';
import { READ_REPORTABLE_ROOM_MESSAGE, READ_ROOM_REPORTS, type ReadReportableRoomMessage } from '../../rooms/public.js';
import {
  READ_PUBLIC_PEOPLE,
  READ_REPORTABLE_MESSAGE,
  type ReadPublicPeople,
  type ReadReportableMessage,
} from '../../social/public.js';
import { uuidv7 } from '../../../infrastructure/ids/index.js';
import {
  completePersonalReceipt,
  findPersonalReceipt,
  insertPersonalReceipt,
  requestHash,
  type CanonicalJson,
} from '../../../infrastructure/receipts/index.js';
import { makeReportUseCases, type ReportUseCases } from '../application/file-report.js';
import { REPORT_USE_CASES } from '../public.js';
import { readRoomReports, reportStore } from './postgres-reports.js';

/** What the report use cases need from the rest of the system, chosen by the composition root. */
export interface FeedbackDeps {
  readonly withScope: WithPersonalScope;
  readonly fenceOwn: FenceOwnAccount;
  readonly findAsset: FindAssetForAction;
  /** Which assets the caller may reach: a Scroll made for a thread is missing to anyone outside it. */
  readonly checkAudience: CheckAssetAudience;
  readonly readMessage: ReadReportableMessage;
  readonly readRoomMessage: ReadReportableRoomMessage;
  readonly readPeople: ReadPublicPeople;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/** The report use cases over PostgreSQL and the neighbouring modules' public reads. */
export function reportUseCases(deps: FeedbackDeps): ReportUseCases {
  return makeReportUseCases({
    withScope: deps.withScope,
    fenceOwn: deps.fenceOwn,
    hash: (operation, request) => requestHash(operation, request as CanonicalJson),
    findReceipt: findPersonalReceipt,
    insertReceipt: insertPersonalReceipt,
    completeReceipt: (scope, commandId, outcome) =>
      completePersonalReceipt(scope, commandId, outcome as { readonly [key: string]: CanonicalJson }),
    findAsset: async (scope, assetId) =>
      (await deps.checkAudience({ scope }, scope.authority, [assetId])).has(assetId)
        ? deps.findAsset(scope, assetId)
        : undefined,
    readMessage: deps.readMessage,
    readRoomMessage: deps.readRoomMessage,
    readPeople: deps.readPeople,
    reports: reportStore,
    newId: deps.newId ?? uuidv7,
    now: deps.now ?? (() => new Date()),
  });
}

/** The API's report use cases, and the read the Rooms module shows a room's moderators. */
export function feedbackProviders(tokens: { readonly withPersonalScope: symbol }) {
  return [
    { provide: READ_ROOM_REPORTS, useValue: readRoomReports },
    {
      provide: REPORT_USE_CASES,
      inject: [
        tokens.withPersonalScope,
        FENCE_OWN_ACCOUNT,
        FIND_ASSET_FOR_ACTION,
        CHECK_ASSET_AUDIENCE,
        READ_REPORTABLE_MESSAGE,
        READ_REPORTABLE_ROOM_MESSAGE,
        READ_PUBLIC_PEOPLE,
      ],
      useFactory: (
        withScope: WithPersonalScope,
        fenceOwn: FenceOwnAccount,
        findAsset: FindAssetForAction,
        checkAudience: CheckAssetAudience,
        readMessage: ReadReportableMessage,
        readRoomMessage: ReadReportableRoomMessage,
        readPeople: ReadPublicPeople,
      ) => reportUseCases({ withScope, fenceOwn, findAsset, checkAudience, readMessage, readRoomMessage, readPeople }),
    },
  ];
}
