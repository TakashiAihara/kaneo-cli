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
        "download is for; with it they are written to the file named. An asset\n" +
        "of a private project needs the configured key; a public one does not.",
      args: exactArgs(1),
      flags: [
        {
          name: "out",
          type: "string" as const,
          usage: "write the bytes to this file instead of stdout",
          defaultValue: "",
        },
      ],
      run: async ({ args, flags, app }: RunContext<App>) => {
        emitDownload(app, String(flags.out ?? ""), await downloadAsset(args[0]!));
      },
    },
  ],
};
