import type { StremioManifest } from "../types.js";

export const ADDON_ID = "community.vega.stremio";
export const ADDON_VERSION = "1.0.0";

export function getManifest(): StremioManifest {
  return {
    id: ADDON_ID,
    version: ADDON_VERSION,
    name: "Vega Streams",
    description: "Streams from Vega providers",
    types: ["movie", "series"],
    resources: ["stream"],
    idPrefixes: ["tt"],
    catalogs: [],
    behaviorHints: { configurable: false },
  };
}
