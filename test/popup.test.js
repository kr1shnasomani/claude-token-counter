// The popup runs in its own document, so these checks are structural: they verify
// the three panels, their controls, and the issue URL the feedback form builds.
const fs = require('fs');
const path = require('path');
const { section, t, report } = require('./harness');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const html = read('src/popup/popup.html');
const js = read('src/popup/popup.js');
const css = read('src/popup/popup.css');

section('three panels, one switcher');
for (const id of ['content', 'settings', 'feedback']) {
	t('panel exists: ' + id, html.includes(`id="${id}"`));
}
t('switcher handles all three', ['usage', 'settings', 'feedback'].every((p) => js.includes(`${p}:`) || js.includes(`'${p}'`)));
t('clicking an open panel returns to usage', js.includes('togglePanel'));

section('action icons');
for (const [id, tip] of [['refresh', 'Refresh'], ['settingsBtn', 'Settings'], ['feedbackBtn', 'Send feedback']]) {
	t(`${id} has hover label "${tip}"`, html.includes(`id="${id}"`) && html.includes(`data-tip="${tip}"`));
}
t('no sluggish native title attributes left', !/<button class="icon"[^>]*title=/.test(html));
t('hover label is styled, not native', css.includes('[data-tip]::after') && css.includes('content: attr(data-tip)'));
t('last icon label hangs left so it cannot clip', css.includes('.icon:last-child[data-tip]::after'));

section('feedback opens a prefilled issue, never posts one');
t('points at the repo', js.includes('github.com/kr1shnasomani/claude-token-counter/issues/new'));
t('no GitHub token anywhere', !/gh[pousr]_[A-Za-z0-9]/.test(js) && !js.includes('Authorization'));
t('does not call the GitHub API', !js.includes('api.github.com'));
t('opens in a new tab with noopener', js.includes("window.open(url, '_blank', 'noopener')"));
t('title and body are encoded', js.includes('encodeURIComponent'));
t('send is disabled until something is typed', js.includes('send.disabled = !text.value.trim()'));

section('the report says what it includes');
t('note is shown to the user', html.includes('id="feedbackNote"') && js.includes('prefilled issue on GitHub'));
for (const fact of ['Extension:', 'Browser:', 'Plan:', 'Claude UI:']) {
	t('reports ' + fact, js.includes(fact));
}
t('UI variant is captured on the page', read('src/content/ui.js').includes("CC.uiVariant = byClass ? 'new' : 'old'"));
t('and carried in the snapshot', read('src/content/main.js').includes('uiVariant: CC.uiVariant'));

section('bars change colour at the same thresholds as the page');
// A limit should look equally urgent on either surface. The page uses 75% and
// 90%; the popup was left plain blue, which is worst exactly when it matters.
t('caution below 90', js.includes("toggle('caution', pct >= 75 && pct < 90)"));
t('warn at 90 and above', js.includes("toggle('warn', pct >= 90)"));
t('thresholds match ui.js', read('src/content/ui.js').includes("'cc-caution', width >= 75 && width < 90") &&
	read('src/content/ui.js').includes("'cc-warn', width >= 90"));
t('colours match CC.COLORS', css.toLowerCase().includes('#f0b544') && css.toLowerCase().includes('#ce2029'));
const constants = read('src/content/constants.js').toLowerCase();
t('amber is the same value the page uses', constants.includes('#f0b544'));
t('red is the same value the page uses', constants.includes('#ce2029'));
t('defined in both light and dark', (css.match(/--fill-caution:/g) || []).length === 2);
t('a stale window drops its colour', js.includes("classList.remove('caution', 'warn')"));

section('browser is identified, not guessed from the user agent');
// Brave reports itself as Chrome on purpose; only navigator.brave gives it away.
t('checks navigator.brave first', js.includes('navigator.brave') && js.includes('isBrave()'));
for (const b of ['Brave', 'Edge', 'Opera', 'Vivaldi', 'Firefox', 'Chrome', 'Safari']) {
	t('detects ' + b, js.includes(`'${b}'`));
}
t('reports a readable name, not the raw agent', !js.includes('${navigator.userAgent}'));

section('the draft survives the popup closing');
t('draft has its own key', js.includes("DRAFT_KEY = 'cc:feedbackDraft'"));
t('restored on open', js.includes('storageGet(storage, DRAFT_KEY)'));
t('saved as you type, debounced', js.includes('saveTimer') && js.includes('storage.set({ [DRAFT_KEY]: text.value })'));
t('cleared only once the report is sent', js.includes('storage.remove'));
t('does not clobber text already in the box', js.includes('&& !text.value'));

section('no extra permissions were needed');
const manifest = JSON.parse(read('manifest.json'));
t('permissions unchanged', JSON.stringify(manifest.permissions) === '["storage"]');
t('github not in host permissions', JSON.stringify(manifest.optional_host_permissions) === '["https://claude.ai/*"]');

process.exit(report('popup'));
