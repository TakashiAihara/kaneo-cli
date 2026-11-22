import { describe, expect, test } from "bun:test";
import { ancestorPids, inoKey } from "../../src/session/devin";

// dev_t in the encoding glibc's sysmacros.h defines, written out from its
// makedev() so the decode under test is checked against the spec rather than
// against itself: major's low 12 bits sit at dev bits 8-19 and its high 20 at
// bits 44-63; minor's low 8 at bits 0-7 and its high 24 at bits 20-43.
const makedev = (major: bigint, minor: bigint): bigint =>
  ((major & 0xfffn) << 8n) | ((major & 0xfffff000n) << 32n) | (minor & 0xffn) | ((minor & 0xffffff00n) << 12n);

// The majors used here keep dev under 2^53, so Number() is exact the way
// stat's st_dev is.
const key = (major: bigint, minor: bigint): string => inoKey({ dev: Number(makedev(major, minor)), ino: 424242 });

describe("inoKey", () => {
  // An ordinary device: both fields fit their low bits, so any decode works.
  test("decodes a small major and minor", () => {
    expect(key(252n, 6n)).toBe("fc:06:424242");
  });

  // Minor bits 8-11 sit at dev bits 20-23. A mask keeping only dev bits 24+
  // drops them: minor 0x106 must not come back as 0x6.
  test("keeps minor bits 8-11", () => {
    expect(key(8n, 0x106n)).toBe("08:106:424242");
    expect(key(0x1234n, 0x12345n)).toBe("1234:12345:424242");
  });

  // Major bits 12+ sit at dev bits 44+. A mask that wide on the shifted dev
  // leaks them into the minor: major 5000 must not come back as minor
  // 0x100000006.
  test("keeps major bits 12 and up out of the minor", () => {
    expect(key(5000n, 6n)).toBe("1388:06:424242");
    expect(key(0x12345n, 0x12345n)).toBe("12345:12345:424242");
  });
});

// The walk reads the real /proc, so it can only be checked where /proc exists.
// PID 1 ends the chain — a lock it holds is still an ancestor's — so it must
// be the last pid the walk returns.
describe("ancestorPids", () => {
  test.skipIf(process.platform !== "linux")("the walk reaches PID 1", () => {
    const pids = ancestorPids();
    expect(pids.length).toBeGreaterThan(0);
    expect(pids.at(-1)).toBe(1);
  });
});
