// The version is stamped in at build time; an unreleased build calls itself dev,
// which is what makes it obvious that a report about it belongs to no release.
declare const KANEO_VERSION: string | undefined;
export const version: string = typeof KANEO_VERSION === "undefined" ? "dev" : KANEO_VERSION;
