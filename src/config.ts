import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Profile = {
  url?: string;
  token?: string;
  workspace?: string;
};

export type ConfigFile = {
  defaultProfile?: string;
  profiles?: Record<string, Profile>;
};

export type ResolvedConfig = {
  url: string;
  token: string;
  // どこから解決されたかをエラーメッセージと `kaneo config` 表示に使う
  urlSource: "flag" | "env" | "profile";
  tokenSource: "flag" | "env" | "profile";
  profileName?: string;
  // url/token と違い必須ではない。無くても resolve 時点では通し、要る場面で requireWorkspace が言う
  workspace?: string;
};

export type GlobalFlags = {
  url?: string;
  token?: string;
  profile?: string;
  workspace?: string;
  json?: boolean;
};

export function configPath(): string {
  const base =
    process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME !== ""
      ? process.env.XDG_CONFIG_HOME
      : join(homedir(), ".config");
  return join(base, "kaneo", "config.json");
}

export function loadConfigFile(path = configPath()): ConfigFile {
  if (!existsSync(path)) return {};
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    throw new ConfigError(`config file unreadable: ${path} (${(e as Error).message})`);
  }
  try {
    return JSON.parse(raw) as ConfigFile;
  } catch {
    // 壊れた config を黙って空扱いにすると「なぜか認証が効かない」になるので fail-closed
    throw new ConfigError(`config file is not valid JSON: ${path}`);
  }
}

export class ConfigError extends Error {}

export function resolveConfig(flags: GlobalFlags, file = loadConfigFile()): ResolvedConfig {
  const requestedProfile = flags.profile ?? process.env.KANEO_PROFILE ?? file.defaultProfile;
  const profileName = requestedProfile ?? "default";
  const profile = file.profiles?.[profileName];

  // 明示的に名指しされた profile が無いのは設定ミスなので、後段の "no URL" に化けさせず即座に言う。
  // 暗黙の "default" フォールバックだけは合成名なので黙って続行してよい
  if (requestedProfile && !profile) {
    throw new ConfigError(`profile not found in ${configPath()}: ${requestedProfile}`);
  }

  let url: string | undefined;
  let urlSource: ResolvedConfig["urlSource"] = "profile";
  if (flags.url) {
    url = flags.url;
    urlSource = "flag";
  } else if (process.env.KANEO_URL) {
    url = process.env.KANEO_URL;
    urlSource = "env";
  } else {
    url = profile?.url;
  }

  let token: string | undefined;
  let tokenSource: ResolvedConfig["tokenSource"] = "profile";
  if (flags.token) {
    token = flags.token;
    tokenSource = "flag";
  } else if (process.env.KANEO_TOKEN) {
    token = process.env.KANEO_TOKEN;
    tokenSource = "env";
  } else {
    token = profile?.token;
  }

  if (!url) {
    throw new ConfigError(
      `no Kaneo URL configured. Pass --url, set KANEO_URL, or add a profile to ${configPath()}`,
    );
  }
  if (!token) {
    throw new ConfigError(
      `no API token configured. Pass --token, set KANEO_TOKEN, or add a profile to ${configPath()}`,
    );
  }

  const workspace = flags.workspace ?? process.env.KANEO_WORKSPACE ?? profile?.workspace;

  return { url: normalizeUrl(url), token, urlSource, tokenSource, profileName, workspace };
}

// project / workspace / search など workspace が要るコマンドから呼ぶ。
// resolveConfig 自体は workspace 無しでも通すので、必要な場所でだけ throw する
export function requireWorkspace(config: ResolvedConfig): string {
  if (!config.workspace) {
    throw new ConfigError(
      'no workspace configured. Pass --workspace, set KANEO_WORKSPACE, or add "workspace" to your profile',
    );
  }
  return config.workspace;
}

// 受け付ける形: https://kaneo.example.com / https://kaneo.example.com/ / .../api
// API の base path は常に /api 配下なので、どの形で渡されても <origin>/api に揃える
export function normalizeUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ConfigError(`invalid URL: ${url}`);
  }
  let path = u.pathname.replace(/\/+$/, "");
  if (!path.endsWith("/api")) path = `${path}/api`;
  return `${u.origin}${path}`;
}
