/**
 * Unit tests for live_diary/ingest_fragment.js.
 *
 * Covers duplicate-handling status transitions (duplicate_no_op, duplicate_rejected,
 * accepted replacement) and the basic accept/invalid cases.
 */

const { ingestFragment } = require("../src/live_diary/ingest_fragment");
const { writeTranscribedUntilMs, readFragmentIndex } = require("../src/live_diary/session_state");
const { startSession, stopSession, uploadChunk } = require("../src/audio_recording_session");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger, stubDatetime, stubEnvironment } = require("./stubs");
const { buildTestPcmBuffer, TEST_PCM_FORMAT } = require("./pcm_helpers");

const SESSION_ID = "ingest-test-session";

function makeCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

async function makeCapabilitiesWithSession() {
    const capabilities = makeCapabilities();
    await startSession(capabilities, SESSION_ID);
    return capabilities;
}

/** Default valid ingest params. */
function makeParams(overrides = {}) {
    return {
        pcm: buildTestPcmBuffer(),
        sampleRateHz: TEST_PCM_FORMAT.sampleRateHz,
        channels: TEST_PCM_FORMAT.channels,
        bitDepth: TEST_PCM_FORMAT.bitDepth,
        startMs: 0,
        endMs: 10_000,
        sequence: 0,
        ...overrides,
    };
}

describe("ingestFragment — basic acceptance", () => {
    it("throws when the audio session does not exist", async () => {
        const caps = makeCapabilities();
        await expect(ingestFragment(caps, SESSION_ID, makeParams())).rejects.toThrow("Audio session not found");
    });

    it("returns accepted on a fresh fragment", async () => {
        const caps = await makeCapabilitiesWithSession();
        const result = await ingestFragment(caps, SESSION_ID, makeParams());
        expect(result.status).toBe("accepted");
    });

    it("returns invalid_pcm when endMs < startMs", async () => {
        const caps = await makeCapabilitiesWithSession();
        const result = await ingestFragment(caps, SESSION_ID, makeParams({ startMs: 5_000, endMs: 0 }));
        expect(result.status).toBe("invalid_pcm");
    });

    it("returns invalid_pcm when sequence is out of upload bounds", async () => {
        const caps = await makeCapabilitiesWithSession();
        const result = await ingestFragment(caps, SESSION_ID, makeParams({ sequence: 1_000_000 }));
        expect(result.status).toBe("invalid_pcm");
    });

    it("accepts a zero-duration fragment (endMs === startMs) consistent with uploadChunk", async () => {
        const caps = await makeCapabilitiesWithSession();
        const result = await ingestFragment(caps, SESSION_ID, makeParams({ startMs: 1_000, endMs: 1_000 }));
        expect(result.status).toBe("accepted");
    });

    it("throws conflict for a stopped session and does not write fragment index", async () => {
        const caps = await makeCapabilitiesWithSession();
        await stopSession(caps, SESSION_ID);
        await expect(ingestFragment(caps, SESSION_ID, makeParams())).rejects.toThrow("Cannot upload chunk to finalized session");
        expect(await readFragmentIndex(caps.temporary, SESSION_ID, 0)).toBeNull();
    });
});

describe("ingestFragment — exact-duplicate handling", () => {
    it("returns duplicate_no_op when the same fragment is ingested twice", async () => {
        const caps = await makeCapabilitiesWithSession();
        const params = makeParams();
        await ingestFragment(caps, SESSION_ID, params);
        const result = await ingestFragment(caps, SESSION_ID, params);
        expect(result.status).toBe("duplicate_no_op");
    });

    it("returns duplicate_no_op regardless of watermark position", async () => {
        const caps = await makeCapabilitiesWithSession();
        const params = makeParams({ startMs: 0, endMs: 5_000, sequence: 0 });
        await ingestFragment(caps, SESSION_ID, params);

        // Advance the watermark past this fragment.
        await writeTranscribedUntilMs(caps.temporary, SESSION_ID, 10_000);

        // Re-ingest the exact same fragment — must be no-op, not rejected.
        const result = await ingestFragment(caps, SESSION_ID, params);
        expect(result.status).toBe("duplicate_no_op");
    });
});

describe("ingestFragment — non-identical duplicate below watermark", () => {
    it("returns duplicate_rejected when a different fragment with the same sequence is below the watermark", async () => {
        const caps = await makeCapabilitiesWithSession();

        // First ingest.
        await ingestFragment(caps, SESSION_ID, makeParams({ startMs: 0, endMs: 5_000, sequence: 0 }));

        // Advance the watermark past the fragment's startMs.
        await writeTranscribedUntilMs(caps.temporary, SESSION_ID, 10_000);

        // Try to replace with a different PCM buffer (different content hash).
        const differentPcm = Buffer.alloc(16, 0x42); // non-zero bytes → different hash
        const result = await ingestFragment(
            caps,
            SESSION_ID,
            makeParams({ pcm: differentPcm, startMs: 0, endMs: 5_000, sequence: 0 })
        );
        expect(result.status).toBe("duplicate_rejected");
    });

    it("does not reject when the non-identical duplicate is at or above the watermark", async () => {
        const caps = await makeCapabilitiesWithSession();

        // First ingest at [10000, 20000].
        await ingestFragment(caps, SESSION_ID, makeParams({ startMs: 10_000, endMs: 20_000, sequence: 1 }));

        // Watermark at 5000 — below the fragment's startMs (10000).
        await writeTranscribedUntilMs(caps.temporary, SESSION_ID, 5_000);

        // Different PCM → should be accepted as replacement.
        const differentPcm = Buffer.alloc(16, 0x01);
        const result = await ingestFragment(
            caps,
            SESSION_ID,
            makeParams({ pcm: differentPcm, startMs: 10_000, endMs: 20_000, sequence: 1 })
        );
        expect(result.status).toBe("accepted");
    });

    it("throws on format mismatch with established audio session format", async () => {
        const caps = await makeCapabilitiesWithSession();
        await uploadChunk(caps, SESSION_ID, makeParams({ sampleRateHz: 16_000, channels: 1, bitDepth: 16 }));
        await expect(
            ingestFragment(caps, SESSION_ID, makeParams({ sequence: 1, sampleRateHz: 44_100, channels: 1, bitDepth: 16 }))
        ).rejects.toThrow("PCM format mismatch");
    });
});

describe("ingestFragment — sequential distinct fragments", () => {
    it("accepts two different fragments with different sequences", async () => {
        const caps = await makeCapabilitiesWithSession();
        const r1 = await ingestFragment(caps, SESSION_ID, makeParams({ sequence: 0, startMs: 0, endMs: 10_000 }));
        const r2 = await ingestFragment(caps, SESSION_ID, makeParams({ sequence: 1, startMs: 10_000, endMs: 20_000 }));
        expect(r1.status).toBe("accepted");
        expect(r2.status).toBe("accepted");
    });
});
