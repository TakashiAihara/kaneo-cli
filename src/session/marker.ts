// Which agent session is working on which task.
//
// Kaneo tasks carry no custom fields, so the association is stored in a task
// comment as a machine-readable marker. The marker's wire format is fixed by
// the Python `kn` that came first: both implementations read the same board
// while one is being replaced by the other, so the format cannot drift.

// The HTML comment carrying the session fields. The prefix is `kn:` rather than
// `kaneo:` because that is what is already written on the board; changing it
// would make existing markers invisible. The body is the lazy match of anything
// up to the terminator, so a field holding "-->" cannot end it early.
const MARKER = /<!--\s*kn:session\s+([\s\S]*?)-->/;

// Where each key=value pair starts inside the marker body. The value is then
// taken as the text between one key and the next, so a value containing spaces
// survives.
const KEY = /(?:^|\s)([a-zA-Z_][a-zA-Z0-9_]*)=/g;

// Prefixes stripped from the free-text line under a marker. The Japanese one is
// what the Python implementation writes.
const NEXT_STEP_LABELS = ["次の一手:", "次の一手：", "next:"];

// Names the flag that says a marker's values are encoded.
const ENCODED = "enc";

// What a session is doing with a task. A marker written by the other
// implementation can hold anything, so this is a union for what this build
// writes and nothing more.
export type State = "running" | "closed";
export const RUNNING: State = "running";
export const CLOSED: State = "closed";

export type Marker = {
  sessionId: string;
  host: string;
  cwd: string;
  branch: string;
  state: string;
  // The free-text line following the marker.
  nextStep: string;
  // The comment's timestamp, used to pick the newest marker for a session. It
  // is not part of the marker itself.
  createdAt: string;
};

const emptyMarker = (createdAt: string): Marker => ({
  sessionId: "",
  host: "",
  cwd: "",
  branch: "",
  state: "",
  nextStep: "",
  createdAt,
});

// Splits a marker body into its key=value pairs.
const parseFields = (body: string): Map<string, string> => {
  const found = [...body.matchAll(KEY)];
  const fields = new Map<string, string>();
  found.forEach((match, i) => {
    // The value runs to the start of the next key, which is where that key's
    // leading whitespace already is, so trimming the slice is enough.
    const end = found[i + 1]?.index ?? body.length;
    fields.set(match[1]!, body.slice(match.index + match[0].length, end).trim());
  });
  return fields;
};

// Renders the marker plus its optional next-step line.
//
// The next step is written as a bare line with no label. The Python reader
// strips an optional `次の一手:` prefix and otherwise takes the line as-is, so
// an unlabelled line reads correctly there while staying language-neutral here.
export const format = (marker: Marker): string => {
  const fields = [
    `id=${encodeValue(marker.sessionId)}`,
    `host=${encodeValue(marker.host)}`,
    `cwd=${encodeValue(marker.cwd)}`,
    `branch=${encodeValue(marker.branch)}`,
    `state=${marker.state}`,
    // enc marks this marker as carrying encoded values. Without it a marker
    // written by the older implementation, which stores values raw, would have a
    // literal %20 in a path silently turned into a space on the way back. The
    // older reader collects key=value pairs into a map and ignores keys it does
    // not know, so the extra field costs it nothing.
    `${ENCODED}=1`,
  ];
  let out = `<!-- kn:session ${fields.join(" ")} -->`;
  const step = marker.nextStep.trim();
  if (step !== "") out += `\n${step}`;
  return out;
};

// Makes a value safe to sit between two space-separated fields.
//
// Whitespace is percent-encoded rather than kept. A value containing a space is
// otherwise indistinguishable from the start of the next field: a path like
// "/work/client foo=bar" would be read back as "/work/client". The Python
// implementation splits the marker body on whitespace, so encoding keeps the
// value in one piece for that reader too — it renders the escapes literally
// where it displays the value, which is cosmetic, rather than truncating it.
//
// The percent sign itself is encoded first so decoding is unambiguous.
const encodeValue = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed === "") return "-";
  let out = "";
  for (const char of trimmed) {
    switch (char) {
      case "%":
        out += "%25";
        break;
      case " ":
        out += "%20";
        break;
      case "\t":
        out += "%09";
        break;
      // Both newline endings are one escape: the reader gives them back a
      // newline either way.
      case "\n":
      case "\r":
        out += "%0A";
        break;
      // Encoded rather than stripped, so that a value containing --> is
      // recovered intact instead of coming back as --.
      case ">":
        out += "%3E";
        break;
      case "<":
        out += "%3C";
        break;
      default:
        out += char;
    }
  }
  return out;
};

// Reverses encodeValue. It is applied only to markers that declare themselves
// encoded, because a raw value may legitimately contain a percent sequence of
// its own.
const decodeValue = (value: string): string =>
  value
    .replaceAll("%20", " ")
    .replaceAll("%09", "\t")
    .replaceAll("%0A", "\n")
    .replaceAll("%3E", ">")
    .replaceAll("%3C", "<")
    .replaceAll("%25", "%");

// Extracts a marker from a comment body, or undefined when the comment carries
// none, which is the normal case for a human comment.
export const parse = (content: string, createdAt: string): Marker | undefined => {
  const found = MARKER.exec(content);
  if (found === null) return undefined;

  const fields = parseFields(found[1]!);
  const encoded = fields.get(ENCODED) === "1";
  const marker = emptyMarker(createdAt);
  for (const [key, raw] of fields) {
    let value = raw === "-" ? "" : raw;
    if (encoded) value = decodeValue(value);
    switch (key) {
      case "id":
        marker.sessionId = value;
        break;
      case "host":
        marker.host = value;
        break;
      case "cwd":
        marker.cwd = value;
        break;
      case "branch":
        marker.branch = value;
        break;
      case "state":
        marker.state = value;
        break;
    }
  }

  // Whatever follows the terminator is the next step, if a label introduced it.
  let trailing = content.slice(found.index + found[0].length).trim();
  for (const label of NEXT_STEP_LABELS) {
    if (!trailing.startsWith(label)) continue;
    trailing = trailing.slice(label.length).trim();
    break;
  }
  marker.nextStep = trailing;

  return marker;
};

// Keeps only the newest marker for each session id.
//
// attach, next and close each append their own comment, so a session leaves a
// trail behind it. Without this, a closed session keeps showing as running and
// appears several times over.
export const latestPerSession = (markers: Marker[]): Marker[] => {
  const latest = new Map<string, Marker>();
  for (const marker of markers) {
    const prev = latest.get(marker.sessionId);
    // Later wins, and an equal timestamp lets the later comment win too: the
    // server stamps one tick apart, so a tie means the same read of the board.
    if (prev === undefined || marker.createdAt >= prev.createdAt) latest.set(marker.sessionId, marker);
  }
  return [...latest.values()].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    if (a.sessionId === b.sessionId) return 0;
    return a.sessionId < b.sessionId ? -1 : 1;
  });
};

// Filters to the sessions still holding a task.
export const running = (markers: Marker[]): Marker[] => markers.filter((m) => m.state === RUNNING);