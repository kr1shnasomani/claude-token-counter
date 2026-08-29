# Security Policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub's private vulnerability reporting](https://github.com/kr1shnasomani/claude-token-counter/security/advisories/new)
rather than opening a public issue.

Include the extension version, your browser, and enough detail to reproduce.
You can expect an acknowledgement within a few days.

## What this extension can access

It runs only on `https://claude.ai/*`. It requests one permission, `storage`.
Access to claude.ai itself is optional and requested at the moment you press
refresh in the popup, so a fresh install shows no permission warning.

Everything runs locally. Nothing is sent anywhere except to claude.ai, and the
requests it makes are the same ones the site already makes for itself.

## What is stored

Three keys in local extension storage, never transmitted:

- `cc:usageSnapshot` — the last usage reading, your organisation id, plan name,
  and which Claude layout was detected
- `cc:settings` — which on-page elements you have switched off
- `cc:feedbackDraft` — an unsent bug report, cleared once the issue is opened

**No conversation content is stored.** Exports are written straight to a
download and are never uploaded.

## Boundaries in the code

- The injected bridge accepts messages only from its own window, and addresses
  replies to the page's own origin instead of broadcasting them
- Organisation and conversation ids are pattern-checked before reaching a URL,
  so a crafted message cannot redirect a request to another endpoint
- No `eval`, no `new Function`, no `innerHTML` in shipped code
- No credentials are bundled. The feedback button opens a prefilled GitHub issue
  rather than filing one, precisely so no token has to ship inside the extension

`npm test` includes a security suite that fails if any of the above regresses.

## Third-party code

The `o200k_base` tokenizer is vendored at `src/vendor/o200k_base.js`; its
SHA-256 is recorded in `THIRD_PARTY_NOTICES.md`. The userscript loads the same
tokenizer from unpkg pinned by both version and `#sha256=`, so a change to the
published file stops it running rather than executing silently.

Neither of these appears in a package manifest, so Dependabot does not watch
them. They are re-pinned by hand when the version changes.
