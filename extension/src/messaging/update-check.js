/**
 * update-check — load-unpacked extensions never auto-update, so we poll the
 * GitHub "latest release" once a day and, if it's newer than the installed
 * manifest version, stash a flag the side panel surfaces as a banner. The
 * user still updates manually (re-download + reload), but they're told.
 *
 * Fully best-effort: any network/parse/rate-limit failure is swallowed.
 */
import { isNewerVersion } from "../lib/version-compare.js";

const RELEASES_API =
  "https://api.github.com/repos/alfifix10/claude-companion/releases/latest";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day

export async function checkForUpdate() {
  try {
    // Throttle: at most once per day, persisted across SW restarts.
    const { updateLastCheck = 0 } = await chrome.storage.local.get("updateLastCheck");
    if (Date.now() - updateLastCheck < CHECK_INTERVAL_MS) return;
    await chrome.storage.local.set({ updateLastCheck: Date.now() });

    const res = await fetch(RELEASES_API, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return; // 403 rate-limit, network, etc. — try again tomorrow.
    const data = await res.json();
    const latest = data?.tag_name;     // e.g. "v1.0.1"
    const url = data?.html_url;         // release page
    if (!latest) return;

    const current = chrome.runtime.getManifest().version;
    if (isNewerVersion(latest, current)) {
      await chrome.storage.local.set({ updateAvailable: { version: latest, url } });
    } else {
      // Caught up (or downgrade) — clear any stale flag.
      await chrome.storage.local.remove("updateAvailable");
    }
  } catch {
    // Best-effort only.
  }
}
