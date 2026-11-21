import { downloadAsset } from "../api/kaneo";
import { exactArgs, type RunContext } from "./args";
import type { App } from "./app";
import { emitDownload } from "./download";

export const assetCommand = {
  name: "asset",
  short: "Download an asset's bytes",
  children: [
    {
      name: "get",
      use: "get <asset-id> [--out <file>]",
      short: "Download an asset",
      long:
        "Download an asset's bytes.\n\n" +
        "Without --out the bytes go to stdout as they arrived, which is what a\n" +
        "download is for — they are not JSON, so --json and --jq are refused\n" +
        "there, and so is a terminal: the bytes are the server's to choose and\n" +
        "can carry escape sequences. Redirect to a file (`> out.bin`) or pipe\n" +
        "it on. With --out they are written to the file named, and --json then\n" +
        "reports the path, size and content type rather than the bytes. An\n" +
        "asset of a private project needs the configured key; a public one\n" +
        "does not.",
      args: exactArgs(1),
      flags: [
        {
          name: "out",
          type: "string" as const,
          usage: "write the bytes to this file instead of stdout",
          defaultValue: "",
        },
      ],
      run: async ({ args, flags, changed, app }: RunContext<App>) => {
        await emitDownload(app, "asset get", String(flags.out ?? ""), changed, () => downloadAsset(args[0]!));
      },
    },
  ],
};
