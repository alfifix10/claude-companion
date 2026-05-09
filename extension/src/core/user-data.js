/**
 * User-data persistence across extension uninstall.
 *
 * chrome.storage.local is wiped when the extension is removed. To survive
 * that, we mirror memories + tasks to a file in ~/.config/claude-companion/
 * via the native host. Round-trip:
 *
 *   Save flow (settings UI):
 *     settings.js → chrome.storage.local.set(...) → mirrorToNative(...)
 *                                                 ↓
 *                       native-host writes user-data.json atomically
 *
 *   Restore flow (background.js on startup):
 *     restoreFromNativeIfEmpty() reads chrome.storage.local. If both
 *     memories and tasks are missing, it asks the native host for the
 *     file and copies values back into local storage.
 *
 * Design notes:
 *   • Mirror is BEST-EFFORT. If the host is down, local save still works.
 *     The next successful save flushes everything.
 *   • We never overwrite a populated local with native data — the native
 *     file is a backup, not the source of truth while the extension runs.
 *   • Schema includes a version field so future migrations can upgrade
 *     old files in place.
 */

import { nativePort } from "./state.js";
import { ensureHealthyPort } from "../messaging/native.js";

const SCHEMA_VERSION = 1;

// Ask the native host for the backup file. Resolves to null if the host
// isn't reachable or the file doesn't exist yet.
function loadFromNative(timeoutMs = 3000) {
  return new Promise(async (resolve) => {
    const healthy = await ensureHealthyPort(2000);
    if (!healthy || !nativePort) return resolve(null);

    const id = `ld_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const timer = setTimeout(() => {
      nativePort.onMessage.removeListener(listener);
      resolve(null);
    }, timeoutMs);

    function listener(msg) {
      if (msg?.id !== id) return;
      clearTimeout(timer);
      nativePort.onMessage.removeListener(listener);
      resolve(msg.type === "user_data_result" ? (msg.data || null) : null);
    }

    nativePort.onMessage.addListener(listener);
    try { nativePort.postMessage({ type: "load_user_data", id }); }
    catch {
      clearTimeout(timer);
      nativePort.onMessage.removeListener(listener);
      resolve(null);
    }
  });
}

/**
 * Fire-and-forget mirror of user data to the native backup file.
 * Callers don't await this — UI responsiveness matters more than confirmation.
 */
export function mirrorToNative(data) {
  if (!nativePort) return;
  try {
    nativePort.postMessage({
      type: "save_user_data",
      id: `sv_${Date.now()}`,
      data: { ...data, version: SCHEMA_VERSION, savedAt: Date.now() },
    });
  } catch {}
}

/**
 * On extension startup:
 *   • If local storage is empty → pull from native backup (post-reinstall path)
 *   • If local storage has data → push it to the native backup (keeps the
 *     file current for existing users who haven't re-saved since we added
 *     this feature, and for any drift that might have snuck in)
 */
export async function restoreFromNativeIfEmpty() {
  try {
    const { memories, tasks, proMode, workingDirectory } =
      await chrome.storage.local.get(["memories", "tasks", "proMode", "workingDirectory"]);

    if (memories || tasks || typeof proMode === "boolean" || workingDirectory) {
      // Refresh the native backup so it reflects what's currently in use.
      // Fire-and-forget — failures are tolerable.
      mirrorToNative({
        memories: memories || "",
        tasks: tasks || "",
        proMode: !!proMode,
        workingDirectory: workingDirectory || "",
      });
      return;
    }

    // Local is empty — try to restore from native backup.
    const native = await loadFromNative();
    if (!native) return;

    const patch = {};
    if (typeof native.memories === "string" && native.memories) patch.memories = native.memories;
    if (typeof native.tasks === "string" && native.tasks) patch.tasks = native.tasks;
    if (typeof native.proMode === "boolean") patch.proMode = native.proMode;
    if (typeof native.workingDirectory === "string" && native.workingDirectory) {
      patch.workingDirectory = native.workingDirectory;
    }
    if (Object.keys(patch).length) {
      await chrome.storage.local.set(patch);
      console.log("[user-data] restored from native backup:", Object.keys(patch).join(", "));
    }
  } catch (e) {
    console.warn("[user-data] restore failed:", e?.message || e);
  }
}
