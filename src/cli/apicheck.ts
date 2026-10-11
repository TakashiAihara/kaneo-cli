import type { App } from "./app";
import { checkApi } from "../api/kaneo";
import { OPERATIONS, type Operation } from "../api/registry";
import type { Json } from "../output/json";

// Compares what this client calls against what the server offers.
//
// It exits non-zero when an operation this client uses is missing from the
// server, so it can gate a release. Reporting a missing operation and exiting 0
// would make the check unusable in CI, which is the whole reason to have it.
// Request drift is reported without failing: see requestDrift in api/shape.ts.
export const apiCheckCommand = {
  name: "api-check",
  short: "Check this client's operations against the server's OpenAPI document",
  long:
    "Check this client's operations against the server's OpenAPI document.\n\n" +
    "Exits non-zero when the server is missing an operation this client calls.\n" +
    "Also lists request fields whose server definition differs from the pinned\n" +
    "document (DRIFT): leads to check, which do not change the exit status.\n" +
    "The document needs no authentication, so this works before a key is set.",
  args: (args: string[]) => {
    const first = args[0];
    if (first !== undefined) {
      throw new Error(`unknown command ${JSON.stringify(first)} for "kaneo api-check"`);
    }
  },
  run: async ({ app }: { app: App }) => {
    const result = await checkApi();

    for (const operation of result.covered) app.out.human(`ok      ${pad(operation)} ${operation.command}`);
    for (const operation of result.missing) app.out.human(`MISSING ${pad(operation)} ${operation.command}`);
    if (result.requestDrift.length > 0) {
      app.out.human("");
      for (const d of result.requestDrift) {
        const what = d.problem === "gone" ? "not in the server's document" : "required by the server";
        app.out.human(`DRIFT   ${d.id.padEnd(width)} ${d.field}: ${what} (${commandOf(d.id)})`);
      }
    }
    if (result.newOnServer.length > 0) {
      app.out.human("");
      app.out.human(`${result.newOnServer.length} server operations this client does not use yet`);
    }
    app.out.human("");
    app.out.human(
      `${result.covered.length} of ${result.clientOperations} client operations present; server offers ${result.serverOperations}`,
    );

    const missing =
      result.missing.length > 0 ? `${result.missing.length} operation(s) this client calls are missing from the server` : undefined;

    app.out.data({
      ...(missing === undefined ? {} : { error: missing }),
      serverOperations: result.serverOperations,
      clientOperations: result.clientOperations,
      covered: result.covered.map(asReport),
      missing: result.missing.map(asReport),
      newOnServer: result.newOnServer,
      requestDrift: result.requestDrift.map((d) => ({ ...d, command: commandOf(d.id) })),
    } as Json);

    if (missing !== undefined) throw new Error(missing);
  },
};

const commandOf = (id: string): string => OPERATIONS.find((o) => o.id === id)?.command ?? "";

const width = Math.max(...OPERATIONS.map((o) => o.id.length)) + 1;

const pad = (operation: Operation): string => operation.id.padEnd(width);

// The registry entries carry no json tags, so the report prints their field
// names as they are declared rather than in lower case.
const asReport = (operation: Operation): Json => ({
  ID: operation.id,
  Method: operation.method,
  Path: operation.path,
  Command: operation.command,
});
