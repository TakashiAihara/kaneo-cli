# A repository mapped to more than one project

Issue: [#5](https://github.com/TakashiAihara/kaneo-cli/issues/5)

## The problem

`repos` was `map[string]string`, so a repository could name exactly one project. A workspace holds any number of projects and one repository can have work on several of them, so the limit was the CLI's type rather than anything Kaneo imposes. A JSON object cannot repeat a key either, so there was no way to write the second one down.

## What changed

- the value of a `repos` entry is a list of project ids, and decodes from a bare string as well
- the resolution chain carries a list of projects instead of one
- `board` shows a section per project
- everything else still acts on one board, and says so when a repository names several

## Why the value decodes from both shapes

Every config written before this holds a bare string, and the file is synced between machines that may not all run the same build. A config that only the newest build can read would break the others silently, on the layer they fall back to when nothing more specific answers.

The same reasoning decides how it is written back. `Save` rewrites the whole file, so widening every entry to a list would edit mappings the run never touched and leave an older build unable to read any of them. A lone id is written as a bare string; a list is written as a list.

## Why only `board` takes several

`board` reads. Every other command writes, or acts on one project's numbering, and a write has to name the board it lands on.

There is nothing to read a default out of. The list states no order of precedence among its entries, so taking the first would send the write to a project nobody chose — the harm the owner map already avoids by supplying a workspace but never a project, and the one the remote parser avoids by refusing a local path. So `kaneo task create` in a repository mapped to several projects reports which they are and asks for `--project`.

`--project` and `KANEO_PROJECT` stay single-valued. They sit above the repo map in the chain, so naming one narrows the list to it, `board` included.

## Where a list can appear

Only in the repo map. A flag, the environment, a `.kaneo.json` and a profile each hold one id, and each contributes a single-element list, so a caller reads one field whichever layer answered. The chain and its precedence are unchanged.

`.kaneo.json` is unchanged for the same reason it was never the problem: it ties a *directory* to a project, so it switches by where you are rather than covering several at once.

## Finished projects

A project is a plan, not a repository, so a repository accumulates finished ones and the board would fill up with them.

They leave the board by being archived. The server already has `archivedAt` and the two endpoints that set it, so `board` filters on that and `kaneo project archive` reaches it. The mapping and every task stay where they were, and unarchive puts the project back.

Editing a finished project out of `repos` would clear the board as well, but removing is not hiding: it loses the record that the repository ever had that work, and there is nothing to undo it with.

The board listing does not carry the flag, so board reads the project itself first — one extra request per mapped project, against the one it already makes per open task.

## What a partial failure does

`board` keeps the projects it could read and reports only when it could read none. A project that is unreachable should not cost the others their board, which is how the same command already treats a task whose comments cannot be read.

An unmapped repository is not a failure at all: it produces nothing and exits 0, unchanged, because that is what tells a session-start hook to stay quiet.
