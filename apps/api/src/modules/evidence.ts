import { sceneAppliedProviders } from '@knowscroll/backend/modules/scenes/nest-providers';
import { geographyProviders } from '@knowscroll/backend/modules/geography/nest-providers';
import { GEOGRAPHY_MATERIAL_CHANGE, type MaterialGeographyChange } from '@knowscroll/backend/modules/geography';
import type { PlannerMaterialChange } from '@knowscroll/backend/modules/planner';
import { plannerReadProviders, plannerRequestProviders } from '@knowscroll/backend/modules/planner/nest-providers';
import { PLANNER_MATERIAL_CHANGE, READ_CURRENT_PLAN } from '@knowscroll/backend/modules/planner';
import type { Provider } from '@nestjs/common';
import {
  INGEST_OBSERVATIONS,
  READ_EVIDENCE_DIAGNOSTICS,
  evidenceIntakeProviders,
  activityProviders,
} from '@knowscroll/backend/modules/evidence/nest-providers';
import { DATABASE, ENQUEUE_JOB, WITH_PERSONAL_SCOPE } from '../tokens.js';
import { personalContextProviders } from '@knowscroll/backend/modules/personal-context/nest-providers';
import { ACTIVITY_CONTEXT_EFFECT } from '@knowscroll/backend/modules/personal-context';

/** Evidence wiring for the API composition root: the observation intake and the dev diagnostics read. */
const PERSONAL_MATERIAL_CHANGE = Symbol('personal.materialChange');
export const evidenceWiring: Provider[] = [
  ...sceneAppliedProviders({ enqueueJob: ENQUEUE_JOB }),
  ...geographyProviders({ withPersonalScope: WITH_PERSONAL_SCOPE, enqueueJob: ENQUEUE_JOB }),
  {
    provide: PERSONAL_MATERIAL_CHANGE,
    inject: [PLANNER_MATERIAL_CHANGE, GEOGRAPHY_MATERIAL_CHANGE],
    useFactory:
      (planner: PlannerMaterialChange, geography: MaterialGeographyChange): MaterialGeographyChange =>
      async (scope, input) => {
        await planner(scope, input);
        await geography(scope, input);
      },
  },
  ...plannerRequestProviders({ withPersonalScope: WITH_PERSONAL_SCOPE, enqueueJob: ENQUEUE_JOB }),
  // Installs the required PC-owned Composer adapter; legacy Evidence preparation stays disabled.
  // Composer's prepared context carries the person's current Planner plan from the stored read.
  ...plannerReadProviders(),
  ...personalContextProviders({ readCurrentPlan: READ_CURRENT_PLAN }),
  ...activityProviders({
    withPersonalScope: WITH_PERSONAL_SCOPE,
    enqueueJob: ENQUEUE_JOB,
    derivedProjection: ACTIVITY_CONTEXT_EFFECT,
    materialChange: PERSONAL_MATERIAL_CHANGE,
  }),
  ...evidenceIntakeProviders({
    database: DATABASE,
    withPersonalScope: WITH_PERSONAL_SCOPE,
    enqueueJob: ENQUEUE_JOB,
  }),
];

export { INGEST_OBSERVATIONS, READ_EVIDENCE_DIAGNOSTICS };
