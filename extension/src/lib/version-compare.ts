/**
 * version-compare — tiny semver-ish comparison for the update notifier.
 *
 * Compares dotted numeric versions, tolerating a leading "v" (GitHub tags
 * look like "v1.2.3"; the manifest version is "1.2.3"). Non-numeric or
 * missing parts are treated as 0. Pure + unit-tested.
 */
function parse(v: unknown): number[] {
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
export function isNewerVersion(latest: unknown, current: unknown): boolean {
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
