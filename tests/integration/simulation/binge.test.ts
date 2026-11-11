import { bingeLibraryConfig } from './config.js';
import { defineLab } from './lab.js';
import { bingeReader } from './personas.js';

/**
 * The binge reader reads everything and then some, so it needs a library it can finish: five planets of three units.
 * It meets the end of what is unseen, where a repeat is allowed but must be the last resort.
 */
defineLab({ group: 'binge', solo: [bingeReader], config: bingeLibraryConfig });
