// The Kaneo release the client is generated from. `bun run spec <version>`
// fetches that release's document and rewrites this line; nothing else names
// the version. Not KANEO_VERSION: the build defines that name for the CLI's
// own version, and a define replaces the identifier wherever it is bundled.
export const SPEC_VERSION = "2.32.0";
export const SPEC_PATH = new URL(`./kaneo-${SPEC_VERSION}.json`, import.meta.url).pathname;
