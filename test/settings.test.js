// Every popup toggle must actually remove its element from the page.
const { load, section, t, report } = require('./harness');

const ctx = load('src/content/constants.js', 'src/content/ui.js');
const ui = new ctx.ClaudeCounter.ui.CounterUI();
ui.initialize();
ui.setConversationMetrics({ totalTokens: 42, cachedUntil: Date.now() + 180000 });
ui.setUsage({
	five_hour: { utilization: 20, resets_at: new Date(Date.now() + 3e6).toISOString() },
	seven_day: { utilization: 40, resets_at: new Date(Date.now() + 6e8).toISOString() }
});

const header = () => ui.headerContainer.textContent;
const inHeader = (el) => ui.headerContainer.children.includes(el) ||
	ui.headerDisplay.children.includes(el);
const hidden = (el) => !!el && el.classList.contains('cc-hidden');

section('defaults show everything');
t('token counter', header().includes('Token Counter'));
t('cache timer', header().includes('Cached Context Timer'));
t('export button', inHeader(ui.exportBtn));
t('session bar', !hidden(ui.sessionGroup));
t('weekly bar', !hidden(ui.weeklyGroup));
t('usage refresh button', !hidden(ui.refreshBtn));

section('each toggle removes exactly its own element');
ui.applySettings({ tokenCounter: false });
t('token counter off', !header().includes('Token Counter'));
t('  cache timer survives', header().includes('Cached Context Timer'));
t('  no stray separator', !header().includes('|'));

ui.applySettings({ cacheTimer: false });
t('cache timer off', !header().includes('Cached Context Timer'));
t('  token counter survives', header().includes('Token Counter'));

ui.applySettings({ exportButton: false });
t('export button off', !inHeader(ui.exportBtn));

ui.applySettings({ sessionBar: false });
t('session bar off', hidden(ui.sessionGroup));
t('  weekly bar survives', !hidden(ui.weeklyGroup));
t('  row still visible', !hidden(ui.usageLine));

ui.applySettings({ weeklyBar: false });
t('weekly bar off', hidden(ui.weeklyGroup));
t('  session bar survives', !hidden(ui.sessionGroup));

ui.applySettings({ usageRefresh: false });
t('usage refresh button off', hidden(ui.refreshBtn));
t('  bars survive', !hidden(ui.sessionGroup) && !hidden(ui.weeklyGroup));
t('  row still visible', !hidden(ui.usageLine));

section('combinations');
ui.applySettings({ sessionBar: false, weeklyBar: false });
t('both bars off hides the whole row', hidden(ui.usageLine));

ui.applySettings({ tokenCounter: false, cacheTimer: false, exportButton: false });
t('everything off leaves an empty header', ui.headerContainer.children.length === 0);

ui.applySettings({});
t('restoring defaults brings it all back',
	header().includes('Token Counter') && header().includes('Cached Context Timer') &&
	inHeader(ui.exportBtn) && !hidden(ui.usageLine) && !hidden(ui.sessionGroup));

section('settings never reveal an empty row');
// applySettings runs at page load, before any usage has arrived.
const fresh = new ctx.ClaudeCounter.ui.CounterUI();
fresh.initialize();
t('hidden before any data', hidden(fresh.usageLine));
fresh.applySettings({});
t('still hidden after settings load', hidden(fresh.usageLine));
fresh.applySettings({ sessionBar: true, weeklyBar: true });
t('still hidden with every bar switched on', hidden(fresh.usageLine));

section('settings never resurrect missing data');
ui.setUsage({ five_hour: { utilization: 10, resets_at: new Date(Date.now() + 3e6).toISOString() }, seven_day: null });
ui.applySettings({ weeklyBar: true });
t('weekly stays hidden with no weekly data', hidden(ui.weeklyGroup));

process.exit(report('settings'));
