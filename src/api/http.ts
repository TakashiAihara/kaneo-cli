import type { ZodType } from "zod";

// The transport under the generated client. Every generated call goes through
// kaneoFetch, so the key is checked, attached and reported on the same way for
// every operation, and every response is validated against the schema the
// generator passes in. Behaviour is pinned by tests/http.test.ts.
export type KaneoInit<T> = RequestInit & { schema?: ZodType<T> };

export const kaneoFetch = async <T>(url: string, init: KaneoInit<T>): Promise<T> => {
  throw new Error(`not implemented: ${init.method ?? "GET"} ${url}`);
};
