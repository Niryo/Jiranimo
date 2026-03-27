# Jiranimo Development Rules

## TDD Workflow

**Build → Test → Verify → Next.** This is non-negotiable.

1. When implementing a module, write its tests immediately after (in the same session)
2. Every `.ts` source file in `server/src/` gets a co-located `.test.ts` sibling (except `types.ts` files)
3. Every `.js` source file in `extension/lib/` and `extension/content/` gets a `.test.js` sibling
4. Run `cd server && npm test` after completing each module — all tests must pass before moving on
5. Never move to the next implementation phase until the current phase's tests are green
6. Use the `test` agent proactively after writing code
7. Use the `verify` agent before committing

## Project Structure

- `server/` — Node.js/TypeScript backend (Express, Claude Code executor, git/PR workflow)
- `extension/` — Chrome extension (Manifest V3, vanilla JS)
- Tests are co-located next to source files, not in a separate test directory (except E2E and integration tests)

## Test Tiers

- `npm test` — unit tests (fast, every commit)
- `npm run test:integration` — integration tests with fake Claude subprocess + real git on temp repos
- `npm run test:e2e` — E2E tests against real Jira site (manual/nightly)

## Bug Fix Protocol

Every bug fix MUST include:
1. A new or updated test that reproduces the bug (fails before the fix)
2. The fix itself
3. Run the test to verify it passes
4. Post the screenshot path that proves the fix works

Never fix a bug without adding a test. The test should specifically cover the scenario that caused the bug.

## Chrome Extension Reload

After modifying ANY file in `extension/`, ALWAYS ask the user to reload the extension before testing:
> "Reload the extension in chrome://extensions (click the reload icon on Jiranimo) before testing."

Chrome does not auto-reload unpacked extensions. Without a reload, changes won't take effect.

## Jira API Access Rules

All Jira API calls in the extension MUST go through the **content script** using `fetch` with `credentials: 'include'` (session cookies). Never use the background service worker for Jira API calls — it doesn't have access to session cookies (especially in incognito).

The **only** exception: E2E test setup/cleanup code (`test/e2e/jira-helpers.ts`) uses API token auth to create/delete test data. This is test infrastructure only, not production code.

## Conventions

- Server uses TypeScript with strict mode
- Extension uses vanilla JS (no build step, Manifest V3)
- State stored in JSON file at `~/.jiranimo/state.json`, not a database
- All Jira API communication happens in the Chrome extension (session cookies), never on the server
- Server config in `jiranimo.config.json`, extension config in `chrome.storage.local`
