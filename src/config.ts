/** Texels per metre in the explore view (one ground tile = 1 m = 16 texels). */
export const PPM = 16;
/** Vertical scale for building walls and tree heights in the oblique view. */
export const VSCALE = 0.72;
/** Ground chunk size in texels. */
export const CHUNK = 256;
/** Texels per metre in the overview map. */
export const OV_PPM = 2;

/** Walking and running speed, metres per second. */
export const WALK = 3.2;
export const RUN = 6.4;
export const BIKE = 9;

/** Remote players are drawn this far in the past to interpolate between snapshots. */
export const INTERP_MS = 140;

/** Ground classes, keep in sync with tools/build_map.py. */
export const enum G {
  None = 0, Grass, Pave, Asph, Red, Turf, Blue, Water, LPave, Line, Urban, Sidewalk, Dirt,
}

export const STORAGE_KEY = 'vmap.profile.v1';
