const OPT_KEYS = [
  "automatic",
  "groupBySubdomain",
  "sortAlphabetically",
  "ignorePinnedTabs",
  "collapseInactive",
  "avoidDuplicates",
];
const OPT_DEFAULTS = { automatic: true, ignorePinnedTabs: true };
/** Legacy storage.sync key that held auto-created group IDs. IDs change on browser restart, so it is no longer used. */
const LEGACY_AUTO_IDS_KEY = "autoCreatedGroupIds";

/**
 * Invisible suffix stamped on every group title we create. Titles survive a
 * browser restart (group IDs do not), so this is how a generated group is told
 * apart from a hand-made one. Renaming a group drops the mark, making it manual.
 */
const AUTO_MARK = "​";
/** Groups created this session: covers the gap between tabs.group() and the title update. */
const sessionAutoIds = new Set();
const markAuto = (ids) => {
  for (const id of ids) sessionAutoIds.add(id);
};
const hasAutoMark = (g) => g.title?.endsWith(AUTO_MARK) ?? false;
const bareTitle = (key) => key?.split(".")[0] ?? key;

/** Legacy/restored group without the mark whose title equals the domain title of every tab in it. */
const matchesDomainTitle = (g, groupTabs, groupBySubdomain) => {
  if (!g.title || !groupTabs.length) return false;
  const keys = new Set(groupTabs.map((t) => getKey(t.url, groupBySubdomain)));
  if (keys.size !== 1) return false;
  const [key] = keys;
  return key != null && bareTitle(key) === g.title;
};

const stampAutoMark = (g) =>
  chrome.tabGroups.update(g.id, { title: g.title + AUTO_MARK }).catch(() => {});

/**
 * Set of group IDs we should ignore: groups we did not create (manually created).
 * With adoptByTitle, unmarked groups that match their tabs' domain title are
 * adopted and stamped instead (used after browser restart and extension update).
 */
async function getManualGroupIds({ adoptByTitle = false } = {}) {
  const [groups, tabs, opts] = await Promise.all([
    chrome.tabGroups.query({}),
    adoptByTitle ? chrome.tabs.query({}) : Promise.resolve([]),
    getOpts(),
  ]);
  const manual = new Set();
  for (const g of groups) {
    if (hasAutoMark(g) || sessionAutoIds.has(g.id)) continue;
    const groupTabs = tabs.filter((t) => t.groupId === g.id);
    if (
      adoptByTitle &&
      matchesDomainTitle(g, groupTabs, opts.groupBySubdomain)
    ) {
      markAuto([g.id]);
      await stampAutoMark(g);
      continue;
    }
    manual.add(g.id);
  }
  return manual;
}

const RESTRICTED_HOSTS =
  /^(chrome\.google\.com|chromewebstore\.google\.com|addons\.mozilla\.org|addons\.allizom\.org)$/;
const isRestrictedUrl = (url) => {
  if (!url?.startsWith("http")) return true;
  try {
    return RESTRICTED_HOSTS.test(new URL(url).hostname.replace(/^www\./i, ""));
  } catch {
    return true;
  }
};
const hostnameFromUrl = (url) => {
  if (!url?.startsWith("http")) return null;
  try {
    const h = new URL(url).hostname;
    return h || null;
  } catch {
    return null;
  }
};
const keyFromHostname = (hostname, groupBySubdomain) => {
  if (!hostname) return null;
  const raw = hostname.replace(/^www\./i, "");
  if (groupBySubdomain) return raw;
  const parts = raw.split(".");
  if (parts.length <= 2) return raw;
  const n = parts[parts.length - 1].length === 2 ? 3 : 2;
  return parts.slice(-n).join(".");
};
const getKey = (url, groupBySubdomain) =>
  isRestrictedUrl(url)
    ? null
    : keyFromHostname(hostnameFromUrl(url), groupBySubdomain);
/** Display title: domain → first label (e.g. google), subdomain → first label (e.g. foo); carries AUTO_MARK. */
const getTitle = (key) => `${bareTitle(key) ?? ""}${AUTO_MARK}`;

const getOpts = () =>
  new Promise((resolve) => {
    chrome.storage.sync.get(OPT_KEYS, (o) =>
      resolve({
        ...Object.fromEntries(
          OPT_KEYS.map((k) => [k, OPT_DEFAULTS[k] ?? false]),
        ),
        ...o,
      }),
    );
  });

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const isGrouped = (t) => t.groupId != null && t.groupId !== -1;
const getWin = (id) =>
  id != null
    ? Promise.resolve(id)
    : chrome.windows
        .getLastFocused()
        .then((w) => w?.id)
        .catch(() => null);

const includeTab = (opts) => (t) => !opts.ignorePinnedTabs || !t.pinned;
const buildByKey = (tabs, opts) =>
  tabs.filter(includeTab(opts)).reduce((map, tab) => {
    const key = getKey(tab.url, opts.groupBySubdomain);
    if (key) map.set(key, [...(map.get(key) || []), tab.id]);
    return map;
  }, new Map());

async function createGroup({ windowId, key, tabIds, idx }) {
  const groupId = await chrome.tabs.group({
    tabIds,
    createProperties: { windowId },
  });
  markAuto([groupId]);
  await chrome.tabGroups.update(groupId, { title: getTitle(key) });
  return { groupId, title: key, key, idx };
}

const groupContainsTab = (groupId, tabId) =>
  chrome.tabs
    .query({ groupId })
    .then((tabs) => tabs.some((t) => t.id === tabId));

const MOVE_IN_GROUP_ERR = "index that is in the middle of another group";
const collapseGroupWithMove = (groupId, index) =>
  chrome.tabGroups
    .update(groupId, { collapsed: true })
    .then(() => chrome.tabGroups.move(groupId, { index: -1 }))
    .then(() => chrome.tabGroups.move(groupId, { index }))
    .catch((err) => {
      if (!String(err?.message ?? err).includes(MOVE_IN_GROUP_ERR)) throw err;
    });

const TAB_EDIT_BLOCKED = "Tabs cannot be edited right now";
const isEditBlocked = (err) =>
  String(err?.message ?? err).includes(TAB_EDIT_BLOCKED);
/** Retry fn while Chrome reports tabs are mid-edit (drag, session restore). */
const retryIfEditBlocked = (fn, tries = 3) =>
  fn().catch((err) =>
    tries > 1 && isEditBlocked(err)
      ? delay(200).then(() => retryIfEditBlocked(fn, tries - 1))
      : Promise.reject(err),
  );

const collapseWithRetry = (groupId, index) =>
  collapseGroupWithMove(groupId, index).catch((err) => {
    if (!String(err?.message ?? err).includes(TAB_EDIT_BLOCKED)) throw err;
    return delay(80).then(() =>
      collapseGroupWithMove(groupId, index).catch(() => {}),
    );
  });

const getFocusedTabId = (windowId, activeTabId) =>
  activeTabId != null
    ? Promise.resolve(activeTabId)
    : chrome.tabs.query({ windowId, active: true }).then((t) => t[0]?.id);

const shouldCollapseGroup = (g, focusedTabId) =>
  groupContainsTab(g.id, focusedTabId).then(
    (focused) => !focused && !g.collapsed,
  );

async function collapseOneGroup(g, i, focusedTabId) {
  if (!(await shouldCollapseGroup(g, focusedTabId))) return;
  await collapseWithRetry(g.id, i);
  await delay(40);
}

async function collapseInactiveInWindow(windowId, activeTabId = null) {
  const opts = await getOpts();
  if (!opts.collapseInactive) return;
  const focusedTabId = await getFocusedTabId(windowId, activeTabId);
  if (!focusedTabId) return;
  if (activeTabId) await delay(150);
  const [groups, manualSet] = await Promise.all([
    chrome.tabGroups.query({ windowId }),
    getManualGroupIds(),
  ]);
  const toCollapse = groups.filter((g) => !manualSet.has(g.id));
  await Promise.all(
    toCollapse.map((g, i) => collapseOneGroup(g, i, focusedTabId)),
  );
}

const applyTitleRefresh = (groupId, key) =>
  chrome.tabGroups.update(groupId, { title: getTitle(key) });

const groupTabIdsByUrl = (tabs) =>
  tabs
    .filter((t) => t.url?.startsWith("http"))
    .reduce((acc, t) => {
      acc[t.url] = [...(acc[t.url] || []), t.id];
      return acc;
    }, {});

const duplicateTabIdsToRemove = (byUrl, activeId, excludeTabIds) =>
  Object.values(byUrl)
    .filter((ids) => ids.length > 1)
    .flatMap((ids) => {
      const keep = ids.includes(activeId) ? activeId : ids[0];
      return ids.filter((id) => id !== keep && !excludeTabIds.has(id));
    });

async function removeDuplicateTabsInWindow(windowId) {
  const opts = await getOpts();
  if (!opts.avoidDuplicates) return;
  const [tabs, activeTabs, manualSet] = await Promise.all([
    chrome.tabs.query({ windowId }),
    chrome.tabs.query({ windowId, active: true }),
    getManualGroupIds(),
  ]);
  const activeId = activeTabs[0]?.id;
  const inManualGroup = new Set(
    tabs
      .filter((t) => t.groupId != null && manualSet.has(t.groupId))
      .map((t) => t.id),
  );
  const toRemove = duplicateTabIdsToRemove(
    groupTabIdsByUrl(tabs),
    activeId,
    inManualGroup,
  );
  if (toRemove.length) await chrome.tabs.remove(toRemove);
}

const createGroupsForEntries = (win, entries) =>
  Promise.all(
    entries.map(([key, tabIds], idx) =>
      chrome.tabs
        .group({ tabIds, createProperties: { windowId: win } })
        .then(async (groupId) => {
          markAuto([groupId]);
          await chrome.tabGroups.update(groupId, { title: getTitle(key) });
          return { groupId, title: key, key, idx };
        }),
    ),
  );

const applyTitlesToGroups = (groupIds) =>
  delay(300).then(() =>
    Promise.all(
      groupIds.map(({ groupId, key }) => applyTitleRefresh(groupId, key)),
    ),
  );

const sortGroupsByTitle = (groupIds) => {
  groupIds.sort((a, b) => a.title.localeCompare(b.title));
  return Promise.all(
    groupIds.map((g, i) =>
      chrome.tabGroups.move(g.groupId, { index: i }).catch((err) => {
        if (!String(err?.message ?? err).includes(MOVE_IN_GROUP_ERR)) throw err;
      }),
    ),
  );
};

async function groupAllTabs(windowId, { adoptByTitle = false } = {}) {
  const opts = await getOpts();
  const win = await getWin(windowId);
  if (!win) return;
  if (adoptByTitle) await getManualGroupIds({ adoptByTitle });
  await removeDuplicateTabsInWindow(win);
  const [tabs, manualSet] = await Promise.all([
    chrome.tabs.query({ windowId: win }),
    getManualGroupIds(),
  ]);
  const notManual = (t) =>
    t.groupId == null || t.groupId === -1 || !manualSet.has(t.groupId);
  const toRegroup = tabs.filter(notManual);
  const toUngroup = toRegroup.filter(isGrouped).map((t) => t.id);
  if (toUngroup.length) await chrome.tabs.ungroup(toUngroup);
  const entries = [...buildByKey(toRegroup, opts).entries()];
  const groupIds = await createGroupsForEntries(win, entries);
  await applyTitlesToGroups(groupIds);
  if (opts.sortAlphabetically && groupIds.length)
    await sortGroupsByTitle(groupIds);
  if (opts.collapseInactive && groupIds.length) {
    await delay(100);
    await collapseInactiveInWindow(win);
  }
}

const logWarn = (where) => (err) =>
  console.warn(`[smart-tab-groups] ${where}:`, err);

/** Group every normal window; one window failing does not stop the rest. */
async function groupAllWindows({ adoptByTitle = false } = {}) {
  const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
  for (const w of wins)
    await retryIfEditBlocked(() => groupAllTabs(w.id, { adoptByTitle })).catch(
      logWarn(`group window ${w.id}`),
    );
}

/** After session restore, wait until restored tabs report their URL (capped). */
async function waitForTabsSettled(timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  await delay(500);
  while (Date.now() < end) {
    const tabs = await chrome.tabs.query({});
    if (!tabs.some((t) => !t.url && t.pendingUrl)) return;
    await delay(250);
  }
}

async function ungroupAllTabs(windowId) {
  const win = await getWin(windowId);
  if (!win) return;
  const [tabs, manualSet] = await Promise.all([
    chrome.tabs.query({ windowId: win }),
    getManualGroupIds(),
  ]);
  const ids = tabs
    .filter((t) => isGrouped(t) && !manualSet.has(t.groupId))
    .map((t) => t.id);
  if (ids.length) await chrome.tabs.ungroup(ids);
}

async function focusExistingAndCloseNew(windowId, newTabId, url) {
  const opts = await getOpts();
  if (!opts.avoidDuplicates || !url?.startsWith("http")) return false;
  const tabs = await chrome.tabs.query({ windowId, url });
  const existing = tabs.find((t) => t.id !== newTabId);
  if (!existing) return false;
  await chrome.tabs.remove(newTabId);
  await chrome.tabs.update(existing.id, { active: true });
  return true;
}

const buildGroupIdToKey = (tabs, opts, excludeGroupIds) => {
  const m = new Map();
  for (const t of tabs.filter(
    (t) => t.groupId != null && !excludeGroupIds.has(t.groupId),
  ))
    if (!m.has(t.groupId))
      m.set(t.groupId, getKey(t.url, opts.groupBySubdomain));
  return m;
};
const findGroupForKey = (groups, groupIdToKey, key) =>
  groups.find((g) => groupIdToKey.get(g.id) === key);

const addTabToExistingGroup = (groupId, tabId) =>
  chrome.tabs
    .query({ groupId })
    .catch(() => [])
    .then((inGroup) =>
      chrome.tabs.group({
        groupId,
        tabIds: [...inGroup.map((t) => t.id), tabId],
      }),
    )
    .then(() => true)
    .catch(() => false);

async function assignTabToGroup(tabId, url, windowId) {
  const opts = await getOpts();
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || (opts.ignorePinnedTabs && tab.pinned)) return;
  const key = getKey(url, opts.groupBySubdomain);
  if (!key) return;
  const winId = tab.windowId ?? windowId;
  const [groups, tabs, manualSet] = await Promise.all([
    chrome.tabGroups.query({ windowId: winId }),
    chrome.tabs.query({ windowId: winId }),
    getManualGroupIds(),
  ]);
  if (tab.groupId != null && manualSet.has(tab.groupId)) return;
  const managedGroups = groups.filter((g) => !manualSet.has(g.id));
  const groupIdToKey = buildGroupIdToKey(tabs, opts, manualSet);
  const existing = findGroupForKey(managedGroups, groupIdToKey, key);
  const added = existing && (await addTabToExistingGroup(existing.id, tabId));
  if (!added) {
    const allKeys = [...new Set([...groupIdToKey.values(), key])].sort();
    const idx = allKeys.indexOf(key);
    await createGroup({ windowId: winId, key, tabIds: [tabId], idx });
  }
}
