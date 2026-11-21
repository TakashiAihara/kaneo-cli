import { writeFileSync, writeSync } from "node:fs";
import type { Download } from "../api/kaneo";
import type { App } from "./app";

// A binary reply's bytes, where the caller asked for them: the file --out
// names, or stdout as the raw stream a download is. There is no JSON form of
// the bytes themselves, so the unfiltered answer is the stream.
export const emitDownload = (app: App, out: string, download: Download): void => {
  if (out === "") {
    writeSync(1, download.data);
    return;
  }
  writeFileSync(out, download.data);
  app.out.human(`wrote ${download.data.byteLength} bytes to ${out}`);
  app.out.data({ path: out, bytes: download.data.byteLength, contentType: download.contentType });
};
