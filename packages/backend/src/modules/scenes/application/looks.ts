import type { SceneLook } from '@knowscroll/contracts';
import type { GeographySceneInput } from '../../geography/public.js';
import { assignLooks, LookRefused, type LookSubject } from './assign-looks.js';
import type { StoredObject } from './ports.js';

/**
 * The looks that the stored objects of a universe still lack, given the catalogue meaning of each
 * object from Geography's public input. Nothing about an object's slot, seed, family or anchor is
 * read for a decision other than the seed that seeds its own look, and nothing is changed.
 * Throws `LookRefused` when an object has no meaning in the input.
 */
export function missingLooks(
  objects: readonly StoredObject[],
  input: GeographySceneInput,
  existing: readonly SceneLook[],
): SceneLook[] {
  const meaning = new Map(input.objects.map((object) => [object.id, object.meaningId]));
  const subjects: LookSubject[] = objects.map((object) => {
    const meaningId = meaning.get(object.descriptor.objectId);
    if (meaningId === undefined) throw new LookRefused('object_without_meaning');
    return {
      objectId: object.descriptor.objectId,
      kind: object.descriptor.kind,
      parentId: object.descriptor.parentId,
      systemId: object.systemId,
      meaningId,
      seed: object.descriptor.seed,
    };
  });
  return assignLooks(subjects, existing);
}
