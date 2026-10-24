import blackHoleHorizon from '../../approved/reels/black-hole-horizon.json' with { type: 'json' };
import exoplanetTransit from '../../approved/reels/exoplanet-transit.json' with { type: 'json' };
import starsFusion from '../../approved/reels/stars-fusion.json' with { type: 'json' };
import tidesSpringNeap from '../../approved/reels/tides-spring-neap.json' with { type: 'json' };
import { ReelScriptSchema, type ReelScript } from '../../domain/reel/script.js';

/**
 * The Reel scripts that shipped with this release, by name. A script is approved in Git and the
 * order command names it; nothing else can be ordered. Adding one is a new JSON file here and a
 * line below. A file that does not parse stops the process that loads it.
 */
const shipped = {
  'black-hole-horizon': blackHoleHorizon,
  'exoplanet-transit': exoplanetTransit,
  'stars-fusion': starsFusion,
  'tides-spring-neap': tidesSpringNeap,
};

export const reelScripts: ReadonlyMap<string, ReelScript> = new Map(
  Object.entries(shipped).map(([name, json]) => [name, ReelScriptSchema.parse(json)]),
);
