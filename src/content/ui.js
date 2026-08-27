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
