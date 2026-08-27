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
