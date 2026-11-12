import type { GeographyRevisions, SceneRevisions } from '@knowscroll/contracts';

/** The projection already holds exactly these Geography stamps, so nothing is left to project or to wait for. */
export const projectsGeography = (projected: SceneRevisions | undefined, geography: GeographyRevisions): boolean =>
  projected !== undefined &&
  projected.geographyRevision === geography.revision &&
  projected.structureRevision === geography.structureRevision &&
  projected.activityRevision === geography.activityRevision;
