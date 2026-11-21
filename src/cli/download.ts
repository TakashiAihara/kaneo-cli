import { writeFileSync, writeSync } from "node:fs";
import type { Download } from "../api/kaneo";
import type { App } from "./app";

// A binary reply's bytes, where the caller asked for them: the file --out
// names, or stdout as the raw stream a download is.
//
// The stdout form is the bytes or nothing, so the cases that cannot keep that
// promise are refused before the fetch that would answer them: --json and
// --jq have no JSON document to work on, and a terminal is not a sink for the
// server's bytes, which can carry escape sequences. --out is exempt — the
// file takes the bytes and stdout keeps its JSON report of them.
export const emitDownload = async (
  app: App,
  command: string,
  out: string,
  changed: ReadonlySet<string>,
  get: () => Promise<Download>,
): Promise<void> => {
  if (out === "") {
    // There is no JSON form of the bytes themselves, so asking for one is
    // refused rather than silently answered with bytes a filter cannot read.
    // An empty --jq is no expression at all, the same as everywhere else.
    if (changed.has("json") || app.out.filter !== undefined) {
      throw new Error(`--json and --jq do not apply to ${command} without --out; the bytes are written to stdout as they arrive`);
    }
    // The bytes are the server's to choose, so a terminal is refused them the
    // way curl refuses binary output: an asset can be anything, and only a
    // file or a pipe should get it.
    if (app.out.terminal) {
      throw new Error("refusing to write the bytes to a terminal; redirect them to a file (`> out.bin`) or pipe them on");
    }
    // stdout is the bytes or nothing, so an error object has no place in a
    // file the bytes are being redirected into: failures are stderr-only from
    // here on, the read's included.
    app.out.dataOnly();
  }
  const download = await get();
  if (out !== "") {
    writeFileSync(out, download.data);
    app.out.human(`wrote ${download.data.byteLength} bytes to ${out}`);
    app.out.data({ path: out, bytes: download.data.byteLength, contentType: download.contentType });
    return;
  }
  // The bytes go out as they arrived: a download is not text, so nothing here
  // may decode or re-encode it. writeSync reports the bytes it took, which on
  // a pipe can be fewer than it was given, so the rest goes out until the
  // download is whole; a write that takes nothing is a failure rather than a
  // silently cut file.
  const bytes = download.data;
  for (let offset = 0; offset < bytes.byteLength; ) {
    const written = writeSync(1, bytes, offset, bytes.byteLength - offset);
    if (written === 0) throw new Error(`stdout accepted none of the remaining ${bytes.byteLength - offset} bytes`);
    offset += written;
  }
};
