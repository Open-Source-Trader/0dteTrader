# CLAUDE.md

## Project Quick Reference

**What this is:** 0dteTrader — a rapid options trading app (iOS + desktop) backed by Webull OpenAPI and Tradier.

**Build & verify:**

```bash
npm run setup          # first time only
npm run dev:all        # API + desktop concurrently
npm run build          # full build (shared-types → API → desktop)
npm run test           # all workspace tests
npm run lint           # ESLint all workspaces
npm run format:check   # Prettier
```

**iOS (from `apps/ios/`):**

```bash
xcodegen && xcodebuild build -scheme 0dteTrader -destination 'platform=iOS Simulator,name=iPhone 16 Pro'
```

**Key facts:**

- npm workspaces monorepo: `apps/api` (NestJS), `apps/desktop` (React+Vite), `packages/shared-types`
- iOS is separate (XcodeGen + SwiftPM). Module name: `ZeroDTETrader`
- Docker required (Postgres 16 + Redis 7): `npm run db:up`
- Secrets in `.env` (gitignored) — never commit credentials
- Desktop is the reference UI; iOS copies its layout behavior
- See `AGENTS.md` for full architecture and conventions

---

# Field Notes on Getting a Language Model to Write Code You Will Not Rewrite

_A Short List of Rules, Earned by Watching the Same Mistakes Twice_

**Abstract.** _This file exists because language models make predictable mistakes when they write code. Not random mistakes, just the same ones, over and over, often enough that it was worth writing them down. What follows is not a set of suggestions but a set of rules. The throughline is the same in every section: the model is fast at generating plausible code and slow to notice that plausible is not the same as correct, so the discipline has to come from the process around it._

**Index Terms.** _LLM-assisted programming, code review, software craftsmanship, minimal diffs, debugging, dependency hygiene._

## I. READ BEFORE YOU WRITE

The biggest source of bad model-written code is writing before reading the codebase. Read the files you are about to touch; read, not skim. Copy the patterns that already exist, and check the imports to see what the project actually depends on, so you do not reach for axios where everything is fetch. When you cannot find a pattern, ask instead of guessing.

## II. THINK BEFORE YOU CODE

Figure out what you are doing before you type. State your assumptions ("add authentication" is five different things, so name the one you picked) and name the tradeoffs. If something is genuinely confusing, stop and ask rather than filling the gap with plausible-looking code; that is exactly the code that passes a casual review and fails when it matters.

## III. SIMPLICITY

Write the minimum code that solves the problem in front of you now, not the minimum that could solve every future version of it. Resist premature abstraction, skip error handling for errors that cannot occur, and hardcode values until there is a real reason to configure them. The test: if the only reason something is abstracted is "in case we need to," you have over-built it.

## IV. SURGICAL CHANGES

Your diff should be as small as the task allows. Do not touch what you were not asked to touch, match the existing style, and do not reformat; a formatter pass buries the three lines that matter inside three hundred that do not. The test is whether you can justify every changed line by the task. If a line is there because "while I was in there," revert it.

## V. VERIFICATION

The gap between code that works and code you think works is testing. When fixing a bug, write the failing test first, watch it fail, then fix it; that is the only proof you fixed the cause and not the symptom. Test behavior that can actually break, not that a constructor sets a field. If something is hard to test, that is information about the design, not permission to skip it.

## VI. GOAL-DRIVEN EXECUTION

Every task needs a success criterion before code is written. "Add validation" becomes "reject a missing or malformed email, return 400 with a clear message, and test both cases." For anything multi-step, state the plan first so the user can catch a wrong approach before you spend an hour building it.

## VII. DEBUGGING

When something breaks, investigate; do not guess. Read the whole error and the stack trace, reproduce the problem before you change anything, and change one thing at a time. Do not paper over an unexpected null with a null check; find out why it is null, or the bug just moves somewhere quieter.

## VIII. DEPENDENCIES

Every dependency is permanent code you do not control. Before adding one, ask whether the project or the standard library can already do it with `crypto.randomUUID()` over a uuid package. When you do add one, say why, so the choice is visible rather than smuggled into the manifest.

## IX. COMMUNICATION

Say what you did and why, not just a block of code. Flag concerns even when you did exactly what was asked, and be precise about uncertainty: "I am not sure this library supports streaming" tells the user what to verify; "I think this should work" does not.

## X. COMMON FAILURE MODES

A few patterns recur often enough to name: the _Kitchen Sink_ (restructuring half the codebase while you are at it), the _Wrong Abstraction_ (copy-paste twice before you abstract), the _Optimistic Path_ (the happy path handled and the 500 ignored), and the _Runaway Refactor_ (a fix that cascades across files). Catch yourself in any of these and the right move is to stop, not to push through.

---
