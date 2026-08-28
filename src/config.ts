import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Profile = {
  url?: string;
  token?: string;
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
};

export type GlobalFlags = {
  url?: string;
  token?: string;
  profile?: string;
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
  const profileName = flags.profile ?? process.env.KANEO_PROFILE ?? file.defaultProfile ?? "default";
  const profile = file.profiles?.[profileName];

  if (flags.profile && !profile) {
    throw new ConfigError(`profile not found in ${configPath()}: ${flags.profile}`);
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

  return { url: normalizeUrl(url), token, urlSource, tokenSource, profileName };
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
