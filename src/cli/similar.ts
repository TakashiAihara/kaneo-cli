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
export const SIMILAR_REPORTED = 5;

// Statuses holding finished or filed-away work, so a title repeating one of them
// is the next round of it rather than a duplicate. planned is not among them:
// work nobody has picked up is open backlog, and a task created beside it joins
// that backlog rather than repeating it.
const CLOSED_STATUSES = ["done", "archived"];

// An issue or task reference inside a title: `name#N` written with no space,
// anywhere in the title, and `name #N` written with one space only where the name
// comes right after an opening parenthesis — "(ccx #165)", "（ccx #165 の後続）".
// The name is a run of [A-Za-z0-9_./-], so an owner and a repository are one run
// and `TakashiAihara/ccx#165` is read as the owner and the repository.
//
// Measured over 889 real titles: 28 write `name#N`, 50 write `(name #N` right
// after a parenthesis, and 16 write `name #N` elsewhere. Those 16 are a mixture
// of repositories ("ccx #188") with plain words ("PR #314"), so the space is
// only the way a bracketed reference is written and a bare `#N` never names one:
// "Phase #1 design" and "Phase #1 implement" count a phase, not an issue.
//
// Whatever follows the number is not part of it, so a colon reads the same as
// the space in "ccx#165: crash"; a character of [A-Za-z0-9_] says the number
// runs on into something else and is not a reference at all.
const REFERENCE = /(?<![A-Za-z0-9_./-])([A-Za-z0-9_./-]+)#(\d+)(?![A-Za-z0-9_])/g;
const BRACKETED_REFERENCE = /(?<=[(（])([A-Za-z0-9_./-]+) #(\d+)(?![A-Za-z0-9_])/g;

// One reference a title names. The owner is kept beside the repository rather
// than folded into it, since two titles naming different owners are two
// references rather than one seen two ways.
type Reference = { owner: string; repo: string; number: string };

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

// The references a title names, in the order it writes them. The two forms are
// matched separately and merged back by where each was found, so the first
// reference of a title is the first one it writes.
const references = (title: string): Reference[] =>
  [...title.matchAll(REFERENCE), ...title.matchAll(BRACKETED_REFERENCE)]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((match) => {
      const name = match[1]!.toLowerCase();
      const at = name.lastIndexOf("/");
      return { owner: at < 0 ? "" : name.slice(0, at), repo: name.slice(at + 1), number: match[2]! };
    });

// A reference as the title being created wrote it, since an owner it left out is
// not one the message should invent: `ccx#165`, or `takashiaihara/ccx#165` where
// that title wrote the owner out.
const asWritten = (reference: Reference): string =>
  reference.owner === ""
    ? `${reference.repo}#${reference.number}`
    : `${reference.owner}/${reference.repo}#${reference.number}`;

// The open tasks whose titles name a reference this title also names, with that
// reference as the title wrote it: the pair `task create` refuses on, and at most
// SIMILAR_REPORTED of them, lowest number first, so the same board refuses the
// same way every time.
//
// A title naming several references is refused on the first one it writes, so the
// message names one issue rather than a set of them.
export const sharedReference = (
  title: string,
  tasks: Task[],
): { reference: string; tasks: Task[] } | undefined => {
  const open = tasks.filter((task) => !CLOSED_STATUSES.includes(task.status));
  for (const reference of references(title)) {
    const found = open
      .filter((task) => references(task.title).some((theirs) => isSameReference(reference, theirs)))
      .sort((a, b) => a.number - b.number)
      .slice(0, SIMILAR_REPORTED);
    if (found.length > 0) return { reference: asWritten(reference), tasks: found };
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
// similar first and at most SIMILAR_REPORTED of them.
//
// A number breaks a tie, so the same board always names the same task first and
// the warning does not move between runs.
export const similarOpenTasks = (title: string, tasks: Task[]): Task[] =>
  tasks
    .filter((task) => !CLOSED_STATUSES.includes(task.status))
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