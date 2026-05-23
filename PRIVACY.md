# Privacy Policy for Claude Token Counter

**Last updated:** May 24, 2026

## Overview

Claude Token Counter is a browser extension that operates entirely within your browser. It does not collect, transmit, or store any personal data on external servers.

## Data Accessed

### Cookies
The extension reads the `lastActiveOrg` cookie from `claude.ai` solely to identify your active Claude organization. This is used to query Claude's own API on your behalf for usage data. The cookie value is never stored, logged, or transmitted outside of `claude.ai`.

### Network Requests
The extension makes requests exclusively to the following Claude API endpoints:
- `https://claude.ai/api/organizations/{orgId}/usage` — to fetch your session and weekly usage data
- `https://claude.ai/api/organizations/{orgId}/chat_conversations/{conversationId}` — to fetch conversation data for token counting

No data from these responses is ever sent to any external server. All data is held temporarily in browser memory and discarded when the tab is closed.

### Conversation Data
The extension reads conversation content locally for the sole purpose of estimating token counts. This data never leaves your browser.

## Data Storage

The extension does **not** use:
- `chrome.storage`
- `localStorage` or `sessionStorage`
- Any remote database or analytics service

All processed data exists only in memory for the duration of your session.

## Third Parties

This extension does not integrate any third-party analytics, advertising, or tracking services. The only vendored third-party code is the `gpt-tokenizer` library (MIT licensed, by Bazyli Brzoska), which runs entirely locally for token counting.

## External Servers

This extension makes **no requests** to any server outside of `claude.ai`. No data ever leaves your browser to any server controlled by the extension author.

## Changes to This Policy

Any updates to this policy will be reflected in this file on the GitHub repository with an updated date at the top.

## Contact

For questions or concerns, open an issue on the [GitHub repository](https://github.com/kr1shnasomani/claude-counter).