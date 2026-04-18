export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function simpleHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

/**
 * Parse "Ctrl+Shift+A" / "Enter" / "F5" into { key, modifiers } for CDP
 * Input.dispatchKeyEvent. Modifier bits: alt=1, ctrl=2, meta=4, shift=8.
 */
export function parseKeyCombo(combo) {
  const parts = combo.split("+").map((p) => p.trim());
  let mod = 0;
  const key = parts[parts.length - 1];
  for (let i = 0; i < parts.length - 1; i++) {
    const m = parts[i].toLowerCase();
    if (m === "alt") mod |= 1;
    else if (m === "ctrl" || m === "control") mod |= 2;
    else if (m === "meta" || m === "cmd" || m === "command") mod |= 4;
    else if (m === "shift") mod |= 8;
  }
  return { key, modifiers: mod };
}
