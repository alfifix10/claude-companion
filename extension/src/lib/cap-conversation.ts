/**
 * cap-conversation — bound the panel's stored history while PINNING the first
 * few messages (the goal-setting turn).
 *
 * The old `slice(-max)` dropped the original objective once a chat passed
 * `max` messages, so by message 200 the model no longer saw why it was there.
 * Keeping the first `pinHead` messages means buildSmartHistory's "first-2"
 * stays the TRUE goal even in a marathon chat — without Pro Mode / _STATE.md.
 *
 * Pure + unit-tested.
 */
export function capConversation<T>(messages: T[], max: number, pinHead = 2): T[] {
  if (max <= 0) return [];
  if (messages.length <= max) return messages;
  // Degenerate: no room to pin a head without exceeding max — just take the
  // most recent `max`.
  if (pinHead <= 0 || pinHead >= max) return messages.slice(-max);
  // length > max here, so the tail window starts strictly after the pinned
  // head → no overlap, no duplication, and the result is exactly `max` long.
  return [...messages.slice(0, pinHead), ...messages.slice(-(max - pinHead))];
}
