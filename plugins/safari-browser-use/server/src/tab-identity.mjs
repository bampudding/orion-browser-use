function tabWindowId(tabId) {
  const match = /^(\d+):\d+$/.exec(String(tabId));

  return match ? match[1] : "";
}

export function collectTabs(
  windows,
  readTabs,
  describeTab
) {
  const result = [];

  for (
    let windowIndex = 0;
    windowIndex < windows.length;
    windowIndex++
  ) {
    const window = windows[windowIndex];
    let tabs;

    try {
      tabs = readTabs(window);
    } catch (error) {
      continue;
    }

    if (!tabs) {
      continue;
    }

    for (let tabIndex = 0; tabIndex < tabs.length; tabIndex++) {
      result.push(
        describeTab(window, tabs[tabIndex], tabIndex + 1)
      );
    }
  }

  return result;
}

function tabFingerprint(tab) {
  return `${String(tab.title || "")}\u0000${String(tab.url || "")}`;
}

export function findOpenedTabs(before, after) {
  const openedCount = after.length - before.length;

  if (openedCount <= 0) {
    return [];
  }

  const previousFingerprints = new Set(
    before.map(tabFingerprint)
  );
  const candidates = after.filter(tab =>
    !previousFingerprints.has(tabFingerprint(tab))
  );

  return candidates.length === openedCount ? candidates : [];
}

export function findOpenedTabsAfterDelay(
  before,
  { delayMs = 800, listTabs, sleep }
) {
  sleep(delayMs);
  const tabs = listTabs();

  return {
    openedTabs: findOpenedTabs(before, tabs),
    tabs
  };
}

export function createTabIdentity(metadata) {
  return {
    id: String(metadata.id),
    windowId: tabWindowId(metadata.id),
    title: String(metadata.title || ""),
    url: String(metadata.url || "")
  };
}

export function retargetTabIdentity(identity, url) {
  identity.url = String(url);
}

function updateTabIdentity(identity, metadata) {
  identity.id = String(metadata.id);
  identity.windowId = tabWindowId(metadata.id);
  identity.title = String(metadata.title || "");
  identity.url = String(metadata.url || "");

  return metadata;
}

export function completeTabNavigation(identity, metadata) {
  const targetChanged = String(metadata.id) !== identity.id;
  const expectedTarget =
    String(metadata.url || "") === identity.url;

  if (
    tabWindowId(metadata.id) !== identity.windowId ||
    targetChanged && !expectedTarget
  ) {
    throw new Error(
      "stale_tab_handle: navigation target changed " + identity.id
    );
  }

  return updateTabIdentity(identity, metadata);
}

export function resolveTabIdentity(identity, tabs) {
  const candidates = tabs.filter(tab =>
    tabWindowId(tab.id) === identity.windowId
  );
  const current = candidates.find(tab => tab.id === identity.id);

  if (current && String(current.url || "") === identity.url) {
    return updateTabIdentity(identity, current);
  }

  const exact = candidates.filter(tab =>
    String(tab.url || "") === identity.url
  );

  if (exact.length === 1) {
    return updateTabIdentity(identity, exact[0]);
  }

  if (exact.length > 1) {
    throw new Error(
      "stale_tab_handle: ambiguous candidates for " + identity.id
    );
  }

  throw new Error("stale_tab_handle: tab not found " + identity.id);
}

export function resolveTabForUrlWait(
  identity,
  tabs,
  expected,
  exact
) {
  const matches = tab => {
    const url = String(tab.url || "");

    return exact ? url === expected : url.includes(expected);
  };
  let bound = null;

  try {
    bound = resolveTabIdentity(identity, tabs);
  } catch (error) {
    // The bound tab may be navigating to the expected URL.
  }

  if (bound) {
    return matches(bound) ? bound : null;
  }

  const candidates = tabs.filter(tab =>
    tabWindowId(tab.id) === identity.windowId && matches(tab)
  );

  if (candidates.length === 1) {
    return updateTabIdentity(identity, candidates[0]);
  }

  if (candidates.length > 1) {
    throw new Error(
      "stale_tab_handle: ambiguous URL candidates"
    );
  }

  return null;
}
