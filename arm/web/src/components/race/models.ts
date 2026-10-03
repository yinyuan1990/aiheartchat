import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

// Kenney Car Kit (CC0, public/race/*.glb, licence in License-kenney.txt). The kit's cars face +z and are ~0.6 m per
// unit; prototypes are scaled by KIT and turned to face -z (our forward), with the base at y = 0.

export const KIT = 1.6;
export const PLAYER_CARS = ["race", "race-future", "sedan-sports", "hatchback-sports"] as const;
export type PlayerCar = (typeof PLAYER_CARS)[number];
export const TRAFFIC = ["sedan", "taxi", "suv", "van", "police", "truck", "delivery", "ambulance", "garbage-truck", "firetruck"] as const;
export const DEBRIS = ["debris-tire", "debris-door", "debris-bumper", "debris-spoiler-a", "debris-plate-a"] as const;

export type Proto = { obj: THREE.Object3D; size: THREE.Vector3 };

const loader = new GLTFLoader();
const cache = new Map<string, Promise<Proto | null>>();
const ready = new Map<string, Proto>();

export function loadModel(name: string): Promise<Proto | null> {
  let p = cache.get(name);
  if (p) return p;
  p = new Promise<Proto | null>((res) => {
    loader.load(
      `/race/${name}.glb`,
      (gltf) => {
        const inner = gltf.scene;
        inner.scale.setScalar(KIT);
        inner.rotation.y = Math.PI;
        inner.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          m.castShadow = true;
          const mat = m.material as THREE.MeshStandardMaterial;
          if (mat.isMeshStandardMaterial) { mat.roughness = 0.45; mat.metalness = 0.15; mat.envMapIntensity = 1.1; }
        });
        const wrap = new THREE.Group();
        wrap.add(inner);
        const box = new THREE.Box3().setFromObject(wrap);
        inner.position.y = -box.min.y;
        const proto = { obj: wrap, size: box.getSize(new THREE.Vector3()) };
        ready.set(name, proto);
        res(proto);
      },
      undefined,
      () => res(null),
    );
  });
  cache.set(name, p);
  return p;
}

/** A clone if the model has loaded, else null (callers fall back or skip). Wheels are the kit's `wheel-*` nodes. */
export function instance(name: string) {
  const p = ready.get(name);
  if (!p) return null;
  const obj = p.obj.clone(true);
  const wheels: THREE.Object3D[] = [];
  obj.traverse((o) => { if (o.name.startsWith("wheel")) wheels.push(o); });
  return { obj, size: p.size, wheels };
}

export const isReady = (name: string) => ready.has(name);

/** Procedural stand-in so a slow network never leaves the road empty. */
export function boxCar(color: string) {
  const g = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.2 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.8, 4.1), paint);
  body.position.y = 0.75;
  const cab = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.6, 2.0), new THREE.MeshStandardMaterial({ color: "#20242c", roughness: 0.2, metalness: 0.5 }));
  cab.position.set(0, 1.4, 0.2);
  body.castShadow = cab.castShadow = true;
  g.add(body, cab);
  return { obj: g as THREE.Object3D, size: new THREE.Vector3(2.1, 1.7, 4.1), wheels: [] as THREE.Object3D[] };
}
