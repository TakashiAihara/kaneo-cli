import { defineConfig } from "orval";
import { SPEC_PATH } from "./openapi/spec";


export default defineConfig({
  kaneo: {
    input: {
      // The document shipped in the Kaneo release, not the one a deployed
      // instance serves: a public client targets a release, and the build
      // must not depend on the network. Bump with `bun run spec <version>`.
      target: SPEC_PATH,
      // Drops every operation outside src/api/registry.ts.
      override: { transformer: "./openapi/transformer.ts" },
    },
    output: {
      target: "./src/api/gen/kaneo.ts",
      schemas: { path: "./src/api/gen/model", type: "zod" },
      client: "fetch",
      clean: true,
      override: {
        // A failed call throws from kaneoFetch, so callers get the body
        // itself rather than a status union they would all have to unpick.
        fetch: { runtimeValidation: true, includeHttpResponseReturnType: false },
        // The schema reaches kaneoFetch, which validates what the server sent.
        includeZodSchemaInArguments: true,
        mutator: { path: "./src/api/http.ts", name: "kaneoFetch" },
      },
    },
  },
});
