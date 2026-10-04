import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInput } from "../../src/cli/input";

describe("readInput", () => {
  const dir = mkdtempSync(join(tmpdir(), "kaneo-input-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const at = (name: string, text: string | Uint8Array) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };

  // A description or a comment is written to be stored, so what was written is
  // what has to arrive: a trailing newline belongs to it, and dropping it would
  // write text nobody typed.
  test("a file is read as it was written", async () => {
    expect(await readInput(at("body.md", "# Heading\n\n$HOME and `ticks`\n"))).toBe(
      "# Heading\n\n$HOME and `ticks`\n",
    );
    expect(await readInput(at("one-line.txt", "no newline at the end"))).toBe("no newline at the end");
  });

  test("characters outside ASCII are read as themselves", async () => {
    expect(await readInput(at("utf8.txt", "日本語 émoji 🎉"))).toBe("日本語 émoji 🎉");
  });

  // A leading BOM is what an editor writes to mark the encoding, not a
  // character of the text: kept, it makes a file that opens with "# Heading" a
  // paragraph instead of a heading.
  test("a leading UTF-8 BOM is dropped", async () => {
    expect(await readInput(at("bom.md", new Uint8Array([0xef, 0xbb, 0xbf, 0x61])))).toBe("a");
    expect(await readInput(at("bom-heading.md", "\uFEFF# Heading\n"))).toBe("# Heading\n");
  });

  // Anywhere but the front it is an ordinary character, and one the writer put
  // there, so it is stored as it was typed like any other.
  test("a U+FEFF that is not leading is kept", async () => {
    expect(await readInput(at("inner-bom.txt", "a\uFEFFb"))).toBe("a\uFEFFb");
  });

  // Refused rather than stored as U+FFFD: a description with a replacement
  // character in it is a description that is not what was written, and nothing
  // about it says which byte was lost.
  test("bytes that are not UTF-8 are refused", async () => {
    const path = join(dir, "latin1.md");
    writeFileSync(path, new Uint8Array([0x61, 0xff, 0x62]));
    await expect(readInput(path)).rejects.toThrow(`reading ${path}: not valid UTF-8`);
  });

  // FF FE is UTF-16LE's byte order mark, which is not UTF-8, so this is the
  // other way of writing the same mistake rather than a UTF-16 file to decode.
  test("a UTF-16 byte order mark is not read as UTF-16", async () => {
    const path = join(dir, "utf16.md");
    writeFileSync(path, new Uint8Array([0xff, 0xfe, 0x41, 0x00]));
    await expect(readInput(path)).rejects.toThrow(`reading ${path}: not valid UTF-8`);
  });

  // Without the path the message is a complaint about the process rather than
  // about the command line, which is where the mistake was. The reason after the
  // colon is what tells a wrong path from a file that could not be read.
  test("a path that cannot be read is named", async () => {
    const missing = join(dir, "nope.md");
    const message = await readInput(missing).then(
      () => "",
      (why: Error) => why.message,
    );
    expect(message.startsWith(`reading ${missing}: `)).toBe(true);
    expect(message.slice(`reading ${missing}: `.length)).not.toBe("");
  });
});
