import { CATALOGUE_DIR, loadCatalogue } from "../catalogue/catalogue.ts";
import { isOwnKey } from "../../lib/ownKey.ts";
import { SHOWROOM_CATALOGUE } from "./showroom/scene.ts";
import { seedShowroom } from "./showroom/seed.ts";

// A scene is the world one Eden is built around. The lab is for testing Aurral; the
// showroom is the curated music Aurral's screenshots are taken in.
export const scenes = {
  lab: { catalogue: CATALOGUE_DIR, realCovers: false, seed: null },
  showroom: { catalogue: SHOWROOM_CATALOGUE, realCovers: true, seed: seedShowroom },
} as const;

export type SceneName = keyof typeof scenes;
export const sceneNames = Object.keys(scenes);
export const isScene = (name: string): name is SceneName => isOwnKey(scenes, name);

// Eden's containers learn their scene from the environment Compose gives them.
export function sceneFromEnv(): SceneName {
  const name = process.env.EDEN_SCENE || "lab";
  if (!isScene(name)) throw new Error(`Unknown scene ${name}. Eden has ${sceneNames.join(", ")}.`);
  return name;
}

export const loadSceneCatalogue = (name: SceneName = sceneFromEnv()) =>
  loadCatalogue(scenes[name].catalogue);
