import { tabGroupTabs, setTabGroupId } from "./state.js";

/**
 * Restore tab-group tracking after a service-worker restart.
 * Best-effort — we store the group id in chrome.storage.session and refresh it.
 */
export async function recoverTabGroupState() {
  try {
    const { tabGroupId } = await chrome.storage.session.get("tabGroupId");
    if (tabGroupId) {
      setTabGroupId(tabGroupId);
      const tabs = await chrome.tabs.query({ groupId: tabGroupId });
      tabGroupTabs.clear();
      for (const t of tabs) tabGroupTabs.add(t.id);
    }
  } catch {}
}
