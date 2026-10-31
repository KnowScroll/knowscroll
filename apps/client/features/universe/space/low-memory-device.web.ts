/** A device of this many gigabytes or fewer, as the browser rounds it, opens the tab as the Simple lists (D-111). */
export const LOW_MEMORY_GIGABYTES = 1;

/**
 * Whether this browser says it has little memory. `navigator.deviceMemory` is a rounded power of two
 * (0.25, 0.5, 1, 2, 4, 8) offered by Chromium in secure contexts; where it is absent nothing is assumed.
 */
export const lowMemoryDevice = (): boolean => {
  const gigabytes = (navigator as Navigator & { readonly deviceMemory?: number }).deviceMemory;
  return typeof gigabytes === 'number' && gigabytes <= LOW_MEMORY_GIGABYTES;
};
