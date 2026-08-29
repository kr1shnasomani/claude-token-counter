# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                        # all 6 suites via test/run.js
node test/security.test.js      # one suite (each file runs standalone)
npm run lint                    # eslint .
```

There is **no build step**. Load the repo root as an unpacked extension and
reload it after editing; content script changes need an extension reload, not
just a page refresh.

`.npmrc` sets `ignore-scripts=true` and CI installs with `npm ci
--ignore-scripts`. Do not install packages without asking first — this project
ships no runtime dependencies and that is deliberate.

## Two halves, two JavaScript worlds

claude.ai's own network traffic is invisible to a normal content script, so the
extension is split:

- `src/injected/bridge.js` runs in the **page's own world**. It is injected as a
  `<script src>` by `bridge-client.js` and patches `window.fetch` and
  `history.pushState`/`replaceState` before the app loads. It sees every request
  claude.ai makes, including the SSE stream.
- `src/content/*.js` runs in the **isolated content script world** and owns all
  UI.

They cannot call each other. The only channel is `window.postMessage`, tagged
`cc: 'ClaudeCounter'`, matched by request id for request/response and broadcast
for one-way events. Both sides check `event.source === window` and the origin,
and the bridge addresses replies to `window.location.origin` rather than `'*'`.
Ids that end up in a URL path are validated against `ID_PATTERN` first.

## Things that are not obvious and will bite

**Claude ships more than one composer design.** The usage row is anchored to the
rounded card by *shape* — the nearest ancestor of `[data-testid="chat-input"]`
that is a flex column with a corner radius and a painted background — because
the `rounded-composer` class exists only on some variants. The header has a
three-tier fallback (`chat-title-split` → `chat-header` → semantic `<header>`).
Do not replace these with a single selector; that is exactly what broke before.

**Not every plan reports usage the same way.** On free tier the REST endpoint
returns `null` for every window and the SSE `message_limit` event is the only
source, so usage is unknown until the first message of a session. The bars are
seeded from the stored snapshot on load to cover that, and a window whose
`resets_at` has already passed is dropped rather than shown stale.

**The version lives in two places** — `manifest.json` and `package.json`. CI and
the release workflow both refuse to proceed if they disagree.

## Conversation data

`tokens.js` reconstructs the *active branch* by walking back from
`current_leaf_message_uuid` through each `parent_message_uuid`. claude.ai stores
every edit and every abandoned retry in one flat `chat_messages` array, so this
walk is what separates the conversation as it reads from its dead ends.
`export.js` reuses the same walk, and additionally replays `str_replace` edits
onto files created by `create_file` so an exported file matches the version that
was actually used rather than the one first written.

## Popup and settings

The popup is a separate document and cannot read the content script's memory.
The content script mirrors each usage reading into `chrome.storage.local`
(`cc:usageSnapshot`); the popup renders that snapshot with a timestamp. Pressing
refresh requests the optional claude.ai host permission at that moment, so a
fresh install shows no permission warning.

Settings (`cc:settings`) are written by the popup and applied by
`ui.applySettings()` via `storage.onChanged`, so open tabs update without a
reload. Visibility is decided by settings **and** data: a setting must never
reveal a row that has no data behind it.

## Tests

`test/harness.js` runs the real content scripts in Node against a small DOM
shim, so the suites exercise shipped code rather than a copy. When a test fails
in a way that looks impossible, suspect the shim before the code — it has been
wrong twice (`classList` not reflecting `className`, and a missing
`createElementNS`).

`test/security.test.js` is a guard, not documentation: it fails on `eval`,
`innerHTML`, widened permissions, an unpinned action, a lockfile entry without an
integrity hash, or an install that could run lifecycle scripts.

## Permissions

`storage` only, with `https://claude.ai/*` as an *optional* host permission.
Nothing at install time triggers a warning. Widening this is a product decision,
not a refactor, and CI asserts the current values.
