const $memories = document.getElementById("memories");
const $tasks = document.getElementById("tasks");
const $save = document.getElementById("saveBtn");
const $close = document.getElementById("closeBtn");
const $toast = document.getElementById("toast");
const $export = document.getElementById("exportBtn");
const $import = document.getElementById("importBtn");
const $importInput = document.getElementById("importInput");

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
$save.addEventListener("click", async () => {
  const memories = $memories.value.trim();
  const tasks = $tasks.value.trim();
  await chrome.storage.local.set({ memories, tasks });
  try { chrome.runtime.sendMessage({ type: "mirror_user_data", data: { memories, tasks } }); } catch {}
  toast("تم الحفظ ✓");
});

// Manual export — useful for migrating to another machine/profile, or as a
// belt-and-suspenders backup independent of the native-host file.
$export.addEventListener("click", async () => {
  const { memories = "", tasks = "" } = await chrome.storage.local.get(["memories", "tasks"]);
  const payload = {
    app: "claude-companion",
    version: 1,
    exportedAt: new Date().toISOString(),
    memories,
    tasks,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `claude-companion-settings-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("تم التصدير ⬇");
});

$import.addEventListener("click", () => $importInput.click());

$importInput.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  // Always reset — picking the same file twice should still fire "change".
  e.target.value = "";
  if (!file) return;

  if (!confirm("سيتم استبدال الإعدادات الحالية بمحتوى الملف. هل أنت متأكد؟")) return;

  let data;
  try {
    const text = await file.text();
    data = JSON.parse(text);
  } catch {
    toast("ملف غير صالح", false);
    return;
  }

  // Tolerate missing fields — partial imports are allowed.
  const patch = {};
  if (typeof data.memories === "string") patch.memories = data.memories;
  if (typeof data.tasks === "string") patch.tasks = data.tasks;
  if (!Object.keys(patch).length) {
    toast("الملف لا يحتوي إعدادات معروفة", false);
    return;
  }
  await chrome.storage.local.set(patch);
  // Mirror the imported data to the native backup as well, so a fresh
  // uninstall → reinstall cycle picks it up.
  try { chrome.runtime.sendMessage({ type: "mirror_user_data", data: patch }); } catch {}
  // Reflect in UI
  if (patch.memories !== undefined) $memories.value = patch.memories;
  if (patch.tasks !== undefined) $tasks.value = patch.tasks;
  toast("تم الاستيراد ⬆");
});

$close.addEventListener("click", () => window.close());

load();
