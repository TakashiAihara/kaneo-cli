import createClient, { type Middleware } from "openapi-fetch";
import type { paths } from "./schema";
import type { ResolvedConfig } from "../config";

export type ApiClient = ReturnType<typeof createClient<paths>>;

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
    message: string,
  ) {
    super(message);
  }
}

export function makeClient(config: ResolvedConfig): ApiClient {
  const client = createClient<paths>({ baseUrl: config.url });
  const auth: Middleware = {
    onRequest({ request }) {
      request.headers.set("Authorization", `Bearer ${config.token}`);
      return request;
    },
  };
  client.use(auth);
  return client;
}

// openapi-fetch は { data, error, response } を返す。コマンド側で毎回3分岐すると
// エラー整形が散らばるので、ここで throw に寄せて data だけ返す
export function unwrap<T>(result: {
  data?: T;
  error?: unknown;
  response: Response;
}): T {
  if (result.response.ok) return result.data as T;
  const status = result.response.status;
  const detail = formatErrorBody(result.error);
  const hint =
    status === 401
      ? " (check your token: --token / KANEO_TOKEN / config profile)"
      : status === 404
        ? " (not found — check the id, or your Kaneo instance may be older than this CLI)"
        : "";
  throw new ApiError(status, result.error, `API error ${status}${detail}${hint}`);
}

function formatErrorBody(error: unknown): string {
  if (error == null) return "";
  if (typeof error === "string") return `: ${error}`;
  if (typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return `: ${message}`;
    return `: ${JSON.stringify(error)}`;
  }
  return "";
}
