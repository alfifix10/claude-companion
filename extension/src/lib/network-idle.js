/**
 * Pure in-flight network accounting for the "wait until settled" path.
 *
 * The service worker already logs network events for read_network_requests,
 * but that log can't answer the one question that actually matters for
 * automation timing: "are there still HTTP requests in flight right now?".
 * SPAs (Gmail, Twitter, Reddit, dashboards) fire their real content via XHR
 * AFTER the load event, so a tab can be "complete" and DOM-quiet while the
 * data the user asked about is still on the wire — read_page then sees an
 * empty shell and the agent wrongly concludes "nothing here".
 *
 * We track in-flight requests by CDP requestId: +1 on requestWillBeSent,
 * -1 on loadingFinished/loadingFailed. The logic below is deliberately a
 * pure module (no chrome.* / no timers) so it is unit-testable and the
 * leak-handling is provable.
 *
 * Leak handling is the whole game here:
 *   • Redirects reuse the same requestId (requestWillBeSent fires again with
 *     a redirectResponse) — a Set keyed by id absorbs that with no double
 *     count.
 *   • Cancelled requests, aborted fetches, and pre-render speculative loads
 *     sometimes never emit a terminal event, so an id could linger forever.
 *     sweepStale() drops anything older than maxAgeMs, guaranteeing the
 *     counter always drains back toward zero even when CDP lies to us.
 *   • Long-lived connections (SSE / EventSource / hanging long-poll) would
 *     otherwise pin the page "busy" forever. Callers MUST bound the wait
 *     with a low cap; isIdle() is only ever the EARLY-exit signal, never the
 *     thing that decides the maximum latency.
 *
 * WebSockets are intentionally out of scope: CDP reports them via
 * Network.webSocketCreated, not requestWillBeSent, so they never enter this
 * map and never block a settle.
 */
/** Record a request entering flight. Idempotent for redirect re-fires. */
export function markRequestStart(map, requestId, now) {
    if (requestId == null)
        return;
    // Overwrite timestamp on redirect re-fire so the stale-sweep clock tracks
    // the most recent leg, not the original request.
    map.set(requestId, now);
}
/** Record a request leaving flight (finished or failed). Unknown ids no-op. */
export function markRequestEnd(map, requestId) {
    if (requestId == null)
        return;
    map.delete(requestId);
}
/**
 * Drop entries older than maxAgeMs. Returns the number swept (for diagnostics
 * / tests). This is the safety valve against requestIds that never get a
 * terminal CDP event.
 */
export function sweepStale(map, now, maxAgeMs) {
    let swept = 0;
    for (const [id, start] of map) {
        if (now - start >= maxAgeMs) {
            map.delete(id);
            swept++;
        }
    }
    return swept;
}
/**
 * True when the count of YOUNG in-flight requests is at or below `threshold`
 * AFTER sweeping stale entries. Mutates the map (sweeps) by design — callers
 * poll this and we don't want stale ids to survive across polls.
 *
 * `threshold` defaults to 0 (fully quiet); a small non-zero value tolerates
 * always-on telemetry pings.
 *
 * `longLivedMs` (default 3000): requests in flight LONGER than this don't
 * count as busy. Rationale: the settle that polls us is capped well under
 * 3 s, so any request that old necessarily predates the agent's action —
 * it's a persistent long-poll/SSE channel, not the response we're waiting
 * for. Without this, a page with one hanging long-poll forces every action
 * to pay the full wait cap until the 15 s stale-sweep clears it. The entry
 * itself stays in the map (it may still legitimately finish); it just
 * stops vetoing idleness.
 */
export function isIdle(map, now, opts = {}) {
    const threshold = opts.threshold ?? 0;
    const maxAgeMs = opts.maxAgeMs ?? 15_000;
    const longLivedMs = opts.longLivedMs ?? 3_000;
    sweepStale(map, now, maxAgeMs);
    let young = 0;
    for (const start of map.values()) {
        if (now - start < longLivedMs)
            young++;
    }
    return young <= threshold;
}
/** Current in-flight count after sweeping. Convenience for diagnostics. */
export function inflightCount(map, now, maxAgeMs = 15_000) {
    sweepStale(map, now, maxAgeMs);
    return map.size;
}
