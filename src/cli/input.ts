// Text a command was given somewhere other than its command line.
//
// A description or a comment is often longer than a shell argument is happy to
// hold, and it is usually already in a file: a note, a heredoc, the output of a
// command. So a lone `-` stands for stdin and anything else names a file.
//
// What comes back is the text that was read, untrimmed: a description that ends
// in a newline ends in one, because trimming text nobody asked to trim is how a
// file's exact contents turn into something else.
//
// The bytes are decoded here rather than by Bun's own text(), which turns an
// invalid byte into U+FFFD and reads a file starting FF FE as UTF-16. Each of
// those stores a different text from the one that was given, and a byte that is
// not UTF-8 at all is refused rather than stored as a replacement character
// nobody typed.
//
// One leading BOM is the single exception to byte for byte: it is what an
// editor writes to mark the encoding, and a text that begins with one is a
// heading or a paragraph of somebody's prose rather than text that begins with
// an invisible character. Anywhere else it is an ordinary character and stays.

// What the text is called when it is reported: `-` on a command line is stdin,
// and a message has to say which of the two was meant. A path that is not there
// is quoted, or the message reads as a complaint about a space.
export const sourceName = (source: string): string =>
  source === "-" ? "stdin" : source === "" ? '""' : source;

// fatal turns a byte that is not UTF-8 into an error instead of a U+FFFD that
// hides which byte it was. ignoreBOM leaves a BOM as the character it decodes
// to, so the one at the front can be recognised as a signature and taken off
// rather than the decoder taking it off for good.
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export const readInput = async (source: string): Promise<string> => {
  const named = sourceName(source);
  let bytes: Uint8Array;
  try {
    bytes = source === "-" ? await Bun.stdin.bytes() : await Bun.file(source).bytes();
  } catch (e) {
    throw new Error(`reading ${named}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    throw new Error(`reading ${named}: not valid UTF-8`);
  }
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
};
