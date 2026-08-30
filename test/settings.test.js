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

section('a window with no reading keeps its slot, marked unknown');
// Discarding a still-valid weekly figure because the five-hour one had rolled
// over left free users with nothing for hours at a time. The valid figure is a
// floor, not stale data: usage only advances when a message is sent. Keep it,
// and mark the missing one rather than dropping a bar and leaving one alone.
const later = (ms) => new Date(Date.now() + ms).toISOString();
const only = (usage) => {
	const u = new ctx.ClaudeCounter.ui.CounterUI();
	u.initialize();
	u.applySettings({});
	u.setUsage(usage);
	return u;
};

let one = only({ five_hour: null, seven_day: { utilization: 29, resets_at: later(3 * 86400e3) } });
t('weekly figure is kept', !hidden(one.weeklyGroup) && one.weeklyUsageSpan.textContent.includes('29%'));
t('hourly slot stays, marked unknown', !hidden(one.sessionGroup) && one.sessionUsageSpan.textContent === 'Hourly: \u2014');
t('  no lone bar', !hidden(one.usageLine));

one = only({ five_hour: { utilization: 2, resets_at: later(5 * 3600e3) }, seven_day: null });
t('the mirror case works too', one.weeklyUsageSpan.textContent === 'Weekly: \u2014' && one.sessionUsageSpan.textContent.includes('2%'));

one = only({ five_hour: { utilization: 2, resets_at: later(5 * 3600e3) },
	seven_day: { utilization: 29, resets_at: later(3 * 86400e3) } });
t('both present: no dashes', !one.usageLine.textContent.includes('\u2014'));

section('an account with no usage says so instead of looking broken');
// Free plans publish no usage windows until a message has been sent. A blank
// composer reads as a broken extension, so the row explains itself instead.
const blank = new ctx.ClaudeCounter.ui.CounterUI();
blank.initialize();
blank.applySettings({});
t('nothing known yet: row stays hidden', hidden(blank.usageLine));

blank.markUsageUnavailable();
t('API reports none: row appears', !hidden(blank.usageLine));
t('  with the hint', !hidden(blank.usageHint));
t('  and no empty bars', hidden(blank.sessionGroup) && hidden(blank.weeklyGroup));

blank.setUsage({
	five_hour: { utilization: 2, resets_at: new Date(Date.now() + 5 * 3600e3).toISOString() },
	seven_day: { utilization: 0, resets_at: new Date(Date.now() + 6 * 86400e3).toISOString() }
});
t('real data replaces the hint', hidden(blank.usageHint));
t('  and shows both bars', !hidden(blank.sessionGroup) && !hidden(blank.weeklyGroup));

blank.markUsageUnavailable();
t('a later empty response cannot undo it', hidden(blank.usageHint) && !hidden(blank.sessionGroup));

section('a stored reading keeps what is still true');
// The five-hour window rolls over every five hours; the seven-day one does not.
// Seeding "whichever window is still valid" therefore produced a weekly bar on its
// own on most page loads, which looks broken. The guard now requires both.
const main = require('fs').readFileSync(require('path').join(__dirname, '..', 'src/content/main.js'), 'utf8');
t('seed keeps whichever window is still valid', main.includes('if (!five_hour && !seven_day) return;'));
t('seed drops windows whose reset has passed', main.includes('current(snapshot.five_hour) ? snapshot.five_hour : null'));
t('a seed is always replaced by a live fetch', main.includes('if (!usageState || usageIsSeeded) await refreshUsage();'));
t('a seed does not stamp the freshness clock', main.includes('if (!seeded) lastUsageUpdateMs = now;'));

section('settings never invent a figure');
ui.setUsage({ five_hour: { utilization: 10, resets_at: new Date(Date.now() + 3e6).toISOString() }, seven_day: null });
ui.applySettings({ weeklyBar: true });
t('weekly shows a dash rather than a stale figure', ui.weeklyUsageSpan.textContent === 'Weekly: \u2014');

process.exit(report('settings'));
