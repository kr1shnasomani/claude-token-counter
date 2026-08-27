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
