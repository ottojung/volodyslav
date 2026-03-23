/**
 * Tests for audio_chunk_collector MIME type propagation, combined Blob
 * content (including verified overlap content), and reset behaviour.
 */

import {
    makeAudioChunkCollector,
    CHUNK_DURATION_MS,
    FRAGMENT_MS,
    makeBlob,
    pushFragments,
    readBlobText,
} from "./audio_chunk_collector.helpers.js";

// ─── MIME type handling ───────────────────────────────────────────────────────

describe("AudioChunkCollector: MIME type propagation", () => {
    it("emitted chunk blob has the MIME type of the pushed fragments", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, 30, 0, "audio/ogg");
        expect(chunks[0].data.type).toBe("audio/ogg");
    });

    it("MIME type from last fragment before emission is used", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, 29, 0, "audio/webm");
        collector.push(makeBlob("last", "audio/ogg"), 290000, 300000);
        expect(chunks[0].data.type).toBe("audio/ogg");
    });

    it("handles Blobs with no MIME type (empty string)", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        for (let i = 0; i < 30; i++) {
            collector.push(new Blob([`f${i}`]), i * FRAGMENT_MS, (i + 1) * FRAGMENT_MS);
        }
        expect(chunks).toHaveLength(1);
        expect(chunks[0].data).toBeInstanceOf(Blob);
    });
});

// ─── Combined Blob content ───────────────────────────────────────────────────

describe("AudioChunkCollector: combined Blob content", () => {
    it("combined chunk size equals sum of fragment sizes", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        let totalSize = 0;
        for (let i = 0; i < 30; i++) {
            const blob = makeBlob(`fragment-${i}`);
            totalSize += blob.size;
            collector.push(blob, i * FRAGMENT_MS, (i + 1) * FRAGMENT_MS);
        }
        expect(chunks[0].data.size).toBe(totalSize);
    });

    it("second chunk includes the overlap fragment's content", async () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        // Fragments 0–28: before overlap region
        for (let i = 0; i < 29; i++) {
            collector.push(makeBlob(`f${i}`), i * FRAGMENT_MS, (i + 1) * FRAGMENT_MS);
        }
        // Fragment 29: sits at [290000, 300000] – inside the overlap region
        const overlapContent = "overlap-fragment-content";
        collector.push(makeBlob(overlapContent), 290000, 300000);
        // Fragments 30–58: fill the second window and trigger its emission
        for (let i = 30; i < 59; i++) {
            collector.push(makeBlob(`f${i}`), i * FRAGMENT_MS, (i + 1) * FRAGMENT_MS);
        }
        expect(chunks).toHaveLength(2);
        // Verify the overlap fragment's text is present in the second chunk
        const text = await readBlobText(chunks[1].data);
        expect(text).toContain(overlapContent);
    });
});

// ─── Reset ───────────────────────────────────────────────────────────────────

describe("AudioChunkCollector: reset", () => {
    it("reset prevents fragments accumulated before it from triggering emission", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, 25);
        collector.reset();
        pushFragments(collector, 5);
        expect(chunks).toHaveLength(0);
    });

    it("after reset the collector emits a fresh chunk starting at 0", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, 30);
        expect(chunks).toHaveLength(1);

        collector.reset();
        pushFragments(collector, 30);
        expect(chunks).toHaveLength(2);
        expect(chunks[1].start).toBe(0);
        expect(chunks[1].end).toBe(CHUNK_DURATION_MS);
    });

    it("reset clears MIME type so next chunks use the new type", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, 30, 0, "audio/webm");
        collector.reset();
        pushFragments(collector, 30, 0, "audio/ogg");
        expect(chunks[1].data.type).toBe("audio/ogg");
    });

    it("reset allows a full new recording session to work correctly", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, 30);
        expect(chunks).toHaveLength(1);

        collector.reset();
        pushFragments(collector, 30);
        expect(chunks).toHaveLength(2);
        expect(chunks[1].start).toBe(0);
        expect(chunks[1].end).toBe(CHUNK_DURATION_MS);
    });
});
