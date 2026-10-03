// The Kaneo release the client is generated from. `bun run spec <version>`
// fetches that release's document and rewrites this line; nothing else names
// the version.
export const KANEO_VERSION = "2.29.2";
export const SPEC_PATH = new URL(`./kaneo-${KANEO_VERSION}.json`, import.meta.url).pathname;
