# ADR-0001 — One product monorepo, separate Cutroom

Date: 2026-09-15. Status: accepted under the owner’s delegated bootstrap authority.

## Context

A small team and several coding sessions need shared contracts and one understandable integration history. Mobile, API, core and workers will change together; they need not deploy together.

## Decision

Use private `KnowScroll/knowscroll`. Local checkout: `/Volumes/Mrigesh SSD/knowscroll-product`; the shorter local `knowscroll` folder already contains unrelated historical projects. Keep apps/mobile, apps/api and apps/worker with packages/contracts, core and db. Reserve admin as a future application only when implemented. Cutroom remains a separate repository and deployment.

## Alternatives and why

Separate mobile/backend repositories offer independent access and release management, but add cross-repository contract coordination for this small team. A single unstructured package hides ownership. A monorepo gives reviewable changes across boundaries; this is engineering judgment, not a performance claim.

## Consequences

pnpm manages TypeScript tooling. Android owns its Gradle build. JSON contracts, not TypeScript imports, cross into Kotlin. API and worker may deploy independently with compatible migrations. Current JS dependencies are centralized at the workspace root; independently packaged artifacts can follow when deployment needs them. Local folder naming is reversible.

## Sources and verification

[pnpm workspace model](https://pnpm.io/workspaces).
