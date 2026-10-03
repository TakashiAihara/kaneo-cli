import { apiKey, type App } from "./app";
import { listWorkspaces, type Workspace } from "../api/kaneo";
import { normalizeBaseUrl } from "../api/http";

type Report = { api_url: string; workspaces: Workspace[] };

// Verifies the credential.
//
// It lists workspaces rather than calling /auth/get-session: that endpoint
// answers 200 with null for a valid key, an invalid key and no key at all, so it
// cannot tell them apart. Listing workspaces fails with 401 on a bad key, which
// is what makes this check worth running.
export const whoamiCommand = {
  name: "whoami",
  short: "Verify the configured API key and show what it can reach",
  args: (args: string[]) => {
    const first = args[0];
    if (first !== undefined) {
      throw new Error(`unknown command ${JSON.stringify(first)} for "kaneo whoami"`);
    }
  },
  run: async ({ app }: { app: App }) => {
    apiKey(app);
    const workspaces = await listWorkspaces();

    // The API root the calls were made against, not the raw setting: the
    // transport appends /api to whatever it is given, and a key check that
    // printed a different URL from the one used would mislead.
    const apiUrl = normalizeBaseUrl(app.cfg.apiUrl);
    app.out.human(`api url    ${apiUrl}`);
    app.out.human("api key    accepted");
    app.out.human(`workspaces ${workspaces.length}`);
    for (const workspace of workspaces) app.out.human(`  ${workspace.id}  ${workspace.name}`);

    const report: Report = { api_url: apiUrl, workspaces };
    app.out.data(report);
  },
};
