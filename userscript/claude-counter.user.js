// ==UserScript==
// @name         Claude Counter
// @namespace    https://github.com/she-llac/claude-counter
// @version      1.0.6-userscript
// @description  Shows token count, cache timer, and usage bars on claude.ai.
// @match        https://claude.ai/*
// @run-at       document-start
// @grant        none
// @require      https://unpkg.com/gpt-tokenizer@2.9.0/dist/o200k_base.js
// ==/UserScript==

(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});
	if (CC.__ccUserscriptWrapped) return;
	CC.__ccUserscriptWrapped = true;

	CC._ccInternal = CC._ccInternal || {};
	CC._ccInternal.onGenerationStart = CC._ccInternal.onGenerationStart || (() => {});
	CC._ccInternal.onConversationData = CC._ccInternal.onConversationData || (() => {});
	CC._ccInternal.onMessageLimit = CC._ccInternal.onMessageLimit || (() => {});
	CC._ccInternal.onUrlChange = CC._ccInternal.onUrlChange || (() => {});

	const originalFetch = window.fetch ? window.fetch.bind(window) : null;
	CC._ccInternal.originalFetch = originalFetch;

	const originalPushState = history.pushState.bind(history);
	const originalReplaceState = history.replaceState.bind(history);

	const dispatchUrlChange = () => {
		try {
			CC._ccInternal.onUrlChange();
		} catch {
			// ignore
		}
	};

	history.pushState = function (...args) {
		const result = originalPushState(...args);
		dispatchUrlChange();
		return result;
	};

	history.replaceState = function (...args) {
		const result = originalReplaceState(...args);
		dispatchUrlChange();
		return result;
	};

	window.addEventListener('popstate', dispatchUrlChange);

	if (originalFetch) {
		window.fetch = async (...args) => {
			const url = toAbsoluteUrl(args[0]);
			const opts = args[1] || {};
			const method = (opts.method || 'GET').toUpperCase();

			if (url && method === 'POST' && (url.includes('/completion') || url.includes('/retry_completion'))) {
				try {
					CC._ccInternal.onGenerationStart();
				} catch {
					// ignore
				}
			}

			const response = await originalFetch(...args);
			const contentType = response.headers.get('content-type') || '';
			if (contentType.includes('event-stream')) {
				handleEventStream(response);
			}

			if (url && url.includes('/chat_conversations/') && url.includes('tree=')) {
				const meta = getConversationMeta(url);
				if (meta) {
					handleConversationResponse(meta, response);
				}
			}

			return response;
		};
	}

	function toAbsoluteUrl(input) {
		if (typeof input === 'string') {
			if (input.startsWith('/')) return `https://claude.ai${input}`;
			return input;
		}
		if (input instanceof URL) return input.href;
		if (input instanceof Request) return input.url;
		return '';
	}

	function getConversationMeta(url) {
		const match = url.match(/^https:\/\/claude\.ai\/api\/organizations\/([^/]+)\/chat_conversations\/([^/?]+)/);
		return match ? { orgId: match[1], conversationId: match[2] } : null;
	}

	async function handleConversationResponse({ orgId, conversationId }, response) {
		try {
			const cloned = response.clone();
			const data = await cloned.json();
			CC._ccInternal.onConversationData({ orgId, conversationId, data });
		} catch {
			// ignore parse failures
		}
	}

	async function handleEventStream(response) {
		try {
			const cloned = response.clone();
			const reader = cloned.body?.getReader?.();
			if (!reader) return;
			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split(/\r\n|\r|\n/);
				buffer = lines.pop() || '';
				for (const line of lines) {
					if (!line.startsWith('data:')) continue;
					const raw = line.slice(5).trim();
					if (!raw) continue;
					try {
						const json = JSON.parse(raw);
						if (json?.type === 'message_limit' && json.message_limit) {
							CC._ccInternal.onMessageLimit(json.message_limit);
							reader.cancel().catch(() => {});
							reader.releaseLock();
							return;
						}
					} catch {
						// ignore
					}
				}
			}
		} catch {
			// best-effort; do not break claude.ai
		}
	}
})();

(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	CC.DOM = Object.freeze({
		CHAT_MENU_TRIGGER: '[data-testid="chat-title-split"]',
		CHAT_INPUT: '[data-testid="chat-input"]',
		COMPOSER_CARD: '[class*="rounded-composer"]',
		CHAT_PROJECT_WRAPPER: '.chat-project-wrapper',
		BRIDGE_SCRIPT_ID: 'cc-bridge-script'
	});

	CC.CONST = Object.freeze({
		CACHE_WINDOW_MS: 5 * 60 * 1000,
		PENDING_CACHE_TIMEOUT_MS: 60 * 1000
	});

	CC.COLORS = Object.freeze({
		PROGRESS_FILL_DARK: '#2c84db',
		PROGRESS_FILL_LIGHT: '#5aa6ff',
		PROGRESS_OUTLINE_DARK: '#787877',
		PROGRESS_OUTLINE_LIGHT: '#bfbfbf',
		PROGRESS_MARKER_DARK: '#ffffff',
		PROGRESS_MARKER_LIGHT: '#111111',
		AMBER_WARNING: '#F0B544',
		RED_WARNING: '#ce2029',
		BOLD_LIGHT: '#141413',
		BOLD_DARK: '#faf9f5',
		CACHE_ACTIVE_DARK: '#3fb950',
		CACHE_ACTIVE_LIGHT: '#1a7f37'
	});
})();



(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	const ROOT_MESSAGE_ID = '00000000-0000-4000-8000-000000000000';

	function stableStringify(value) {
		const seen = new WeakSet();

		const normalize = (v) => {
			if (v === null || typeof v !== 'object') return v;
			if (seen.has(v)) return '[Circular]';
			seen.add(v);

			if (Array.isArray(v)) return v.map(normalize);

			const out = {};
			for (const key of Object.keys(v).sort()) {
				out[key] = normalize(v[key]);
			}
			return out;
		};

		try {
			return JSON.stringify(normalize(value));
		} catch {
			return '';
		}
	}

	function getTokenizer() {
		return globalThis.GPTTokenizer_o200k_base || null;
	}

	function countTokens(text) {
		if (!text) return 0;
		const tokenizer = getTokenizer();
		if (!tokenizer?.countTokens) return 0;
		try {
			return tokenizer.countTokens(text);
		} catch {
			return 0;
		}
	}

	function buildTrunk(conversation) {
		const messages = Array.isArray(conversation?.chat_messages) ? conversation.chat_messages : [];
		const byId = new Map();
		for (const msg of messages) {
			if (msg?.uuid) byId.set(msg.uuid, msg);
		}

		const leaf = conversation?.current_leaf_message_uuid;
		if (!leaf) return [];

		const trunk = [];
		let currentId = leaf;
		while (currentId && currentId !== ROOT_MESSAGE_ID) {
			const msg = byId.get(currentId);
			if (!msg) break;
			trunk.push(msg);
			currentId = msg.parent_message_uuid;
		}

		trunk.reverse();
		return trunk;
	}

	function isCountableContentItem(item) {
		if (!item || typeof item !== 'object') return false;
		if (typeof item.type !== 'string') return false;
		if (item.type === 'thinking' || item.type === 'redacted_thinking') return false;
		if (item.type === 'image' || item.type === 'document') return false;
		return true;
	}

	function stringifyCountableContentItem(item) {
		if (!isCountableContentItem(item)) return '';

		// Common fast-path for text blocks.
		if (item.type === 'text' && typeof item.text === 'string') return item.text;

		// Tool blocks: include observable payloads deterministically, but exclude "thinking".
		if (item.type === 'tool_use') {
			const minimal = {
				id: item.id,
				name: item.name,
				input: item.input
			};
			return stableStringify(minimal);
		}

		if (item.type === 'tool_result') {
			const minimal = {
				tool_use_id: item.tool_use_id,
				is_error: item.is_error,
				content: item.content
			};
			return stableStringify(minimal);
		}

		// Fallback: keep only known-ish textual fields to avoid pulling in huge binary-ish blobs.
		const minimal = {};
		if (typeof item.text === 'string') minimal.text = item.text;
		if (typeof item.title === 'string') minimal.title = item.title;
		if (typeof item.url === 'string') minimal.url = item.url;
		if (typeof item.content === 'string') minimal.content = item.content;
		if (Array.isArray(item.content)) minimal.content = item.content;
		if (Object.keys(minimal).length === 0) return '';
		return stableStringify(minimal);
	}

	function stringifyMessageCountables(message) {
		const parts = [];

		// Message content blocks (primary source for tools, text, etc).
		const content = Array.isArray(message?.content) ? message.content : [];
		for (const item of content) {
			const s = stringifyCountableContentItem(item);
			if (s) parts.push(s);
		}

		// Attachment extracted content (observable, already text).
		const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
		for (const a of attachments) {
			if (typeof a?.extracted_content === 'string' && a.extracted_content) {
				parts.push(a.extracted_content);
			}
		}

		return parts.join('\n');
	}

	async function hashString(str) {
		if (!crypto?.subtle?.digest) return null;
		try {
			const data = new TextEncoder().encode(str);
			const buffer = await crypto.subtle.digest('SHA-256', data);
			const bytes = new Uint8Array(buffer);
			// Use first 8 bytes (64 bits) for fingerprint
			return Array.from(bytes.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
		} catch {
			return null;
		}
	}

	async function fingerprint(text) {
		if (!text) return null;
		const hash = await hashString(text);
		if (!hash) return null;
		return `${text.length}:${hash}`;
	}

	class TokenCache {
		constructor() {
			this._byMessageId = new Map(); // uuid -> { fp, tokens }
		}

		async getMessageTokens(messageId, messageText) {
			const fp = await fingerprint(messageText);
			if (!fp) return countTokens(messageText);
			const cached = this._byMessageId.get(messageId);
			if (cached && cached.fp === fp) return cached.tokens;

			const tokens = countTokens(messageText);
			this._byMessageId.set(messageId, { fp, tokens });
			return tokens;
		}

		pruneToMessageIds(keepIds) {
			const keep = new Set(keepIds);
			for (const id of this._byMessageId.keys()) {
				if (!keep.has(id)) this._byMessageId.delete(id);
			}
		}
	}

	const tokenCache = new TokenCache();

	async function computeConversationMetrics(conversation) {
		const trunk = buildTrunk(conversation);
		const trunkIds = trunk.map((m) => m.uuid).filter(Boolean);
		tokenCache.pruneToMessageIds(trunkIds);

		let totalTokens = 0;
		let lastAssistantMs = null;

		for (const msg of trunk) {
			if (msg?.sender === 'assistant' && msg?.created_at) {
				const msgMs = Date.parse(msg.created_at);
				if (!lastAssistantMs || msgMs > lastAssistantMs) {
					lastAssistantMs = msgMs;
				}
			}

			const msgText = stringifyMessageCountables(msg);
			const msgTokens = msg?.uuid ? await tokenCache.getMessageTokens(msg.uuid, msgText) : countTokens(msgText);
			totalTokens += msgTokens;
		}
		const cachedUntil = lastAssistantMs ? lastAssistantMs + CC.CONST.CACHE_WINDOW_MS : null;

		return {
			trunkMessageCount: trunk.length,
			totalTokens,
			lastAssistantMs,
			cachedUntil
		};
	}

	CC.tokens = { computeConversationMetrics, buildTrunk };
})();



(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	const SENDER_LABEL = { human: 'You', assistant: 'Claude' };

	// Tools whose payload is a document the user asked for, rather than plumbing.
	const FILE_TOOLS = new Set(['create_file', 'artifacts']);

	const FENCE_LANG = {
		md: 'markdown', markdown: 'markdown', txt: '', text: '',
		js: 'javascript', mjs: 'javascript', ts: 'typescript', tsx: 'tsx', jsx: 'jsx',
		py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', sh: 'bash',
		html: 'html', css: 'css', json: 'json', yaml: 'yaml', yml: 'yaml',
		csv: 'csv', sql: 'sql', xml: 'xml'
	};

	function basename(path) {
		if (typeof path !== 'string') return '';
		const parts = path.split('/');
		return parts[parts.length - 1] || path;
	}

	function fenceLanguage(name) {
		const ext = (name.split('.').pop() || '').toLowerCase();
		return FENCE_LANG[ext] ?? '';
	}

	/** A fence long enough to survive backticks inside the content. */
	function fenceFor(text) {
		let longest = 0;
		for (const run of String(text).match(/`+/g) || []) longest = Math.max(longest, run.length);
		return '`'.repeat(Math.max(3, longest + 1));
	}

	function formatBytes(bytes) {
		if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function formatDateTime(value) {
		const ms = typeof value === 'number' ? value : Date.parse(value);
		if (!Number.isFinite(ms)) return '';
		return new Date(ms).toLocaleString(undefined, {
			day: 'numeric', month: 'short', year: 'numeric',
			hour: '2-digit', minute: '2-digit'
		});
	}

	function slugify(name) {
		const base = String(name || 'claude-conversation')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 60);
		return base || 'claude-conversation';
	}

	/** A tool_use block that produced a document, or null. */
	function asGeneratedFile(item) {
		if (item?.type !== 'tool_use' || !FILE_TOOLS.has(item.name)) return null;
		const input = item.input || {};

		// Newer file-based flow.
		if (typeof input.file_text === 'string') {
			return { name: basename(input.path) || 'untitled', text: input.file_text };
		}
		// Classic artifacts tool.
		if (typeof input.content === 'string' && input.command !== 'delete') {
			return { name: input.title || input.id || 'artifact', text: input.content, lang: input.language };
		}
		return null;
	}

	/** Apply one str_replace edit. Literal match on the first occurrence only. */
	function applyEdit(text, oldStr, newStr) {
		if (typeof text !== 'string' || typeof oldStr !== 'string') return null;
		const at = text.indexOf(oldStr);
		if (at === -1) return null;
		return text.slice(0, at) + (typeof newStr === 'string' ? newStr : '') + text.slice(at + oldStr.length);
	}

	/**
	 * Walk the whole trunk once and replay every file edit, so a generated file is
	 * exported as it ended up rather than as it was first written. A file can be
	 * created once and then edited many times across later turns.
	 */
	function replayFiles(trunk) {
		const byPath = new Map();
		const orphans = new Set();

		for (const message of trunk) {
			for (const item of Array.isArray(message?.content) ? message.content : []) {
				if (item?.type !== 'tool_use') continue;
				const input = item.input || {};

				if (FILE_TOOLS.has(item.name)) {
					const file = asGeneratedFile(item);
					if (file && typeof input.path === 'string') {
						byPath.set(input.path, { text: file.text, edits: 0, failed: 0 });
					}
					continue;
				}

				if (item.name === 'str_replace' && typeof input.path === 'string') {
					const state = byPath.get(input.path);
					if (!state) {
						// Created outside this transcript (a shell heredoc, an earlier
						// branch): there is no base text to apply the edit to.
						orphans.add(input.path);
						continue;
					}
					const next = applyEdit(state.text, input.old_str, input.new_str);
					if (next === null) state.failed += 1;
					else {
						state.text = next;
						state.edits += 1;
					}
				}
			}
		}

		return { byPath, orphans, noted: new Set() };
	}

	/**
	 * Reduce one message to an ordered list of renderable blocks.
	 * Tool plumbing collapses into a single summary rather than pages of JSON.
	 */
	function messageBlocks(message, options, files) {
		const blocks = [];
		const toolCounts = new Map();

		for (const item of Array.isArray(message?.content) ? message.content : []) {
			if (item?.type === 'text') {
				if (typeof item.text === 'string' && item.text.trim()) blocks.push({ kind: 'text', text: item.text.trim() });
				continue;
			}
			if (item?.type === 'thinking' || item?.type === 'redacted_thinking') {
				if (options.includeThinking && typeof item.thinking === 'string' && item.thinking.trim()) {
					blocks.push({ kind: 'thinking', text: item.thinking.trim() });
				}
				continue;
			}
			if (item?.type === 'tool_use') {
				const file = asGeneratedFile(item);
				if (file && options.includeFiles) {
					const state = files?.byPath.get(item.input?.path);
					blocks.push({ kind: 'file', ...file, ...(state ? { text: state.text, edits: state.edits, failed: state.failed } : {}) });
					continue;
				}
				if (item.name === 'str_replace' && files) {
					const path = item.input?.path;
					if (path && files.orphans.has(path) && !files.noted.has(path)) {
						files.noted.add(path);
						blocks.push({ kind: 'orphanEdit', name: basename(path) });
					}
				}
				if (item.name) toolCounts.set(item.name, (toolCounts.get(item.name) || 0) + 1);
			}
			// tool_result is the machine side of a call; the summary above covers it.
		}

		for (const a of Array.isArray(message?.attachments) ? message.attachments : []) {
			blocks.push({
				kind: 'attachment',
				name: a?.file_name || `untitled.${a?.file_type || 'file'}`,
				size: formatBytes(a?.file_size)
			});
		}
		for (const f of Array.isArray(message?.files) ? message.files : []) {
			blocks.push({ kind: 'media', name: f?.file_name || 'file', mediaKind: f?.file_kind || 'file' });
		}

		if (options.includeToolSummary && toolCounts.size) {
			const parts = [...toolCounts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name));
			blocks.push({ kind: 'tools', text: parts.join(', ') });
		}

		return blocks;
	}

	/** " (final version, 7 edits applied)" - so replayed content isn't mistaken for the original. */
	function editNote(block, markdown) {
		if (!block.edits) return '';
		const parts = [`final version, ${block.edits} edit${block.edits === 1 ? '' : 's'} applied`];
		if (block.failed) parts.push(`${block.failed} could not be applied`);
		const text = `(${parts.join('; ')})`;
		return markdown ? ` *${text}*` : ` ${text}`;
	}

	function defaultOptions(overrides) {
		return {
			includeThinking: false,
			includeFiles: true,
			includeToolSummary: true,
			includeTimestamps: true,
			...overrides
		};
	}

	function buildMarkdown(conversation, overrides) {
		const options = defaultOptions(overrides);
		const trunk = CC.tokens.buildTrunk(conversation);
		const files = replayFiles(trunk);
		const title = conversation?.name || 'Claude conversation';
		const out = [`# ${title}`, ''];

		const meta = [`Exported ${formatDateTime(Date.now())}`, `${trunk.length} message${trunk.length === 1 ? '' : 's'}`];
		if (conversation?.model) meta.push(conversation.model);
		out.push(`*${meta.join(' · ')}*`, '');

		for (const message of trunk) {
			const who = SENDER_LABEL[message?.sender] || message?.sender || 'Unknown';
			const when = options.includeTimestamps ? formatDateTime(message?.created_at) : '';
			out.push('---', '');
			out.push(when ? `## ${who} · ${when}` : `## ${who}`, '');

			for (const block of messageBlocks(message, options, files)) {
				if (block.kind === 'text') out.push(block.text, '');
				else if (block.kind === 'thinking') out.push(`> **Thinking**`, ...block.text.split('\n').map((l) => `> ${l}`), '');
				else if (block.kind === 'orphanEdit') {
					out.push(`*\u{270F}\u{FE0F} Edited \`${block.name}\` - created outside this transcript, content unavailable.*`, '');
				} else if (block.kind === 'file') {
					const fence = fenceFor(block.text);
					out.push(`**Generated file: \`${block.name}\`**${editNote(block, true)}`, '');
					out.push(`${fence}${block.lang || fenceLanguage(block.name)}`, block.text, fence, '');
				} else if (block.kind === 'attachment') {
					out.push(`\u{1F4CE} *Attachment: ${block.name}${block.size ? ` (${block.size})` : ''}*`, '');
				} else if (block.kind === 'media') {
					out.push(`\u{1F5BC}️ *${block.mediaKind}: ${block.name}*`, '');
				} else if (block.kind === 'tools') {
					out.push(`*\u{1F527} Used: ${block.text}*`, '');
				}
			}
		}

		return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
	}

	function buildText(conversation, overrides) {
		const options = defaultOptions(overrides);
		const trunk = CC.tokens.buildTrunk(conversation);
		const files = replayFiles(trunk);
		const title = conversation?.name || 'Claude conversation';
		const rule = '='.repeat(60);
		const thin = '-'.repeat(60);

		const meta = [`Exported ${formatDateTime(Date.now())}`, `${trunk.length} message${trunk.length === 1 ? '' : 's'}`];
		if (conversation?.model) meta.push(conversation.model);
		const out = [title, meta.join(' · '), rule, ''];

		for (const message of trunk) {
			const who = (SENDER_LABEL[message?.sender] || message?.sender || 'Unknown').toUpperCase();
			const when = options.includeTimestamps ? formatDateTime(message?.created_at) : '';
			out.push(when ? `${who}  (${when})` : who, thin);

			for (const block of messageBlocks(message, options, files)) {
				if (block.kind === 'text') out.push(block.text, '');
				else if (block.kind === 'thinking') out.push('[thinking]', block.text, '');
				else if (block.kind === 'orphanEdit') {
					out.push(`[edited ${block.name} - created outside this transcript, content unavailable]`, '');
				} else if (block.kind === 'file') {
					out.push(`--- generated file: ${block.name}${editNote(block, false)} ---`, block.text, `--- end of ${block.name} ---`, '');
				} else if (block.kind === 'attachment') {
					out.push(`[attachment: ${block.name}${block.size ? ` (${block.size})` : ''}]`, '');
				} else if (block.kind === 'media') {
					out.push(`[${block.mediaKind}: ${block.name}]`, '');
				} else if (block.kind === 'tools') {
					out.push(`[used: ${block.text}]`, '');
				}
			}
		}

		return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
	}

	const FORMATS = {
		md: { build: buildMarkdown, ext: 'md', mime: 'text/markdown' },
		txt: { build: buildText, ext: 'txt', mime: 'text/plain' }
	};

	function buildFile(conversation, format, overrides) {
		const spec = FORMATS[format] || FORMATS.md;
		// Local date, not UTC: an evening export in a UTC+ timezone would otherwise be
		// stamped with yesterday's date and disagree with the header inside the file.
		const now = new Date();
		const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
		return {
			filename: `${slugify(conversation?.name)}-${stamp}.${spec.ext}`,
			mime: spec.mime,
			content: spec.build(conversation, overrides)
		};
	}

	/** Hand the file to the browser. Uses a blob URL, so no `downloads` permission. */
	function download(conversation, format, overrides) {
		const file = buildFile(conversation, format, overrides);
		const url = URL.createObjectURL(new Blob([file.content], { type: `${file.mime};charset=utf-8` }));
		const link = document.createElement('a');
		link.href = url;
		link.download = file.filename;
		link.style.display = 'none';
		document.body.appendChild(link);
		link.click();
		link.remove();
		setTimeout(() => URL.revokeObjectURL(url), 10000);
		return file.filename;
	}

	CC.exportChat = { buildMarkdown, buildText, buildFile, download, slugify };
})();


(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	function formatSeconds(totalSeconds) {
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		return `${minutes}:${String(seconds).padStart(2, '0')}`;
	}

	function formatResetCountdown(timestampMs) {
		// <= 0: reset time reached
		const diffMs = timestampMs - Date.now();
		if (diffMs <= 0) return '0s';

		// < 1 min: show seconds
		const totalSeconds = Math.floor(diffMs / 1000);
		if (totalSeconds < 60) return `${totalSeconds}s`;

		// < 1 hour: show minutes
		const totalMinutes = Math.round(totalSeconds / 60);
		if (totalMinutes < 60) return `${totalMinutes}m`;

		// < 1 day: show hours
		const hours = Math.floor(totalMinutes / 60);
		const minutes = totalMinutes % 60;
		if (hours < 24) return `${hours}h ${minutes}m`;

		// >= 1 day: show days
		const days = Math.floor(hours / 24);
		const remHours = hours % 24;
		return `${days}d ${remHours}h`;
	}

	function setupTooltip(element, tooltip, { topOffset = 10 } = {}) {
		if (!element || !tooltip) return;
		if (element.hasAttribute('data-tooltip-setup')) return;
		element.setAttribute('data-tooltip-setup', 'true');
		element.classList.add('cc-tooltipTrigger');

		let pressTimer;
		let hideTimer;

		const show = () => {
			const rect = element.getBoundingClientRect();
			tooltip.style.opacity = '1';
			const tipRect = tooltip.getBoundingClientRect();

			let left = rect.left + rect.width / 2;
			if (left + tipRect.width / 2 > window.innerWidth) left = window.innerWidth - tipRect.width / 2 - 10;
			if (left - tipRect.width / 2 < 0) left = tipRect.width / 2 + 10;

			let top = rect.top - tipRect.height - topOffset;
			if (top < 10) top = rect.bottom + 10;

			tooltip.style.left = `${left}px`;
			tooltip.style.top = `${top}px`;
			tooltip.style.transform = 'translateX(-50%)';
		};

		const hide = () => {
			tooltip.style.opacity = '0';
			clearTimeout(hideTimer);
		};

		element.addEventListener('pointerdown', (e) => {
			if (e.pointerType === 'touch' || e.pointerType === 'pen') {
				pressTimer = setTimeout(() => {
					show();
					hideTimer = setTimeout(hide, 3000);
				}, 500);
			}
		});

		element.addEventListener('pointerup', () => clearTimeout(pressTimer));
		element.addEventListener('pointercancel', () => {
			clearTimeout(pressTimer);
			hide();
		});

		element.addEventListener('pointerenter', (e) => {
			if (e.pointerType === 'mouse') show();
		});

		element.addEventListener('pointerleave', (e) => {
			if (e.pointerType === 'mouse') hide();
		});
	}

	function makeTooltip(text) {
		const tip = document.createElement('div');
		tip.className = 'bg-bg-500 text-text-000 cc-tooltip';
		tip.textContent = text;
		document.body.appendChild(tip);
		return tip;
	}

	class CounterUI {
		constructor({ onUsageRefresh, onExport } = {}) {
			this.onUsageRefresh = onUsageRefresh || null;
			this.onExport = onExport || null;

			this.exportBtn = null;
			this.exportMenu = null;
			this.exportingChat = false;

			this.headerContainer = null;
			this.headerDisplay = null;
			this.lengthGroup = null;
			this.lengthDisplay = null;
			this.lengthValueSpan = null;
			this.cachedDisplay = null;
			this.lengthTooltip = null;
			this.lastCachedUntilMs = null;
			this.pendingCache = false;
			this.pendingCacheTimeoutId = null;

			this.usageLine = null;
			this.sessionUsageSpan = null;
			this.weeklyUsageSpan = null;
			this.sessionBar = null;
			this.sessionBarFill = null;
			this.weeklyBar = null;
			this.weeklyBarFill = null;
			this.sessionResetMs = null;
			this.weeklyResetMs = null;
			this.sessionMarker = null;
			this.weeklyMarker = null;
			this.sessionWindowStartMs = null;
			this.weeklyWindowStartMs = null;
			this.refreshingUsage = false;
			this.refreshBtn = null;

			this.domObserver = null;
		}

		getProgressChrome() {
			const root = document.documentElement;
			const modeDark = root.dataset?.mode === 'dark';
			const modeLight = root.dataset?.mode === 'light';
			const isDark = modeDark && !modeLight;

			return {
				strokeColor: isDark ? CC.COLORS.PROGRESS_OUTLINE_DARK : CC.COLORS.PROGRESS_OUTLINE_LIGHT,
				fillColor: isDark ? CC.COLORS.PROGRESS_FILL_DARK : CC.COLORS.PROGRESS_FILL_LIGHT,
				markerColor: isDark ? CC.COLORS.PROGRESS_MARKER_DARK : CC.COLORS.PROGRESS_MARKER_LIGHT,
				boldColor: isDark ? CC.COLORS.BOLD_DARK : CC.COLORS.BOLD_LIGHT,
				cacheActiveColor: isDark ? CC.COLORS.CACHE_ACTIVE_DARK : CC.COLORS.CACHE_ACTIVE_LIGHT
			};
		}

		refreshProgressChrome() {
			const { strokeColor, fillColor, markerColor, boldColor } = this.getProgressChrome();

			const applyBarChrome = (bar, { fillCaution, fillWarn } = {}) => {
				if (!bar) return;
				bar.style.setProperty('--cc-stroke', strokeColor);
				bar.style.setProperty('--cc-fill', fillColor);
				bar.style.setProperty('--cc-fill-caution', fillCaution ?? fillColor);
				bar.style.setProperty('--cc-fill-warn', fillWarn ?? fillColor);
				bar.style.setProperty('--cc-marker', markerColor);
			};

			applyBarChrome(this.sessionBar, { fillCaution: CC.COLORS.AMBER_WARNING, fillWarn: CC.COLORS.RED_WARNING });
			applyBarChrome(this.weeklyBar, { fillCaution: CC.COLORS.AMBER_WARNING, fillWarn: CC.COLORS.RED_WARNING });
			if (this.refreshBtn) this.refreshBtn.style.color = boldColor;
			if (this.exportBtn) this.exportBtn.style.color = boldColor;
			if (this.lengthValueSpan) this.lengthValueSpan.style.color = boldColor;
		}

		initialize() {
			// Header container (tokens + cache timer)
			this.headerContainer = document.createElement('div');
			this.headerContainer.className = 'text-text-500 text-xs !px-1 cc-header';

			this.headerDisplay = document.createElement('span');
			this.headerDisplay.className = 'cc-headerItem';

			this.lengthGroup = document.createElement('span');
			this.lengthDisplay = document.createElement('span');
			this.cachedDisplay = document.createElement('span');
			this.cacheTimeSpan = null; // reference to inner time span

			this.lengthGroup.appendChild(this.lengthDisplay);
			this.headerDisplay.appendChild(this.lengthGroup);

			// Usage line (session + weekly)
			this._initUsageLine();
			this._initExportButton();

			this._setupTooltips();
			this._observeDom();
			this._observeTheme();
		}

		_observeTheme() {
			// Watch for theme changes (data-mode attribute on <html>)
			const observer = new MutationObserver(() => this.refreshProgressChrome());
			observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
		}

		_observeDom() {
			// Track pending reattach attempts independently
			let usageReattachPending = false;
			let headerReattachPending = false;

			this.domObserver = new MutationObserver(() => {
				const usageMissing = this.usageLine && !document.contains(this.usageLine);
				const headerMissing = !document.contains(this.headerContainer);

				if (usageMissing && !usageReattachPending) {
					usageReattachPending = true;
					CC.waitForElement(CC.DOM.CHAT_INPUT, 60000).then((el) => {
						usageReattachPending = false;
						if (el) this.attachUsageLine();
					});
				}

				if (headerMissing && !headerReattachPending) {
					headerReattachPending = true;
					CC.waitForElement(CC.DOM.CHAT_MENU_TRIGGER, 60000).then((el) => {
						headerReattachPending = false;
						if (el) this.attachHeader();
					});
				}
			});
			this.domObserver.observe(document.body, { childList: true, subtree: true });
		}

		_initUsageLine() {
			this.usageLine = document.createElement('div');
			this.usageLine.className =
				'text-text-400 text-[11px] cc-usageRow cc-hidden flex flex-row items-center gap-3 w-full';

			this.sessionUsageSpan = document.createElement('span');
			this.sessionUsageSpan.className = 'cc-usageText';

			this.sessionBar = document.createElement('div');
			this.sessionBar.className = 'cc-bar cc-bar--usage';
			this.sessionBarFill = document.createElement('div');
			this.sessionBarFill.className = 'cc-bar__fill';
			this.sessionMarker = document.createElement('div');
			this.sessionMarker.className = 'cc-bar__marker cc-hidden';
			this.sessionMarker.style.left = '0%';
			this.sessionBar.appendChild(this.sessionBarFill);
			this.sessionBar.appendChild(this.sessionMarker);

			this.weeklyUsageSpan = document.createElement('span');
			this.weeklyUsageSpan.className = 'cc-usageText';

			this.weeklyBar = document.createElement('div');
			this.weeklyBar.className = 'cc-bar cc-bar--usage';
			this.weeklyBarFill = document.createElement('div');
			this.weeklyBarFill.className = 'cc-bar__fill';
			this.weeklyMarker = document.createElement('div');
			this.weeklyMarker.className = 'cc-bar__marker cc-hidden';
			this.weeklyMarker.style.left = '0%';
			this.weeklyBar.appendChild(this.weeklyBarFill);
			this.weeklyBar.appendChild(this.weeklyMarker);

			this.sessionGroup = document.createElement('div');
			this.sessionGroup.className = 'cc-usageGroup';
			this.sessionGroup.appendChild(this.sessionUsageSpan);
			this.sessionGroup.appendChild(this.sessionBar);

			this.weeklyGroup = document.createElement('div');
			this.weeklyGroup.className = 'cc-usageGroup cc-usageGroup--weekly';
			this.weeklyGroup.appendChild(this.weeklyBar);
			this.weeklyGroup.appendChild(this.weeklyUsageSpan);

			this.refreshBtn = document.createElement('button');
			this.refreshBtn.className = 'cc-refreshBtn';
			this.refreshBtn.setAttribute('aria-label', 'Refresh usage');
			this.refreshBtn.innerHTML =
				'<svg class="cc-refreshIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="11" height="11" aria-hidden="true">' +
				'<polyline points="23 4 23 10 17 10"/>' +
				'<path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>' +
				'</svg>';

			this.usageLine.appendChild(this.sessionGroup);
			this.usageLine.appendChild(this.weeklyGroup);
			this.usageLine.appendChild(this.refreshBtn);

			this.refreshProgressChrome();

			this.refreshBtn.addEventListener('click', async (e) => {
				e.stopPropagation();
				if (!this.onUsageRefresh || this.refreshingUsage) return;
				this.refreshingUsage = true;
				this.refreshBtn.classList.add('cc-refreshBtn--spinning');
				this.usageLine.classList.add('cc-usageRow--dim');
				try {
					await this.onUsageRefresh();
				} finally {
					this.refreshBtn.classList.remove('cc-refreshBtn--spinning');
					this.usageLine.classList.remove('cc-usageRow--dim');
					this.refreshingUsage = false;
				}
			});
		}

		_initExportButton() {
			this.exportBtn = document.createElement('button');
			this.exportBtn.className = 'cc-exportBtn';
			this.exportBtn.setAttribute('aria-label', 'Export conversation');
			this.exportBtn.setAttribute('aria-haspopup', 'menu');
			this.exportBtn.innerHTML =
				'<svg class="cc-exportIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="11" height="11" aria-hidden="true">' +
				'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
				'<polyline points="7 10 12 15 17 10"/>' +
				'<line x1="12" y1="15" x2="12" y2="3"/>' +
				'</svg>';

			this.exportMenu = document.createElement('div');
			this.exportMenu.className = 'bg-bg-200 text-text-100 border-border-300 cc-exportMenu cc-hidden';
			this.exportMenu.setAttribute('role', 'menu');

			for (const [format, label] of [['md', 'Markdown (.md)'], ['txt', 'Plain text (.txt)']]) {
				const item = document.createElement('button');
				item.className = 'cc-exportMenuItem';
				item.setAttribute('role', 'menuitem');
				item.textContent = label;
				item.addEventListener('click', (e) => {
					e.stopPropagation();
					this._closeExportMenu();
					this._runExport(format);
				});
				this.exportMenu.appendChild(item);
			}
			document.body.appendChild(this.exportMenu);

			this.exportBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				if (this.exportMenu.classList.contains('cc-hidden')) this._openExportMenu();
				else this._closeExportMenu();
			});

			document.addEventListener('click', () => this._closeExportMenu());
			document.addEventListener('keydown', (e) => {
				if (e.key === 'Escape') this._closeExportMenu();
			});
		}

		_openExportMenu() {
			const rect = this.exportBtn.getBoundingClientRect();
			this.exportMenu.classList.remove('cc-hidden');
			const menuRect = this.exportMenu.getBoundingClientRect();
			let left = rect.left;
			if (left + menuRect.width > window.innerWidth - 8) left = window.innerWidth - menuRect.width - 8;
			this.exportMenu.style.left = `${Math.max(8, left)}px`;
			this.exportMenu.style.top = `${rect.bottom + 6}px`;
		}

		_closeExportMenu() {
			this.exportMenu?.classList.add('cc-hidden');
		}

		async _runExport(format) {
			if (!this.onExport || this.exportingChat) return;
			this.exportingChat = true;
			this.exportBtn.classList.add('cc-exportBtn--busy');
			try {
				await this.onExport(format);
			} catch {
				// An explicit click that silently does nothing is worse than a wrong
				// answer, so flash the button rather than failing invisibly.
				this.exportBtn.classList.add('cc-exportBtn--error');
				setTimeout(() => this.exportBtn?.classList.remove('cc-exportBtn--error'), 2000);
			} finally {
				this.exportBtn.classList.remove('cc-exportBtn--busy');
				this.exportingChat = false;
			}
		}

		_setupTooltips() {
			this.lengthTooltip = makeTooltip(
				"Approximate tokens (excludes system prompt).\nUses a generic tokenizer, may differ from Claude's count.\nBecomes invalid after context compaction.\nMax context: Sonnet 5 1M · Opus 4.8 500K · other models 200K (paid plans). Free plan: 200K (Haiku & Sonnet only)."
			);
			setupTooltip(
				this.lengthGroup,
				this.lengthTooltip,
				{ topOffset: 8 }
			);

			setupTooltip(
				this.exportBtn,
				makeTooltip('Export this conversation as Markdown or plain text.\nActive branch only - edited-away versions are not included.'),
				{ topOffset: 8 }
			);

			setupTooltip(
				this.cachedDisplay,
				makeTooltip("Messages sent while cached are significantly cheaper."),
				{ topOffset: 8 }
			);

			setupTooltip(
				this.sessionGroup,
				makeTooltip("5-hour session window.\nThe bar shows your usage.\nThe line marks where you are in the window."),
				{ topOffset: 8 }
			);

			setupTooltip(
				this.weeklyGroup,
				makeTooltip("7-day usage window.\nThe bar shows your usage.\nThe line marks where you are in the window."),
				{ topOffset: 8 }
			);
		}

		attach() {
			this.attachHeader();
			this.attachUsageLine();
			this.refreshProgressChrome();
		}

		attachHeader() {
			const anchor = document.querySelector(CC.DOM.CHAT_MENU_TRIGGER);
			if (!anchor) return;

			if (anchor.nextElementSibling !== this.headerContainer) {
				anchor.after(this.headerContainer);
			}
			this._renderHeader();
			this.refreshProgressChrome();
		}

		attachUsageLine() {
			if (!this.usageLine) return;

			// The rounded card around the text input is the one stable landmark in the
			// composer, and the only container that keeps the row visually inside the
			// composer on both layouts. Anchor on it instead of guessing at a "toolbar
			// row": the toolbar controls are absolutely positioned (home page) or sit
			// outside the card entirely (chat page), so anchoring on them either
			// overlaps them or drops the row below the composer, against the viewport
			// edge.
			const card = document.querySelector(CC.DOM.CHAT_INPUT)?.closest(CC.DOM.COMPOSER_CARD);
			if (!card) return;

			// The card is a flex column, so appending puts the row on its own full-width
			// line below the input, inside the card's padding box.
			if (card.lastElementChild !== this.usageLine) {
				card.appendChild(this.usageLine);
			}
			this.refreshProgressChrome();
		}

		setPendingCache(pending) {
			this.pendingCache = pending;
			clearTimeout(this.pendingCacheTimeoutId);
			this.pendingCacheTimeoutId = null;
			if (!pending) return;

			// A live countdown keeps running - it jumps to the new window when the
			// refreshed conversation lands. Only show the placeholder when the timer is
			// hidden, so it doesn't pop in from nothing a few seconds later.
			if (!this.lastCachedUntilMs) {
				this._renderCache('-:--', '');
				this._renderHeader();
			}

			// A stopped or failed generation never produces a refreshed conversation,
			// so without this the placeholder would sit there indefinitely.
			this.pendingCacheTimeoutId = setTimeout(() => {
				this.pendingCacheTimeoutId = null;
				if (!this.pendingCache || this.lastCachedUntilMs) return;
				this.pendingCache = false;
				this._clearCache();
				this._renderHeader();
			}, CC.CONST.PENDING_CACHE_TIMEOUT_MS);
		}

		_renderCache(text, color) {
			this.cacheTimeSpan = Object.assign(document.createElement('span'), {
				className: 'cc-cacheTime',
				textContent: text
			});
			this.cacheTimeSpan.style.color = color;
			this.cachedDisplay.replaceChildren(document.createTextNode('Cached Context Timer:\u00A0'), this.cacheTimeSpan);
		}

		_clearCache() {
			this.cacheTimeSpan = null;
			this.cachedDisplay.textContent = '';
		}

		setConversationMetrics({ totalTokens, cachedUntil } = {}) {
			this.pendingCache = false;
			clearTimeout(this.pendingCacheTimeoutId);
			this.pendingCacheTimeoutId = null;

			if (typeof totalTokens !== 'number') {
				this.lengthDisplay.textContent = '';
				this.lengthValueSpan = null;
				this._clearCache();
				this.lastCachedUntilMs = null;
				this._renderHeader();
				return;
			}

			this.lengthValueSpan = Object.assign(document.createElement('span'), {
				textContent: `~${totalTokens.toLocaleString()} tokens`
			});
			this.lengthValueSpan.style.color = this.getProgressChrome().boldColor;
			this.lengthDisplay.replaceChildren(document.createTextNode('Token Counter: '), this.lengthValueSpan);
			this.lengthGroup.replaceChildren(this.lengthDisplay);

			// Cache timer: only present while the context is actually cached.
			const now = Date.now();
			if (typeof cachedUntil === 'number' && cachedUntil > now) {
				this.lastCachedUntilMs = cachedUntil;
				const secondsLeft = Math.max(0, Math.ceil((cachedUntil - now) / 1000));
				this._renderCache(formatSeconds(secondsLeft), this.getProgressChrome().cacheActiveColor);
			} else {
				this.lastCachedUntilMs = null;
				this._clearCache();
			}

			this._renderHeader();
		}

		_renderHeader() {
			this.headerContainer.replaceChildren();

			const hasTokens = !!this.lengthDisplay.textContent;
			const hasCache = !!this.cachedDisplay.textContent;

			if (!hasTokens) return;

			if (hasCache) {
				this.headerDisplay.replaceChildren(
					this.lengthGroup,
					document.createTextNode('\u00A0|\u00A0'),
					this.cachedDisplay
				);
			} else {
				this.headerDisplay.replaceChildren(this.lengthGroup);
			}

			this.headerContainer.appendChild(this.headerDisplay);
			if (this.exportBtn) this.headerContainer.appendChild(this.exportBtn);
		}

		setUsage(usage) {
			this.refreshProgressChrome();
			const session = usage?.five_hour || null;
			const weekly = usage?.seven_day || null;
			const hasAnyUsage =
				!!(session && typeof session.utilization === 'number') || !!(weekly && typeof weekly.utilization === 'number');
			this.usageLine?.classList.toggle('cc-hidden', !hasAnyUsage);

			if (session && typeof session.utilization === 'number') {
				const rawPct = session.utilization;
				const pct = Math.round(rawPct * 10) / 10;
				this.sessionResetMs = session.resets_at ? Date.parse(session.resets_at) : null;
				const sessionWindowMs = (session.window_hours ?? 5) * 60 * 60 * 1000;
				this.sessionWindowStartMs = this.sessionResetMs ? this.sessionResetMs - sessionWindowMs : null;
				const resetText = this.sessionResetMs ? ` (resets in ${formatResetCountdown(this.sessionResetMs)})` : '';
				this.sessionUsageSpan.textContent = `Hourly: ${pct}%${resetText}`;

				const width = Math.max(0, Math.min(100, rawPct));
				this.sessionBarFill.style.width = `${width}%`;
				this.sessionBarFill.classList.toggle('cc-caution', width >= 75 && width < 90);
				this.sessionBarFill.classList.toggle('cc-warn', width >= 90);
				this.sessionBarFill.classList.toggle('cc-full', width >= 99.5);
			} else {
				this.sessionUsageSpan.textContent = '';
				this.sessionBarFill.style.width = '0%';
				this.sessionBarFill.classList.remove('cc-caution', 'cc-warn', 'cc-full');
				this.sessionResetMs = null;
				this.sessionWindowStartMs = null;
			}

			const hasWeekly = weekly && typeof weekly.utilization === 'number';
			this.weeklyGroup?.classList.toggle('cc-hidden', !hasWeekly);
			this.sessionGroup?.classList.toggle('cc-usageGroup--single', !hasWeekly);

			if (hasWeekly) {
				this.weeklyUsageSpan.classList.remove('cc-hidden');
				this.weeklyBar.classList.remove('cc-hidden');

				const rawPct = weekly.utilization;
				const pct = Math.round(rawPct * 10) / 10;
				this.weeklyResetMs = weekly.resets_at ? Date.parse(weekly.resets_at) : null;
				const weeklyWindowMs = (weekly.window_hours ?? 168) * 60 * 60 * 1000;
				this.weeklyWindowStartMs = this.weeklyResetMs ? this.weeklyResetMs - weeklyWindowMs : null;
				const resetText = this.weeklyResetMs ? ` (resets in ${formatResetCountdown(this.weeklyResetMs)})` : '';
				this.weeklyUsageSpan.textContent = `Weekly: ${pct}%${resetText}`;

				const width = Math.max(0, Math.min(100, rawPct));
				this.weeklyBarFill.style.width = `${width}%`;
				this.weeklyBarFill.classList.toggle('cc-caution', width >= 75 && width < 90);
				this.weeklyBarFill.classList.toggle('cc-warn', width >= 90);
				this.weeklyBarFill.classList.toggle('cc-full', width >= 99.5);
			} else {
				this.weeklyUsageSpan.classList.add('cc-hidden');
				this.weeklyBar.classList.add('cc-hidden');
				this.weeklyResetMs = null;
				this.weeklyWindowStartMs = null;
				this.weeklyBarFill.classList.remove('cc-caution', 'cc-warn', 'cc-full');
			}

			this._updateMarkers();
		}

		_updateMarkers() {
			const now = Date.now();

			if (this.sessionMarker && this.sessionWindowStartMs && this.sessionResetMs) {
				const total = this.sessionResetMs - this.sessionWindowStartMs;
				const elapsed = Math.max(0, Math.min(total, now - this.sessionWindowStartMs));
				const ratio = total > 0 ? elapsed / total : 0;
				const pct = Math.max(0, Math.min(100, ratio * 100));
				this.sessionMarker.classList.remove('cc-hidden');
				this.sessionMarker.style.left = `${pct}%`;
			} else if (this.sessionMarker) {
				this.sessionMarker.classList.add('cc-hidden');
			}

			if (this.weeklyMarker && this.weeklyWindowStartMs && this.weeklyResetMs) {
				const total = this.weeklyResetMs - this.weeklyWindowStartMs;
				const elapsed = Math.max(0, Math.min(total, now - this.weeklyWindowStartMs));
				const ratio = total > 0 ? elapsed / total : 0;
				const pct = Math.max(0, Math.min(100, ratio * 100));
				this.weeklyMarker.classList.remove('cc-hidden');
				this.weeklyMarker.style.left = `${pct}%`;
			} else if (this.weeklyMarker) {
				this.weeklyMarker.classList.add('cc-hidden');
			}
		}

		tick() {
			// Cache countdown
			const now = Date.now();
			if (this.lastCachedUntilMs && this.lastCachedUntilMs > now) {
				const secondsLeft = Math.max(0, Math.ceil((this.lastCachedUntilMs - now) / 1000));
				if (this.cacheTimeSpan) {
					this.cacheTimeSpan.textContent = formatSeconds(secondsLeft);
				}
			} else if (this.lastCachedUntilMs && this.lastCachedUntilMs <= now) {
				// Window closed: drop the timer and its separator entirely, unless a
				// generation is in flight and is about to open a new window.
				this.lastCachedUntilMs = null;
				if (this.pendingCache) {
					this._renderCache('-:--', '');
				} else {
					this._clearCache();
				}
				this._renderHeader();
			}

			// Reset countdown text + time markers
			if (this.sessionResetMs && this.sessionUsageSpan?.textContent) {
				const idx = this.sessionUsageSpan.textContent.indexOf('(resets in');
				if (idx !== -1) {
					const prefix = this.sessionUsageSpan.textContent.slice(0, idx + '(resets in '.length);
					this.sessionUsageSpan.textContent = `${prefix}${formatResetCountdown(this.sessionResetMs)})`;
				}
			}

			if (this.weeklyResetMs && this.weeklyUsageSpan?.textContent) {
				const idx = this.weeklyUsageSpan.textContent.indexOf('(resets in');
				if (idx !== -1) {
					const prefix = this.weeklyUsageSpan.textContent.slice(0, idx + '(resets in '.length);
					this.weeklyUsageSpan.textContent = `${prefix}${formatResetCountdown(this.weeklyResetMs)})`;
				}
			}

			this._updateMarkers();
		}
	}

	CC.ui = {
		CounterUI
	};
})();


(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});
	if (CC.__ccUserscriptStarted) return;
	CC.__ccUserscriptStarted = true;

	const STYLE_ID = 'cc-userscript-styles';
	const STYLES = '/* Header: tokens + cache timer + export */\n.cc-header {\n\tdisplay: flex;\n\talign-items: center;\n\tgap: 6px;\n\tmargin-top: 2px;\n\tuser-select: none;\n}\n\n.cc-headerItem {\n\twhite-space: nowrap;\n}\n\n/* Usage row: session + weekly */\n.cc-usageRow {\n\tposition: relative;\n\tbox-sizing: border-box;\n\tmargin-top: 4px;\n\tpadding-inline: 8px;\n\tz-index: 50;\n\tuser-select: none;\n\ttransition: opacity 150ms ease;\n}\n\n.cc-usageRow--dim {\n\topacity: 0.6;\n}\n\n.cc-usageGroup {\n\tdisplay: flex;\n\talign-items: center;\n\tgap: 8px;\n\tflex: 1;\n\tmin-width: 0;\n}\n\n.cc-usageGroup--single {\n\twidth: 100%;\n}\n\n.cc-usageGroup--weekly {\n\tjustify-content: flex-end;\n}\n\n.cc-usageText {\n\twhite-space: nowrap;\n}\n\n/* Bars (mini + usage) */\n.cc-bar {\n\t--cc-radius: 3px;\n\t--cc-stroke: transparent;\n\t--cc-fill: transparent;\n\t--cc-fill-caution: var(--cc-fill);\n\t--cc-fill-warn: var(--cc-fill);\n\t--cc-marker: transparent;\n\n\tposition: relative;\n\tbox-sizing: border-box;\n\twidth: 100%;\n\theight: 6px;\n\tborder-radius: var(--cc-radius);\n\tborder: 1px solid var(--cc-stroke);\n\toverflow: visible;\n\tuser-select: none;\n}\n\n.cc-bar__fill {\n\twidth: 0%;\n\theight: 100%;\n\tbackground: var(--cc-fill);\n\ttransition: width 300ms ease, background-color 300ms ease;\n\tborder-top-left-radius: max(0px, calc(var(--cc-radius) - 1px));\n\tborder-bottom-left-radius: max(0px, calc(var(--cc-radius) - 1px));\n\tborder-top-right-radius: 0;\n\tborder-bottom-right-radius: 0;\n}\n\n.cc-bar__fill.cc-full {\n\tborder-top-right-radius: max(0px, calc(var(--cc-radius) - 1px));\n\tborder-bottom-right-radius: max(0px, calc(var(--cc-radius) - 1px));\n}\n\n.cc-bar__fill.cc-caution {\n\tbackground: var(--cc-fill-caution);\n}\n\n.cc-bar__fill.cc-warn {\n\tbackground: var(--cc-fill-warn);\n}\n\n.cc-bar__marker {\n\tposition: absolute;\n\ttop: 0;\n\tbottom: 0;\n\tleft: 0%;\n\twidth: 2px;\n\tbackground: var(--cc-marker);\n\tpointer-events: none;\n}\n\n.cc-bar--usage {\n\theight: 10px;\n\tflex: 1;\n}\n\n/* Tooltips */\n.cc-tooltip {\n\tposition: fixed;\n\tz-index: 9999;\n\tpadding: 4px 8px;\n\tborder-radius: 4px;\n\tfont-size: 12px;\n\twhite-space: pre-line;\n\tuser-select: none;\n\tpointer-events: none;\n\topacity: 0;\n\ttransition: opacity 200ms ease;\n}\n\n.cc-tooltipTrigger {\n\t-webkit-touch-callout: none;\n\t-webkit-user-select: none;\n\tuser-select: none;\n\tcursor: help;\n}\n\n/* Refresh button */\n.cc-refreshBtn {\n\tdisplay: inline-flex;\n\talign-items: center;\n\tjustify-content: center;\n\tflex-shrink: 0;\n\tpadding: 2px;\n\tbackground: none;\n\tborder: none;\n\tcursor: pointer;\n\topacity: 0.45;\n\ttransition: opacity 150ms ease;\n\tborder-radius: 3px;\n}\n\n.cc-refreshBtn:hover {\n\topacity: 0.9;\n}\n\n.cc-refreshBtn:active {\n\topacity: 0.6;\n}\n\n@keyframes cc-spin {\n\tfrom { transform: rotate(0deg); }\n\tto { transform: rotate(360deg); }\n}\n\n.cc-refreshBtn--spinning .cc-refreshIcon {\n\tanimation: cc-spin 0.7s linear infinite;\n}\n\n/* Export button + format menu */\n.cc-exportBtn {\n\tdisplay: inline-flex;\n\talign-items: center;\n\tjustify-content: center;\n\tflex-shrink: 0;\n\tpadding: 2px;\n\tbackground: none;\n\tborder: none;\n\tcursor: pointer;\n\topacity: 0.45;\n\ttransition: opacity 150ms ease;\n\tborder-radius: 3px;\n}\n\n.cc-exportBtn:hover {\n\topacity: 0.9;\n}\n\n.cc-exportBtn--busy {\n\topacity: 0.35;\n\tpointer-events: none;\n}\n\n.cc-exportBtn--error {\n\tcolor: #ce2029 !important;\n\topacity: 1;\n}\n\n.cc-exportMenu {\n\tposition: fixed;\n\tz-index: 9999;\n\tdisplay: flex;\n\tflex-direction: column;\n\tgap: 2px;\n\tmin-width: 150px;\n\tpadding: 4px;\n\tborder-radius: 8px;\n\tborder-width: 1px;\n\tborder-style: solid;\n\tbox-shadow: 0 8px 24px rgb(0 0 0 / 0.18);\n\tuser-select: none;\n}\n\n.cc-exportMenuItem {\n\tappearance: none;\n\tbackground: none;\n\tborder: none;\n\tcolor: inherit;\n\tfont: inherit;\n\tfont-size: 12px;\n\ttext-align: left;\n\twhite-space: nowrap;\n\tpadding: 6px 10px;\n\tborder-radius: 5px;\n\tcursor: pointer;\n}\n\n.cc-exportMenuItem:hover {\n\tbackground: rgb(127 127 127 / 0.18);\n}\n\n/* Hide optional elements completely (no layout space) */\n.cc-hidden {\n\tdisplay: none !important;\n}\n';

	function injectStyles() {
		if (document.getElementById(STYLE_ID)) return;
		const style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = STYLES;
		(document.head || document.documentElement).appendChild(style);
	}

	function getConversationId() {
		const match = window.location.pathname.match(/\/chat\/([^/?]+)/);
		return match ? match[1] : null;
	}

	function getOrgIdFromCookie() {
		try {
			return document.cookie
				.split('; ')
				.find((row) => row.startsWith('lastActiveOrg='))
				?.split('=')[1] || null;
		} catch {
			return null;
		}
	}

	function waitForElement(selector, timeoutMs) {
		return new Promise((resolve) => {
			const existing = document.querySelector(selector);
			if (existing) {
				resolve(existing);
				return;
			}

			let timeoutId;
			const observer = new MutationObserver(() => {
				const el = document.querySelector(selector);
				if (el) {
					if (timeoutId) clearTimeout(timeoutId);
					observer.disconnect();
					resolve(el);
				}
			});

			observer.observe(document.body, { childList: true, subtree: true });

			if (timeoutMs) {
				timeoutId = setTimeout(() => {
					observer.disconnect();
					resolve(null);
				}, timeoutMs);
			}
		});
	}

	CC.waitForElement = waitForElement;

	function parseUsageFromUsageEndpoint(raw) {
		if (!raw || typeof raw !== 'object') return null;

		const normalizeWindow = (w, hours) => {
			if (!w || typeof w !== 'object') return null;
			if (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
			const utilization = Math.max(0, Math.min(100, w.utilization));
			const resets_at = typeof w.resets_at === 'string' ? w.resets_at : null;
			return { utilization, resets_at, window_hours: hours };
		};

		const fiveHour = normalizeWindow(raw.five_hour, 5);
		const sevenDay = normalizeWindow(raw.seven_day, 24 * 7);

		if (!fiveHour && !sevenDay) return null;
		return { five_hour: fiveHour, seven_day: sevenDay };
	}

	function parseUsageFromMessageLimit(raw) {
		if (!raw?.windows || typeof raw.windows !== 'object') return null;

		const normalizeWindow = (w, hours) => {
			if (!w || typeof w !== 'object') return null;
			if (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
			const utilization = Math.max(0, Math.min(100, w.utilization * 100));
			const resets_at = typeof w.resets_at === 'number' && Number.isFinite(w.resets_at)
				? new Date(w.resets_at * 1000).toISOString()
				: null;
			return { utilization, resets_at, window_hours: hours };
		};

		const fiveHour = normalizeWindow(raw.windows['5h'], 5);
		const sevenDay = normalizeWindow(raw.windows['7d'], 24 * 7);

		if (!fiveHour && !sevenDay) return null;
		return { five_hour: fiveHour, seven_day: sevenDay };
	}

	let currentConversationId = null;
	let currentOrgId = null;

	let usageState = null;
	let usageResetMs = { five_hour: null, seven_day: null };
	let lastUsageSseMs = 0;
	let usageFetchInFlight = false;
	let lastUsageUpdateMs = 0;
	const rolloverHandledForResetMs = { five_hour: null, seven_day: null };

	const ui = new CC.ui.CounterUI({
		onUsageRefresh: async () => {
			await refreshUsage();
		},
		onExport: async (format) => {
			await exportConversation(format);
		}
	});

	const originalFetch = CC._ccInternal?.originalFetch || (window.fetch ? window.fetch.bind(window) : null);

	function applyUsageUpdate(normalized, source) {
		if (!normalized) return;
		const now = Date.now();
		usageState = normalized;
		lastUsageUpdateMs = now;
		if (source === 'sse') lastUsageSseMs = now;
		usageResetMs.five_hour = normalized.five_hour?.resets_at ? Date.parse(normalized.five_hour.resets_at) : null;
		usageResetMs.seven_day = normalized.seven_day?.resets_at ? Date.parse(normalized.seven_day.resets_at) : null;
		ui.setUsage(normalized);
	}

	function updateOrgIdIfNeeded(newOrgId) {
		if (newOrgId && typeof newOrgId === 'string' && newOrgId !== currentOrgId) {
			currentOrgId = newOrgId;
		}
	}

	async function requestUsage(orgId) {
		if (!originalFetch) return null;
		const res = await originalFetch(`https://claude.ai/api/organizations/${orgId}/usage`, {
			method: 'GET',
			credentials: 'include'
		});
		return await res.json();
	}

	async function requestConversation(orgId, conversationId) {
		if (!originalFetch) return null;
		const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=true&rendering_mode=messages&render_all_tools=true`;
		const res = await originalFetch(url, {
			method: 'GET',
			credentials: 'include'
		});
		const json = await res.json();
		return json;
	}

	async function refreshUsage() {
		const orgId = currentOrgId || getOrgIdFromCookie();
		if (!orgId) return;
		updateOrgIdIfNeeded(orgId);

		if (usageFetchInFlight) return;
		usageFetchInFlight = true;
		let raw;
		try {
			raw = await requestUsage(orgId);
		} catch {
			return;
		} finally {
			usageFetchInFlight = false;
		}

		const parsed = parseUsageFromUsageEndpoint(raw);
		applyUsageUpdate(parsed, 'usage');
	}

	async function refreshConversation() {
		if (!currentConversationId) {
			ui.setConversationMetrics();
			return;
		}

		const orgId = currentOrgId || getOrgIdFromCookie();
		if (!orgId) return;
		updateOrgIdIfNeeded(orgId);

		try {
			const data = await requestConversation(orgId, currentConversationId);
			await handleConversationPayload({ orgId, conversationId: currentConversationId, data });
		} catch {
			// ignore
		}
	}

	async function exportConversation(format) {
		await bridgeReady;
		if (!currentConversationId) return;

		const orgId = currentOrgId || getOrgIdFromCookie();
		if (!orgId) return;
		updateOrgIdIfNeeded(orgId);

		// Fetch fresh rather than reusing the last payload, so an export always
		// includes the turn that just finished.
		const data = await CC.bridge.requestConversation(orgId, currentConversationId);
		if (data) CC.exportChat.download(data, format);
	}

	function handleGenerationStart() {
		if (!currentConversationId) return;
		ui.setPendingCache(true);
	}

	async function handleConversationPayload({ orgId, conversationId, data }) {
		if (!conversationId || conversationId !== currentConversationId) return;
		updateOrgIdIfNeeded(orgId);
		if (!data) return;

		const metrics = await CC.tokens.computeConversationMetrics(data);
		ui.setConversationMetrics({ totalTokens: metrics.totalTokens, cachedUntil: metrics.cachedUntil });
	}

	function handleMessageLimit(messageLimit) {
		const parsed = parseUsageFromMessageLimit(messageLimit);
		applyUsageUpdate(parsed, 'sse');
	}

	async function handleUrlChange() {
		currentConversationId = getConversationId();

		waitForElement(CC.DOM.CHAT_INPUT, 60000).then((el) => {
			if (el) ui.attachUsageLine();
		});
		waitForElement(CC.DOM.CHAT_MENU_TRIGGER, 60000).then((el) => {
			if (el) ui.attachHeader();
		});

		if (!currentConversationId) {
			ui.setConversationMetrics();
			return;
		}

		updateOrgIdIfNeeded(getOrgIdFromCookie());

		await refreshConversation();

		if (!usageState) await refreshUsage();
	}

	function tick() {
		ui.tick();

		const now = Date.now();
		if (usageResetMs.five_hour && now >= usageResetMs.five_hour && rolloverHandledForResetMs.five_hour !== usageResetMs.five_hour) {
			rolloverHandledForResetMs.five_hour = usageResetMs.five_hour;
			refreshUsage();
		}
		if (usageResetMs.seven_day && now >= usageResetMs.seven_day && rolloverHandledForResetMs.seven_day !== usageResetMs.seven_day) {
			rolloverHandledForResetMs.seven_day = usageResetMs.seven_day;
			refreshUsage();
		}

		const ONE_HOUR_MS = 60 * 60 * 1000;
		const sseAge = now - lastUsageSseMs;
		const anyAge = now - lastUsageUpdateMs;
		if (!document.hidden && sseAge > ONE_HOUR_MS && anyAge > ONE_HOUR_MS) {
			refreshUsage();
		}
	}

	function start() {
		injectStyles();
		ui.initialize();
		CC._ccInternal.onGenerationStart = handleGenerationStart;
		CC._ccInternal.onConversationData = handleConversationPayload;
		CC._ccInternal.onMessageLimit = handleMessageLimit;
		CC._ccInternal.onUrlChange = handleUrlChange;

		handleUrlChange();
		setInterval(tick, 1000);
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', start, { once: true });
	} else {
		start();
	}
})();
