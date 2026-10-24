-- A branch the Planner marked as speculative (its premise runs against established knowledge, and the member
-- confirmed it), or one that continues such a branch. It shows as "Speculative" on its card and as a banner over
-- its Scroll. Nothing else in the exploration changes. (Provisional number: the coordinator assigns the final one.)
alter table scenarios.nodes add column speculative boolean not null default false;
