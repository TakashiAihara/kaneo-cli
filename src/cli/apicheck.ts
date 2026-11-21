import type { App } from "./app";
import { checkApi } from "../api/kaneo";
import { OPERATIONS, type Operation } from "../api/registry";
import type { Json } from "../output/json";

// Compares what this client calls against what the server offers.
//
// It exits non-zero when an operation this client uses is missing from the
// server, or when a request field a call can send differs from the server's
// document, so it can gate a release. Reporting a problem and exiting 0 would
// make the check unusable in CI, which is the whole reason to have it. The
// drift side is only as precise as the neverSent / alwaysSent declarations
// behind clientShapes (api/registry.ts): a wrong one hides real drift rather
// than inventing it.
export const apiCheckCommand = {
  name: "api-check",
  short: "Check this client's operations against the server's OpenAPI document",
  long:
    "Check this client's operations against the server's OpenAPI document.\n\n" +
    "Exits non-zero when the server is missing an operation this client calls,\n" +
    "or when a request field a call can send differs from the server's document\n" +
    "(DRIFT). Also lists the operations the pinned document serves that the\n" +
    "server's does not, which do not change the exit status.\n" +
    "The document needs no authentication, so this works before a key is set.",
  args: (args: string[]) => {
    const first = args[0];
    if (first !== undefined) {
      throw new Error(`unknown command ${JSON.stringify(first)} for "kaneo api-check"`);
    }
  },
  run: async ({ app }: { app: App }) => {
    const result = await checkApi();

    // The counts lead: the lists below name only what needs attention, and the
    // full operation lists are the --json document's job.
    app.out.human(
      `server ${result.serverOperations} operations; client ${result.clientOperations}; ` +
        `covered ${result.covered.length}; missing ${result.missing.length}; ` +
        `newOnServer ${result.newOnServer.length}; drift ${result.requestDrift.length}; ` +
        `notOnServer ${result.notOnServer.length}`,
    );
    for (const operation of result.missing) app.out.human(`MISSING ${pad(operation)} ${operation.command}`);
    if (result.requestDrift.length > 0) {
      app.out.human("");
      for (const d of result.requestDrift) {
        const what = d.problem === "gone" ? "not in the server's document" : "required by the server";
        app.out.human(`DRIFT   ${d.id.padEnd(width)} ${d.field}: ${what} (${commandOf(d.id)})`);
      }
    }
    if (result.notOnServer.length > 0) {
      app.out.human("");
      app.out.human(`${result.notOnServer.length} operations the pinned document serves that the server does not:`);
      for (const o of result.notOnServer) app.out.human(`  ${o.method.padEnd(6)} ${o.path}  ${o.id}`);
    }

    const failures: string[] = [];
    if (result.missing.length > 0) {
      failures.push(`${result.missing.length} operation(s) this client calls are missing from the server`);
    }
    if (result.requestDrift.length > 0) {
      failures.push(`${result.requestDrift.length} request field(s) differ from what this client sends`);
    }
    const failure = failures.length > 0 ? new Error(failures.join("; ")) : undefined;

    try {
      app.out.data({
        serverOperations: result.serverOperations,
        clientOperations: result.clientOperations,
        covered: result.covered.map(asReport),
        missing: result.missing.map(asReport),
        // The keys covered and missing have, with Command always empty since
        // nothing calls these yet, and Tag added: the document's first tag.
        newOnServer: result.newOnServer.map((o) => ({ ID: o.id, Method: o.method, Path: o.path, Command: "", Tag: o.tag })),
        // The same shape, with Command filled where the registry knows one:
        // an operation the client calls is in missing already, and the rest
        // are what a server upgrade can make available.
        notOnServer: result.notOnServer.map((o) => ({
          ID: o.id,
          Method: o.method,
          Path: o.path,
          Command: commandOf(o.id),
          Tag: o.tag,
        })),
        requestDrift: result.requestDrift.map((d) => ({ ...d, command: commandOf(d.id) })),
      } as Json);
    } catch (e) {
      // A failure to write the report (a filter that fails) ends the command in
      // its own error, which would otherwise hide the finding this command
      // exists to report.
      if (failure !== undefined) app.out.error(failure.message);
      throw e;
    }

    if (failure !== undefined) throw failure;
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
