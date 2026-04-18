const $memories = document.getElementById("memories");
const $tasks = document.getElementById("tasks");
const $save = document.getElementById("saveBtn");
const $close = document.getElementById("closeBtn");
const $toast = document.getElementById("toast");

function toast(text, ok = true) {
  $toast.textContent = text;
  $toast.style.background = ok ? "#22c55e" : "#ef4444";
  $toast.style.display = "block";
  setTimeout(() => { $toast.style.display = "none"; }, 1800);
}

async function load() {
  const { memories, tasks } = await chrome.storage.local.get(["memories", "tasks"]);
  if (memories) $memories.value = memories;
  if (tasks) $tasks.value = tasks;
}

// Main save — writes to chrome.storage.local AND asks background to mirror
// the data to the native-host backup file. Local is the primary; the mirror
// is best-effort (failures don't block the user).
//
// Export/Import were removed from the UI at the user's request — the
// auto-mirror to ~/.config/claude-companion/user-data.json already
// survives uninstall and restores on reinstall, so the manual buttons
// were redundant for the intended workflow.
$save.addEventListener("click", async () => {
  const memories = $memories.value.trim();
  const tasks = $tasks.value.trim();
  await chrome.storage.local.set({ memories, tasks });
  try { chrome.runtime.sendMessage({ type: "mirror_user_data", data: { memories, tasks } }); } catch {}
  toast("تم الحفظ ✓");
});

$close.addEventListener("click", () => window.close());

load();
