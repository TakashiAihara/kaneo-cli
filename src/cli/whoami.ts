import { apiKey, type App } from "./app";
import { currentUser, listWorkspaces, type User, type Workspace } from "../api/kaneo";
import { KaneoApiError, normalizeBaseUrl } from "../api/http";

type Report = { api_url: string; user: User; workspaces: Workspace[] };

// Verifies the credential, then says whose it is.
//
// It lists workspaces rather than calling /auth/get-session: that endpoint
// answers 200 with null for a valid key, an invalid key and no key at all, so it
// cannot tell them apart. Listing workspaces fails with 401 on a bad key, which
// is what makes this check worth running. /user/me comes second, so a key that
// is refused is reported by the listing, and a server older than v2.29.2, which
// has no /user/me, is reported as that after the key was accepted.
export const whoamiCommand = {
  name: "whoami",
  short: "Verify the configured API key and show whose it is and what it can reach",
  args: (args: string[]) => {
    const first = args[0];
    if (first !== undefined) {
      throw new Error(`unknown command ${JSON.stringify(first)} for "kaneo whoami"`);
    }
  },
  run: async ({ app }: { app: App }) => {
    apiKey(app);
    const workspaces = await listWorkspaces();
    const user = await currentUser().catch((e: unknown) => {
      if (e instanceof KaneoApiError && e.statusCode === 404) {
        throw new Error(`the API key was accepted, but this server has no /user/me to say whose it is (Kaneo before v2.29.2): ${e.message}`);
      }
      throw e;
    });

    // The API root the calls were made against, not the raw setting: the
    // transport appends /api to whatever it is given, and a key check that
    // printed a different URL from the one used would mislead.
    const apiUrl = normalizeBaseUrl(app.cfg.apiUrl);
    app.out.human(`api url    ${apiUrl}`);
    app.out.human("api key    accepted");
    const who = [user.name, user.email === "" ? "" : `<${user.email}>`].filter((part) => part !== "").join(" ");
    app.out.human(`user       ${who === "" ? user.id : `${who} (${user.id})`}`);
    app.out.human(`workspaces ${workspaces.length}`);
    for (const workspace of workspaces) app.out.human(`  ${workspace.id}  ${workspace.name}`);

    const report: Report = { api_url: apiUrl, user, workspaces };
    app.out.data(report);
  },
};
