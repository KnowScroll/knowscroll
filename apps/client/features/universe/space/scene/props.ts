import * as THREE from 'three';
import { ROOM_SWATCHES } from '@knowscroll/contracts';
import { hexToUnit } from '../paint';
import { additive, hazeUniforms, type Built, type SceneContext } from './context';
import type { StationEmblem, StationSky } from '../space-definition';
import { constellationImage } from './constellation-sprite';
import { emblemImage } from './emblem-sprite';
import { PLANET_FRAGMENT, WORLD_VERTEX } from './shaders';

/** A flat-coloured, softly lit material for small props (the station and the ship). */
function solidMaterial(hex: string, context: SceneContext, sun: THREE.Vector3): THREE.ShaderMaterial {
  const [red, green, blue] = hexToUnit(hex);
  const swatch = context.trackTexture({
    data: new Uint8Array([red * 255, green * 255, blue * 255, 255]),
    width: 1,
    height: 1,
  });
  return new THREE.ShaderMaterial({
    vertexShader: WORLD_VERTEX,
    fragmentShader: PLANET_FRAGMENT,
    uniforms: {
      map: { value: swatch },
      sun: { value: sun },
      atmo: { value: new THREE.Vector3(0.4, 0.5, 0.8) },
      cloudLayer: { value: 0 },
      ...hazeUniforms(context),
    },
  });
}

/**
 * A room's station (D-090 draws its constellation later): a small hub with a ring, two solar panels
 * and a blinking light, in the Universe's painted style. `context.calm` dims it under Lately. A room with a face
 * (D-170) wears its accent on the ring and its emblem over the hub, so the station is the room's own.
 */
export function makeStation(
  context: SceneContext,
  sun: THREE.Vector3,
  emblem?: StationEmblem,
  sky?: StationSky,
  live = false,
): Built {
  // A room that has finished a constellation is lit: a heavier ring and a light that stays on instead of blinking.
  const lit = sky !== undefined && sky.finished >= 1;
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.SphereGeometry(0.2, 20, 12), solidMaterial('#EDE6D6', context, sun)));
  const ringColour = emblem === undefined ? '#FFB347' : ROOM_SWATCHES[emblem.palette.accent];
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.32, lit ? 0.06 : 0.04, 8, 32),
    solidMaterial(ringColour, context, sun),
  );
  ring.rotation.x = Math.PI / 2;
  group.add(ring);
  for (const side of [-1, 1]) {
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.02, 0.2), solidMaterial('#3D8BEA', context, sun));
    panel.position.x = side * 0.58;
    group.add(panel);
  }
  const light = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: context.sprites.glow,
      // A live Launch turns the light red and makes it pulse (R3 E): the caption on the map says the same in words.
      color: live ? new THREE.Color(1, 0.18, 0.12) : new THREE.Color(1, 0.5, 0.7),
      opacity: 1,
      ...additive,
    }),
  );
  light.position.y = 0.27;
  light.scale.setScalar(0.26);
  group.add(light);
  // The emblem is a sprite, so it always faces the camera while the station turns beneath it.
  const emblemMap = emblem === undefined ? undefined : context.trackTexture(emblemImage(emblem));
  if (emblemMap !== undefined) {
    // The pixels are the kit's own sRGB colours: without this the sprite would be lit as if they were linear and wash out.
    emblemMap.colorSpace = THREE.SRGBColorSpace;
    emblemMap.needsUpdate = true;
  }
  const plate =
    emblemMap === undefined
      ? undefined
      : new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: emblemMap,
            transparent: true,
            opacity: context.calm ? 0.45 : 1,
            depthWrite: false,
          }),
        );
  if (plate !== undefined) {
    plate.position.y = 0.95;
    plate.scale.setScalar(0.9);
    plate.name = 'room-emblem';
    group.add(plate);
  }
  // The constellation rises over the emblem as one flat plate that faces the camera: the lit stars joined by lines, the rest hollow.
  if (sky !== undefined) {
    const map = context.trackTexture(constellationImage(sky.lit, emblem?.palette.accent));
    map.colorSpace = THREE.SRGBColorSpace;
    map.needsUpdate = true;
    const plate = new THREE.Sprite(
      new THREE.SpriteMaterial({ map, transparent: true, opacity: context.calm ? 0.45 : 1, depthWrite: false }),
    );
    plate.position.y = 1.2;
    plate.scale.setScalar(2.4);
    plate.name = 'room-constellation';
    group.add(plate);
  }
  const tick = (t: number): void => {
    group.rotation.y = t * 0.15;
    if (live) {
      light.scale.setScalar(0.26 * (1.25 + 0.45 * Math.sin(t * 4)));
      light.material.opacity = 1;
      return;
    }
    light.material.opacity = context.calm ? 0.1 : lit || Math.sin(t * 2.6) > 0.4 ? 1 : 0.12;
  };
  tick(0);
  return { object: group, tick };
}

/** The parked ship: a small white cone with a flickering flame. It is a mark, never a person. */
export function makeShip(context: SceneContext, sun: THREE.Vector3, scale = 1): Built {
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.ConeGeometry(0.09 * scale, 0.32 * scale, 12),
    solidMaterial('#FAF8F0', context, sun),
  );
  const flame = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: context.sprites.glow,
      color: new THREE.Color(1, 0.55, 0.15),
      opacity: 0.95,
      ...additive,
    }),
  );
  const direction = new THREE.Vector3(0.5, 0.8, -0.3).normalize();
  body.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  flame.position.copy(direction.clone().multiplyScalar(-0.2 * scale));
  group.add(body, flame);
  const tick = (t: number): void => {
    flame.scale.setScalar(0.24 * scale * (1 + 0.18 * Math.sin(t * 19)));
  };
  tick(0);
  return { object: group, tick };
}
