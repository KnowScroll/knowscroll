import { assertOutsideTransaction } from '../../infrastructure/postgres/transaction-marker.js';
import type { ImagePort } from '../application/image-port.js';

/**
 * Wraps an image transport so its network call refuses to run inside a database transaction (blueprint §19: no network
 * wait inside a transaction). Composition roots wrap every image port, real or fixture, with this.
 */
export function guardedImagePort<P extends ImagePort>(port: P): P {
  return {
    ...port,
    generate(request, signal) {
      assertOutsideTransaction(`image:${port.provider}`);
      return port.generate(request, signal);
    },
  };
}
