import type { Command } from "commander";
import { getContext } from "../context";
import { unwrap } from "../api/client";
import { printJson } from "../output";

type Session = {
  user?: { id?: string; name?: string; email?: string };
  session?: { activeOrganizationId?: string };
};

export function registerWhoami(program: Command): void {
  program
    .command("whoami")
    .description("Show the authenticated user for the configured Kaneo instance")
    .action(async (_opts, cmd: Command) => {
      const { client, config, flags } = getContext(cmd);
      const result = await client.GET("/auth/get-session");
      const session = unwrap<Session | null>(result);
      if (!session?.user) {
        // get-session は未認証でも 200/null を返すので、これだけでは token の有効性を判定できない。
        // 認証必須のエンドポイントを 1 つ叩いて 401 を弾く (無効 token はここで ApiError になる)
        unwrap(await client.GET("/notification"));
      }
      if (flags.json) {
        printJson(session);
        return;
      }
      if (!session?.user) {
        console.log(`authenticated against ${config.url} (API key; no session user)`);
        return;
      }
      console.log(`${session.user.name ?? "?"} <${session.user.email ?? "?"}> @ ${config.url}`);
    });
}
