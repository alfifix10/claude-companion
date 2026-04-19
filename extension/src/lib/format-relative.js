/**
 * format-relative — relative-time formatter in Arabic.
 *
 * Used by the history overlay to show "منذ 3 دقائق" next to each
 * saved conversation.
 *
 * Boundaries:
 *   • < 1 minute   → "الآن"
 *   • < 1 hour     → "منذ N دقيقة"
 *   • < 1 day      → "منذ N ساعة"
 *   • < 1 week     → "منذ N يوم"
 *   • older        → locale date (ar)
 *
 * Pure function. Pass in the current time for tests that need to
 * pin "now"; defaults to Date.now() in production.
 */
export function formatRelative(timestamp, now = Date.now()) {
    const seconds = Math.floor((now - timestamp) / 1000);
    if (seconds < 60)
        return "الآن";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `منذ ${minutes} دقيقة`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `منذ ${hours} ساعة`;
    const days = Math.floor(hours / 24);
    if (days < 7)
        return `منذ ${days} يوم`;
    return new Date(timestamp).toLocaleDateString("ar");
}
