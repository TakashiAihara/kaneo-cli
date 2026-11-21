import type { Task } from "../api/kaneo";

// Whether a title already names the work `task create` is about to create again,
// and how alike two titles are worded. `task create` reads the board before it
// writes, because the second copy is the expensive one: it takes a number on the
// board and has to be closed by hand afterwards.

// How alike two titles have to be before a create warns about them. Measured over
// 889 real tasks on 62 boards: of the ten pairs that scored at least this on
// bigrams alone, one was a real duplicate and seven were distinct work —
// "CIC の信用情報開示" against "JICC の信用情報開示" scores 0.92,
// "rss-reader から…" against "dry-reader から…" 0.89. Raising it drops that one
// duplicate and keeps the seven; lowering it flags more pairs, not fewer. Which is
// why the value decides a warning and not a refusal: alike wording cannot tell a
// second copy from the next piece of work, where a shared reference can.
export const SIMILAR_TITLE = 0.6;

// How many of them a warning or a refusal names: enough to recognise the work,
// few enough that the message stays one readable line.
const SIMILAR_REPORTED = 5;

// An issue or task reference inside a title: `name#N` written with no space,
// anywhere in the title, and `name #N` written with one space only inside
// parentheses — "(ccx #165)", "（ccx #165 の後続）", "(ccx #165 and alp #3)".
// Every reference inside one pair of parentheses counts, not only the first.
//
// Measured over 889 real titles: 28 write `name#N`, 50 write `name #N` inside
// parentheses, and 16 write `name #N` elsewhere. Those 16 are a mixture of
// repositories ("ccx #188") with plain words ("PR #314"), so the space is only
// the way a bracketed reference is written and a bare `#N` never names one:
// "Phase #1 design" and "Phase #1 implement" count a phase, not an issue.
//
// The name is then checked rather than only shaped, because the character run
// also covers words and paths: `PR#12`, `Fix#7`, `docs/a.md#12` and
// `…/issues/7#3` are not references (see parseName).
//
// Whatever follows the number is not part of it, so a colon reads the same as
// the space in "ccx#165: crash"; a character of [A-Za-z0-9_] says the number
// runs on into something else and is not a reference at all. A `#` before the
// name means the number already ran into another hash ("ccx#1a#2"), which is
// not a name either.
const REFERENCE = /(?<![A-Za-z0-9_./#-])([A-Za-z0-9_./-]+)#(\d+)(?![A-Za-z0-9_])/g;
const SPACED_REFERENCE = /([A-Za-z0-9_./-]+) #(\d+)(?![A-Za-z0-9_])/g;
const PARENTHESISED = /[（(][^()（）]*/g;

// One reference a title names. The owner is kept beside the repository rather
// than folded into it, since two titles naming different owners are two
// references rather than one seen two ways. owner and repo are lowercased for
// matching; written is the reference as the title wrote it, for the message
// that names it back.
type Reference = { owner: string; repo: string; number: string; written: string };

// Whether both titles name the same reference. Case is ignored, since a slug or
// an owner is written in whatever case the author had, and the numbers are
// compared as written: `alp#12` and `alp#123` are two issues.
//
// An owner is not part of what names an issue, so `TakashiAihara/ccx#165` is the
// reference `ccx#165`; two owners written out and differing are two references,
// since only one of them is the repository the issue was filed in.
export const sameReference = (a: string, b: string): boolean => {
  const mine = references(a);
  return references(b).some((theirs) => mine.some((ours) => isSameReference(ours, theirs)));
};

const isSameReference = (mine: Reference, theirs: Reference): boolean =>
  mine.repo === theirs.repo &&
  mine.number === theirs.number &&
  (mine.owner === "" || theirs.owner === "" || mine.owner === theirs.owner);

// The references a title names, in the order it writes them. The unspaced form
// is matched over the whole title and the spaced one inside each pair of
// parentheses, then merged back by where each was found.
const references = (title: string): Reference[] => {
  const found: { at: number; name: string; number: string; written: string }[] = [];
  for (const match of title.matchAll(REFERENCE)) {
    found.push({ at: match.index ?? 0, name: match[1]!, number: match[2]!, written: match[0]! });
  }
  for (const span of title.matchAll(PARENTHESISED)) {
    for (const match of span[0].matchAll(SPACED_REFERENCE)) {
      found.push({ at: (span.index ?? 0) + (match.index ?? 0), name: match[1]!, number: match[2]!, written: match[0]! });
    }
  }
  return found
    .sort((a, b) => a.at - b.at)
    .map((match) => reference(match))
    .filter((reference): reference is Reference => reference !== undefined);
};

const reference = (match: { name: string; number: string; written: string }): Reference | undefined => {
  const name = parseName(match.name);
  if (name === undefined) return undefined;
  return { ...name, number: match.number, written: match.written };
};

// The name a reference is written with: `repo` or `owner/repo`. A leading
// segment holding a dot is a host name (`github.com/owner/repo`), which is
// dropped since the owner already says whose repository it is. Only the one
// in front is dropped: a second dotted segment is the owner, not another
// host, so `a.b/c.d/repo#7` keeps `c.d/repo` rather than collapsing to a bare
// `repo`. What is left deeper than owner/repo is a path (`docs/a.md#12`,
// `…/issues/7#3`), and a dot in the repository is a file or a domain, not a
// slug.
const parseName = (name: string): { owner: string; repo: string } | undefined => {
  const parts = name.split("/");
  if (parts.length > 1 && parts[0]!.includes(".")) parts.shift();
  if (parts.length > 2 || parts.some((part) => part === "")) return undefined;
  const repo = parts[parts.length - 1]!;
  const owner = parts.length === 2 ? parts[0]! : "";
  if (repo.includes(".")) return undefined;
  if (!repoSlug(repo)) return undefined;
  return { owner: owner.toLowerCase(), repo: repo.toLowerCase() };
};

// Whether the last segment reads as a repository slug rather than an English
// word: a CapitalizedWord is a word ("Fix#7", "Phase #1"), and a short all-caps
// token is an acronym or word ("PR#12") too small to name a repository. Longer
// all-caps names ("ALP#3") and anything with a lowercase letter still can be.
const repoSlug = (repo: string): boolean => {
  if (/^[A-Z][a-z]+$/.test(repo)) return false;
  return /[a-z]/.test(repo) || repo.length >= 3;
};

// The open tasks whose titles name a reference this title also names, with that
// reference as the title wrote it: the pair `task create` refuses on, and at most
// SIMILAR_REPORTED of them, lowest number first, so the same board refuses the
// same way every time. closed is the set of statuses the project's own columns
// mark finished (see closedStatuses), so a task in a final column is the next
// round of work rather than a duplicate.
//
// A title naming several references is refused on the first one it writes, so the
// message names one issue rather than a set of them.
export const sharedReference = (
  title: string,
  tasks: Task[],
  closed: ReadonlySet<string>,
): { reference: string; tasks: Task[] } | undefined => {
  const open = tasks.filter((task) => !closed.has(task.status));
  for (const reference of references(title)) {
    const found = open
      .filter((task) => references(task.title).some((theirs) => isSameReference(reference, theirs)))
      .sort((a, b) => a.number - b.number)
      .slice(0, SIMILAR_REPORTED);
    if (found.length > 0) return { reference: reference.written, tasks: found };
  }
  return undefined;
};

// How alike two titles are: 1 where both name the same issue and where they are
// the same title, and the Dice coefficient over character bigrams otherwise. An
// empty title is unlike anything, including itself.
export const titleSimilarity = (a: string, b: string): number => {
  if (a.trim() === "" || b.trim() === "") return 0;
  return sameReference(a, b) ? 1 : dice(a, b);
};

// The open tasks a warning names: the titles alike enough to this one, most
// similar first and at most SIMILAR_REPORTED of them. closed is the same set
// sharedReference reads, so a task in a final column is not warned about either.
//
// A number breaks a tie, so the same board always names the same task first and
// the warning does not move between runs.
export const similarOpenTasks = (title: string, tasks: Task[], closed: ReadonlySet<string>): Task[] =>
  tasks
    .filter((task) => !closed.has(task.status))
    .map((task) => ({ task, score: titleSimilarity(task.title, title) }))
    .filter((found) => found.score >= SIMILAR_TITLE)
    .sort((a, b) => b.score - a.score || a.task.number - b.task.number)
    .map((found) => found.task)
    .slice(0, SIMILAR_REPORTED);

// Dice's coefficient over character bigrams: the share of the two titles' bigrams
// both hold. Compared as text with whitespace removed and case folded, so "Write
// the Parser" and "write theparser" are one string, and as code points, so a
// title in Japanese is cut into characters rather than half of one.
//
// Two titles folding to the same string are alike in every character, whatever
// their length: a title of one character has no bigrams, and nothing to share
// against nothing would call "x" unlike itself.
const dice = (a: string, b: string): number => {
  const left = folded(a);
  const right = folded(b);
  if (left === right) return 1;
  const mine = bigrams(left);
  const theirs = bigrams(right);
  // A title of one character has no bigrams, so there is nothing to share and
  // nothing to divide by.
  if (mine.size === 0 || theirs.size === 0) return 0;
  let shared = 0;
  for (const [bigram, times] of mine) shared += Math.min(times, theirs.get(bigram) ?? 0);
  return (2 * shared) / (total(mine) + total(theirs));
};

// A title as one string to compare: case folded and stripped of the whitespace
// around its words, since both are how the same title is typed twice.
const folded = (title: string): string => title.toLowerCase().replace(/\s+/g, "");

// Each bigram of a title and how often it appears there. Repeated bigrams are
// counted rather than kept once, since "aaaa" and "aaaaaa" are alike by a share
// of their bigrams and not by a set.
const bigrams = (text: string): Map<string, number> => {
  const chars = [...text];
  const found = new Map<string, number>();
  for (let i = 0; i + 1 < chars.length; i++) {
    const bigram = `${chars[i]!}${chars[i + 1]!}`;
    found.set(bigram, (found.get(bigram) ?? 0) + 1);
  }
  return found;
};

const total = (counts: Map<string, number>): number =>
  [...counts.values()].reduce((sum, times) => sum + times, 0);