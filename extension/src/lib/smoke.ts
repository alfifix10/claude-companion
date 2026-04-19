/**
 * Phase-0 smoke module — proves the TypeScript toolchain is wired up.
 * Contains a trivial pure function + its test sibling (smoke.test.ts).
 * Delete this pair once the first real migration (humanize-error.ts) lands.
 */
export function add(a: number, b: number): number {
  return a + b;
}
