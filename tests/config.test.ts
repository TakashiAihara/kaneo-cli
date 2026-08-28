import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfigFile, normalizeUrl, requireWorkspace, resolveConfig } from "../src/config";

const FILE = {
  defaultProfile: "home",
  profiles: {
    home: { url: "https://kaneo.example.com", token: "profile-token" },
    work: { url: "https://work.example.com", token: "work-token" },
  },
};

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const noEnv = {
  KANEO_URL: undefined,
  KANEO_TOKEN: undefined,
  KANEO_PROFILE: undefined,
  KANEO_WORKSPACE: undefined,
};

describe("resolveConfig precedence", () => {
  test("flag beats env and profile", () => {
    withEnv({ ...noEnv, KANEO_URL: "https://env.example.com", KANEO_TOKEN: "env-token" }, () => {
      const c = resolveConfig({ url: "https://flag.example.com", token: "flag-token" }, FILE);
      expect(c.url).toBe("https://flag.example.com/api");
      expect(c.token).toBe("flag-token");
      expect(c.urlSource).toBe("flag");
      expect(c.tokenSource).toBe("flag");
    });
  });

  test("env beats profile", () => {
    withEnv({ ...noEnv, KANEO_URL: "https://env.example.com", KANEO_TOKEN: "env-token" }, () => {
      const c = resolveConfig({}, FILE);
      expect(c.url).toBe("https://env.example.com/api");
      expect(c.token).toBe("env-token");
      expect(c.urlSource).toBe("env");
    });
  });

  test("defaultProfile is used when nothing else is given", () => {
    withEnv(noEnv, () => {
      const c = resolveConfig({}, FILE);
      expect(c.url).toBe("https://kaneo.example.com/api");
      expect(c.token).toBe("profile-token");
      expect(c.profileName).toBe("home");
    });
  });

  test("--profile selects a named profile", () => {
    withEnv(noEnv, () => {
      const c = resolveConfig({ profile: "work" }, FILE);
      expect(c.url).toBe("https://work.example.com/api");
      expect(c.token).toBe("work-token");
    });
  });

  test("--profile with unknown name fails instead of silently falling back", () => {
    withEnv(noEnv, () => {
      expect(() => resolveConfig({ profile: "nope" }, FILE)).toThrow(ConfigError);
    });
  });

  test("missing url fails with a hint", () => {
    withEnv(noEnv, () => {
      expect(() => resolveConfig({}, {})).toThrow(/no Kaneo URL/);
    });
  });

  test("missing token fails with a hint", () => {
    withEnv(noEnv, () => {
      expect(() =>
        resolveConfig({}, { profiles: { default: { url: "https://x.example.com" } } }),
      ).toThrow(/no API token/);
    });
  });
});

describe("normalizeUrl", () => {
  test.each([
    ["https://kaneo.example.com", "https://kaneo.example.com/api"],
    ["https://kaneo.example.com/", "https://kaneo.example.com/api"],
    ["https://kaneo.example.com/api", "https://kaneo.example.com/api"],
    ["https://kaneo.example.com/api/", "https://kaneo.example.com/api"],
    ["http://localhost:5173", "http://localhost:5173/api"],
    ["https://host.example.com/sub/path", "https://host.example.com/sub/path/api"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeUrl(input)).toBe(expected);
  });

  test("rejects a non-URL", () => {
    expect(() => normalizeUrl("not a url")).toThrow(ConfigError);
  });
});

describe("loadConfigFile", () => {
  test("missing file is an empty config", () => {
    expect(loadConfigFile("/nonexistent/kaneo/config.json")).toEqual({});
  });

  test("broken JSON fails closed instead of being treated as empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "kaneo-test-"));
    const path = join(dir, "config.json");
    writeFileSync(path, "{broken");
    expect(() => loadConfigFile(path)).toThrow(/not valid JSON/);
  });
});

describe("missing profile names (CR finding: point at the right cause)", () => {
  test("KANEO_PROFILE naming a missing profile fails as profile-not-found", () => {
    withEnv({ ...noEnv, KANEO_PROFILE: "ghost" }, () => {
      expect(() => resolveConfig({}, FILE)).toThrow(/profile not found/);
    });
  });

  test("defaultProfile naming a missing profile fails as profile-not-found", () => {
    withEnv(noEnv, () => {
      expect(() => resolveConfig({}, { defaultProfile: "ghost", profiles: {} })).toThrow(
        /profile not found/,
      );
    });
  });

  test("implicit default profile missing stays silent and reports missing URL", () => {
    withEnv(noEnv, () => {
      expect(() => resolveConfig({}, { profiles: { other: { url: "https://x.example.com" } } })).toThrow(
        /no Kaneo URL/,
      );
    });
  });
});

describe("workspace resolution", () => {
  const FILE_WITH_WORKSPACE = {
    defaultProfile: "home",
    profiles: {
      home: { url: "https://kaneo.example.com", token: "profile-token", workspace: "w-profile" },
    },
  };

  test("missing workspace is not an error at resolve time", () => {
    withEnv(noEnv, () => {
      const c = resolveConfig({}, FILE);
      expect(c.workspace).toBeUndefined();
    });
  });

  test("--workspace flag beats env and profile", () => {
    withEnv({ ...noEnv, KANEO_WORKSPACE: "w-env" }, () => {
      const c = resolveConfig(
        { url: "https://kaneo.example.com", token: "t", workspace: "w-flag" },
        FILE_WITH_WORKSPACE,
      );
      expect(c.workspace).toBe("w-flag");
    });
  });

  test("KANEO_WORKSPACE env beats profile", () => {
    withEnv({ ...noEnv, KANEO_WORKSPACE: "w-env" }, () => {
      const c = resolveConfig({}, FILE_WITH_WORKSPACE);
      expect(c.workspace).toBe("w-env");
    });
  });

  test("falls back to the profile's workspace", () => {
    withEnv(noEnv, () => {
      const c = resolveConfig({}, FILE_WITH_WORKSPACE);
      expect(c.workspace).toBe("w-profile");
    });
  });
});

describe("requireWorkspace", () => {
  test("returns the resolved workspace when present", () => {
    withEnv({ ...noEnv, KANEO_WORKSPACE: "w-env" }, () => {
      const c = resolveConfig({}, FILE);
      expect(requireWorkspace(c)).toBe("w-env");
    });
  });

  test("throws a ConfigError with a hint when absent", () => {
    withEnv(noEnv, () => {
      const c = resolveConfig({}, FILE);
      expect(() => requireWorkspace(c)).toThrow(ConfigError);
      expect(() => requireWorkspace(c)).toThrow(/no workspace configured/);
    });
  });
});
