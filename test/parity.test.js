// The userscript is a hand-maintained bundle of the same sources. It silently
// drifted a full release behind once; this suite makes that loud.
const fs = require('fs');
const path = require('path');
const { section, t, report } = require('./harness');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const userscript = read('userscript/claude-counter.user.js');

/** Everything from `marker` up to the line that is exactly `end`. */
function slice(source, marker, end) {
	const lines = source.split('\n');
	const a = lines.findIndex((l) => l.includes(marker));
	if (a === -1) return null;
	const b = lines.findIndex((l, i) => i > a && l === end);
	if (b === -1) return null;
	return lines.slice(a, b + 1).join('\n');
}

section('shared modules are byte-identical');
const ui = slice(read('src/content/ui.js'), 'function formatSeconds', '\t}');
t('ui layer', ui !== null && userscript.includes(ui));

const exportModule = read('src/content/export.js').trim();
t('export module', userscript.includes(exportModule));

section('constants match');
const constants = read('src/content/constants.js');
for (const name of ['CC.DOM', 'CC.CONST', 'CC.COLORS']) {
	const block = constants.match(new RegExp(name.replace('.', '\\.') + ' = Object\\.freeze\\(\\{[\\s\\S]*?\\n\\t\\}\\);\\n'));
	t(name, block !== null && userscript.includes(block[0]));
}

section('stylesheet is in sync');
const css = read('src/styles.css');
const inlined = css.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\t/g, '\\t').replace(/\n/g, '\\n');
t('inlined STYLES matches src/styles.css', userscript.includes("const STYLES = '" + inlined + "';"));

section('no stale selectors');
for (const dead of ['chat-menu-trigger', 'chat-input-grid-container', 'chat-input-grid-area', 'CONTEXT_LIMIT_TOKENS', 'cc-bar--mini']) {
	t('gone: ' + dead, !userscript.includes(dead) && !read('src/content/ui.js').includes(dead));
}

section('versions are aligned');
const manifest = JSON.parse(read('manifest.json'));
const tag = (userscript.match(/@version\s+(\S+)/) || [])[1];
t('userscript version tracks manifest', tag === manifest.version + '-userscript', `manifest ${manifest.version}, userscript ${tag}`);

section('manifest loads every content script');
for (const f of manifest.content_scripts[0].js) {
	t('exists: ' + f, fs.existsSync(path.join(ROOT, f)));
}
t('export.js is loaded', manifest.content_scripts[0].js.includes('src/content/export.js'));
t('still requests no permissions', !manifest.permissions && !manifest.host_permissions);

process.exit(report('parity'));
