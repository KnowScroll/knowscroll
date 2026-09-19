/** ADR-0018. Internal helpers require a caller-owned transaction; no public API. */
export type IdleDirectJobScope={jobId:string;universeId:string;privacyEpoch:number};
export type IdleWithdrawalResult={
 status:'cancelled'|'expired';
 changed:boolean;
 closedNotSent:number;
 preservedUnknown:number;
};
export const IDLE_WITHDRAWAL_LIMITS=Object.freeze({steps:128,attempts:128});
