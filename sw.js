importScripts('core.js');

const reply = (sendResponse) => (ok, err) =>
	sendResponse({ ok, err: err ? String(err) : undefined });

/**
 * Run tab mutations one at a time. Startup grouping and the per-tab handlers
 * fire together on session restore; letting them interleave makes them undo
 * each other's ungroup/group calls.
 */
let queue = Promise.resolve();
const serial = (fn) => {
	const run = queue.then(fn);
	queue = run.catch(() => {});
	return run;
};

const runIfAutomatic = (fn, where) =>
	serial(() => getOpts().then((opts) => opts.automatic && fn())).catch(logWarn(where));

const startupGroup = () =>
	waitForTabsSettled().then(() => groupAllWindows({ adoptByTitle: true }));

chrome.runtime.onInstalled.addListener((d) => {
	if (d.reason === 'install')
		runIfAutomatic(() => groupAllWindows({ adoptByTitle: true }), 'install');
	if (d.reason === 'update') {
		chrome.storage.sync.remove(LEGACY_AUTO_IDS_KEY).catch(logWarn('drop legacy ids'));
		// Stamp groups created by older versions so they stay managed.
		serial(() => getManualGroupIds({ adoptByTitle: true })).catch(logWarn('update adopt'));
	}
});
chrome.runtime.onStartup.addListener(() => runIfAutomatic(startupGroup, 'startup'));
chrome.management.onEnabled.addListener((d) =>
	d.id === chrome.runtime.id ? runIfAutomatic(() => groupAllWindows(), 'enabled') : null,
);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
	const r = reply(sendResponse);
	if (msg.action === 'groupNow')
		serial(() => groupAllTabs())
			.then(() => r(true))
			.catch((e) => r(false, e));
	if (msg.action === 'ungroupAll')
		serial(() => ungroupAllTabs())
			.then(() => r(true))
			.catch((e) => r(false, e));
	return true;
});

chrome.commands.onCommand.addListener((cmd) => {
	if (cmd === 'group-now') serial(() => groupAllTabs()).catch(logWarn('group-now'));
	if (cmd === 'ungroup-all') serial(() => ungroupAllTabs()).catch(logWarn('ungroup-all'));
});

const assignUnlessDuplicate = (windowId, tabId, url) =>
	focusExistingAndCloseNew(windowId, tabId, url).then((focused) =>
		focused ? undefined : assignTabToGroup(tabId, url, windowId),
	);

chrome.tabs.onCreated.addListener((tab) => {
	if (!tab.url?.startsWith('http')) return;
	runIfAutomatic(() => assignUnlessDuplicate(tab.windowId, tab.id, tab.url), 'tab created');
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
	if (!changeInfo.url) return;
	runIfAutomatic(() => assignUnlessDuplicate(tab.windowId, tabId, changeInfo.url), 'tab updated');
});
chrome.tabs.onActivated.addListener((info) =>
	runIfAutomatic(() => collapseInactiveInWindow(info.windowId, info.tabId), 'tab activated'),
);
