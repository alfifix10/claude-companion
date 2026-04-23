/**
 * media-store — IndexedDB-backed storage for conversation images.
 *
 * WHY this module exists:
 *   chrome.storage.local has a 10MB hard cap and handles JSON only.
 *   Base64-encoded images bloat payloads by 33% and blow that budget
 *   after ~10 pasted screenshots. Solution: text stays in
 *   chrome.storage.local (fast, indexed, searchable), binary goes here
 *   (Blob-native, quota = ~50% of disk).
 *
 * SHAPE:
 *   Each record = { id, convId, createdAt, fullBlob, thumbBlob, mediaType }
 *   `id`       unique per image, referenced from conversation[].mediaIds
 *   `convId`   cascade delete when conversation is deleted
 *   `thumbBlob` ~200px JPEG (~10KB) — what the bubble shows
 *   `fullBlob`  original — what the lightbox shows
 *
 * LIFECYCLE:
 *   saveMedia()        — called by send() for each pasted image
 *   getThumb()/getFull — called during bubble render and lightbox open
 *   deleteConvMedia()  — cascade on convDelete()
 *   pruneOld()         — monthly via chrome.alarms (see background.js)
 *
 * FAILURE MODES:
 *   • QuotaExceededError → caller should retry after pruneOld(30)
 *   • IndexedDB unavailable → saveMedia throws, caller saves message without images
 *   • Blob corruption → getThumb/getFull returns null, caller shows placeholder
 */

const DB_NAME = "cc_media";
const DB_VERSION = 1;
const STORE = "media";
const THUMB_MAX = 200;
const THUMB_QUALITY = 0.7;

let dbPromise = null;

function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) {
                const store = db.createObjectStore(STORE, { keyPath: "id" });
                store.createIndex("convId", "convId", { unique: false });
                store.createIndex("createdAt", "createdAt", { unique: false });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return dbPromise;
}

function newId() {
    const buf = new Uint8Array(8);
    crypto.getRandomValues(buf);
    return "m_" + Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Decode a base64 string into a Blob without the data: URI prefix.
 * Caller owns mediaType.
 */
function base64ToBlob(base64, mediaType) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mediaType });
}

/**
 * Generate a thumbnail Blob capped at THUMB_MAX on the longer side.
 * Uses createImageBitmap + OffscreenCanvas when available (off main
 * thread-friendly), falls back to HTMLCanvasElement. Returns the
 * original blob if downscaling isn't helpful (already small).
 */
async function makeThumb(blob) {
    let bitmap;
    try {
        bitmap = await createImageBitmap(blob);
    } catch {
        return blob; // can't decode — store original as thumb
    }
    const { width, height } = bitmap;
    const longer = Math.max(width, height);
    if (longer <= THUMB_MAX) {
        bitmap.close?.();
        return blob;
    }
    const scale = THUMB_MAX / longer;
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    let outBlob;
    if (typeof OffscreenCanvas !== "undefined") {
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(bitmap, 0, 0, w, h);
        outBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: THUMB_QUALITY });
    } else {
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
        outBlob = await new Promise((resolve) =>
            canvas.toBlob(resolve, "image/jpeg", THUMB_QUALITY),
        );
    }
    bitmap.close?.();
    return outBlob || blob;
}

/**
 * Store a single image and return its id. Accepts either:
 *   { mediaType, base64 }  — the existing panel.js attachment shape
 *   { mediaType, blob }    — direct Blob path
 * Throws on quota exceeded; caller should handle.
 */
export async function saveMedia(convId, image) {
    const db = await openDB();
    const fullBlob = image.blob
        ? image.blob
        : base64ToBlob(image.base64, image.mediaType);
    const thumbBlob = await makeThumb(fullBlob);
    const record = {
        id: newId(),
        convId,
        createdAt: Date.now(),
        mediaType: image.mediaType || fullBlob.type || "image/png",
        fullBlob,
        thumbBlob,
    };
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(record);
        tx.oncomplete = () => resolve(record.id);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

/**
 * Fetch a record; returns null if missing (record pruned, IDB corrupt, etc).
 */
async function getRecord(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
    });
}

export async function getThumb(id) {
    const rec = await getRecord(id);
    return rec?.thumbBlob || null;
}

export async function getFull(id) {
    const rec = await getRecord(id);
    return rec?.fullBlob || null;
}

/**
 * Cascade-delete every media row belonging to a conversation.
 * Called from convDelete() so removing a conversation doesn't leak
 * its attachments.
 */
export async function deleteConvMedia(convId) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        const idx = tx.objectStore(STORE).index("convId");
        const req = idx.openCursor(IDBKeyRange.only(convId));
        req.onsuccess = () => {
            const cur = req.result;
            if (cur) {
                cur.delete();
                cur.continue();
            }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Drop records older than `maxAgeDays`. Intended to run monthly via
 * chrome.alarms. Returns count of rows pruned.
 */
export async function pruneOld(maxAgeDays = 90) {
    const cutoff = Date.now() - maxAgeDays * 86400 * 1000;
    const db = await openDB();
    return new Promise((resolve, reject) => {
        let count = 0;
        const tx = db.transaction(STORE, "readwrite");
        const idx = tx.objectStore(STORE).index("createdAt");
        const req = idx.openCursor(IDBKeyRange.upperBound(cutoff, true));
        req.onsuccess = () => {
            const cur = req.result;
            if (cur) {
                cur.delete();
                count++;
                cur.continue();
            }
        };
        tx.oncomplete = () => resolve(count);
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Total disk usage (bytes) across all stored media — for settings UI
 * and quota warnings. Optional `convId` filters to a single conversation.
 */
export async function mediaSize(convId) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        let total = 0;
        const tx = db.transaction(STORE, "readonly");
        const store = tx.objectStore(STORE);
        const req = convId
            ? store.index("convId").openCursor(IDBKeyRange.only(convId))
            : store.openCursor();
        req.onsuccess = () => {
            const cur = req.result;
            if (cur) {
                total += (cur.value.fullBlob?.size || 0) + (cur.value.thumbBlob?.size || 0);
                cur.continue();
            }
        };
        tx.oncomplete = () => resolve(total);
        tx.onerror = () => reject(tx.error);
    });
}

// Exported for tests — resets the module-level promise so a fresh
// fake-indexeddb can be wired up per test.
export function __resetForTests() {
    dbPromise = null;
}
