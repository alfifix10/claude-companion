// media-store tests.
//
// Node's test environment lacks IndexedDB and createImageBitmap. We
// shim IndexedDB with fake-indexeddb (in-memory, spec-compliant) and
// stub createImageBitmap to return a tiny (50×50) bitmap — below the
// thumbnail cap, so makeThumb short-circuits and reuses the original
// blob. That keeps us focused on the IDB lifecycle; real thumbnail
// encoding is a browser-only path and is easier to verify manually.

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    __resetForTests,
    deleteConvMedia,
    getFull,
    getThumb,
    mediaSize,
    pruneOld,
    saveMedia,
} from "./media-store.js";

// 1×1 transparent PNG — valid bytes so Blob construction stays honest.
const TINY_PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=";

// biome-ignore lint/suspicious/noExplicitAny: test stub
(globalThis as any).createImageBitmap = async () => ({
    width: 50,
    height: 50,
    close: () => {},
});

beforeEach(() => {
    __resetForTests();
});

afterEach(() => {
    indexedDB.deleteDatabase("cc_media");
});

describe("saveMedia", () => {
    it("returns an id with the m_ prefix", async () => {
        const id = await saveMedia("conv1", {
            mediaType: "image/png",
            base64: TINY_PNG_BASE64,
        });
        expect(id).toMatch(/^m_[0-9a-f]{16}$/);
    });

    it("distinct ids across concurrent saves", async () => {
        const ids = await Promise.all([
            saveMedia("conv1", { mediaType: "image/png", base64: TINY_PNG_BASE64 }),
            saveMedia("conv1", { mediaType: "image/png", base64: TINY_PNG_BASE64 }),
            saveMedia("conv1", { mediaType: "image/png", base64: TINY_PNG_BASE64 }),
        ]);
        expect(new Set(ids).size).toBe(3);
    });

    it("accepts a direct blob too (no base64)", async () => {
        const blob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
        const id = await saveMedia("conv1", { mediaType: "image/png", blob });
        const full = await getFull(id);
        expect(full).toBeTruthy();
        expect(full?.type).toBe("image/png");
    });
});

describe("getThumb / getFull", () => {
    it("round-trips a saved image", async () => {
        const id = await saveMedia("conv1", {
            mediaType: "image/png",
            base64: TINY_PNG_BASE64,
        });
        const thumb = await getThumb(id);
        const full = await getFull(id);
        expect(thumb).toBeInstanceOf(Blob);
        expect(full).toBeInstanceOf(Blob);
    });

    it("returns null for an unknown id", async () => {
        expect(await getThumb("m_deadbeefdeadbeef")).toBeNull();
        expect(await getFull("m_deadbeefdeadbeef")).toBeNull();
    });
});

describe("deleteConvMedia", () => {
    it("removes every row for one conv while sparing others", async () => {
        const a = await saveMedia("convA", { mediaType: "image/png", base64: TINY_PNG_BASE64 });
        const b = await saveMedia("convA", { mediaType: "image/png", base64: TINY_PNG_BASE64 });
        const c = await saveMedia("convB", { mediaType: "image/png", base64: TINY_PNG_BASE64 });

        await deleteConvMedia("convA");

        expect(await getFull(a)).toBeNull();
        expect(await getFull(b)).toBeNull();
        expect(await getFull(c)).not.toBeNull();
    });

    it("no-op when the conv has no media", async () => {
        await expect(deleteConvMedia("empty")).resolves.toBeUndefined();
    });
});

describe("pruneOld", () => {
    it("drops rows older than the cutoff", async () => {
        const now = Date.now();
        vi.spyOn(Date, "now").mockReturnValue(now - 100 * 86400 * 1000);
        const old = await saveMedia("conv1", { mediaType: "image/png", base64: TINY_PNG_BASE64 });

        vi.spyOn(Date, "now").mockReturnValue(now);
        const fresh = await saveMedia("conv1", { mediaType: "image/png", base64: TINY_PNG_BASE64 });

        const removed = await pruneOld(90);
        expect(removed).toBe(1);
        expect(await getFull(old)).toBeNull();
        expect(await getFull(fresh)).not.toBeNull();
    });

    it("zero rows pruned when everything is fresh", async () => {
        await saveMedia("conv1", { mediaType: "image/png", base64: TINY_PNG_BASE64 });
        expect(await pruneOld(90)).toBe(0);
    });
});

describe("mediaSize", () => {
    it("sums full+thumb bytes across the store", async () => {
        await saveMedia("conv1", { mediaType: "image/png", base64: TINY_PNG_BASE64 });
        await saveMedia("conv1", { mediaType: "image/png", base64: TINY_PNG_BASE64 });
        const total = await mediaSize();
        expect(total).toBeGreaterThan(0);
    });

    it("scopes to a single conv when convId is passed", async () => {
        await saveMedia("convA", { mediaType: "image/png", base64: TINY_PNG_BASE64 });
        await saveMedia("convB", { mediaType: "image/png", base64: TINY_PNG_BASE64 });
        const aSize = await mediaSize("convA");
        const bSize = await mediaSize("convB");
        const total = await mediaSize();
        expect(aSize).toBeGreaterThan(0);
        expect(bSize).toBeGreaterThan(0);
        expect(total).toBe(aSize + bSize);
    });
});
