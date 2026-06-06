// Compiled from version-compare.ts. Pure semver-ish comparison.
function parse(v) {
  return String(v ?? "")
    .trim()
    .replace(/^v/i, "")
    .split(".")
    .map((n) => {
      const x = parseInt(n, 10);
      return Number.isFinite(x) ? x : 0;
    });
}
/** True iff `latest` is strictly newer than `current`. */
export function isNewerVersion(latest, current) {
  const a = parse(latest);
  const b = parse(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}
