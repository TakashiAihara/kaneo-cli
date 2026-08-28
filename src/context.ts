import type { Command } from "commander";
import { resolveConfig, type GlobalFlags, type ResolvedConfig } from "./config";
import { makeClient, type ApiClient } from "./api/client";

export type Context = {
  client: ApiClient;
  config: ResolvedConfig;
  flags: GlobalFlags;
};

// commander の action 内で毎回 config 解決 + client 生成を書かないための入口。
// 解決はコマンド実行時まで遅延させる (--help やコマンド名ミスで認証エラーを出さない)
export function getContext(cmd: Command): Context {
  const flags = cmd.optsWithGlobals<GlobalFlags>();
  const config = resolveConfig(flags);
  return { client: makeClient(config), config, flags };
}
