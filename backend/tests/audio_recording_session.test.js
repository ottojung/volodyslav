const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger } = require("./stubs");
const {
    startSession,
    uploadChunk,
    getSession,
    stopSession,
    fetchFinalAudio,
    discardSession,
    isAudioSessionNotFoundError,
    isAudioSessionChunkValidationError,
    isAudioSessionConflictError,
} = require("../src/audio_recording_session");

function getCapabilities() {
    const caps = getMockedRootCapabilities();
    stubEnvironment(caps);
    stubLogger(caps);
    return caps;
}

const TEST_SESSION_ID = "test-session-abc123";
const TEST_MIME_TYPE = "audio/webm";

describe("audio_recording_session", () => {
    describe("startSession", () => {
        it("creates session metadata in temporary storage", async () => {
            const caps = getCapabilities();
            const session = await startSession(caps, TEST_SESSION_ID, TEST_MIME_TYPE);
            expect(session.sessionId).toBe(TEST_SESSION_ID);
            expect(session.status).toBe("recording");
            expect(session.mimeType).toBe(TEST_MIME_TYPE);
            expect(session.fragmentCount).toBe(0);
            expect(session.elapsedSeconds).toBe(0);
        });

        it("updates mimeType when called twice with same id", async () => {
            const caps = getCapabilities();
            await startSession(caps, TEST_SESSION_ID, TEST_MIME_TYPE);
            const session2 = await startSession(caps, TEST_SESSION_ID, "audio/ogg");
            expect(session2.sessionId).toBe(TEST_SESSION_ID);
            expect(session2.mimeType).toBe("audio/ogg");
            expect(session2.fragmentCount).toBe(0);
        });

        it("throws on invalid session id", async () => {
            const caps = getCapabilities();
            let err = null;
            try {
                await startSession(caps, "invalid/session", TEST_MIME_TYPE);
            } catch (e) {
                err = e;
            }
            expect(isAudioSessionChunkValidationError(err)).toBe(true);
        });

        it("deletes prior session when new session id is used", async () => {
            const caps = getCapabilities();
            await startSession(caps, "old-session-id", TEST_MIME_TYPE);
            await uploadChunk(caps, "old-session-id", {
                chunk: Buffer.from("audio-data"),
                startMs: 0,
                endMs: 10000,
                sequence: 0,
                mimeType: TEST_MIME_TYPE,
            });
            // Verify old session exists
            const oldSession = await getSession(caps, "old-session-id");
            expect(oldSession.fragmentCount).toBe(1);

            // Start new session - should delete old one
            await startSession(caps, "new-session-id", TEST_MIME_TYPE);

            // Old session should be gone
            let err = null;
            try {
                await getSession(caps, "old-session-id");
            } catch (e) {
                err = e;
            }
            expect(isAudioSessionNotFoundError(err)).toBe(true);
        });

        it("deletes orphaned sessions not tracked in index", async () => {
            const caps = getCapabilities();
            // Create first session normally (gets indexed)
            await startSession(caps, "orphan-session-1", TEST_MIME_TYPE);
            await uploadChunk(caps, "orphan-session-1", {
                chunk: Buffer.from("data"),
                startMs: 0,
                endMs: 10000,
                sequence: 0,
                mimeType: TEST_MIME_TYPE,
            });

            // Manually create a second session to simulate orphan (not indexed)
            await startSession(caps, "orphan-session-2", TEST_MIME_TYPE);

            // Start a third new session - should clean up both orphans
            await startSession(caps, "fresh-session", TEST_MIME_TYPE);

            // Both orphans should be gone
            let err1 = null;
            try {
                await getSession(caps, "orphan-session-1");
            } catch (e) {
                err1 = e;
            }
            expect(isAudioSessionNotFoundError(err1)).toBe(true);

            let err2 = null;
            try {
                await getSession(caps, "orphan-session-2");
            } catch (e) {
                err2 = e;
            }
            expect(isAudioSessionNotFoundError(err2)).toBe(true);
        });
    });

    describe("uploadChunk", () => {
        it("stores chunk and updates session metadata", async () => {
            const caps = getCapabilities();
            await startSession(caps, TEST_SESSION_ID, TEST_MIME_TYPE);
            const result = await uploadChunk(caps, TEST_SESSION_ID, {
                chunk: Buffer.from("audio-chunk-data"),
                startMs: 0,
                endMs: 10000,
                sequence: 0,
                mimeType: TEST_MIME_TYPE,
            });
            expect(result.stored.sequence).toBe(0);
            expect(result.stored.filename).toBe("000000.webm");
            expect(result.session.fragmentCount).toBe(1);
            expect(result.session.lastEndMs).toBe(10000);
        });

        it("accepts duplicate sequence by overwriting", async () => {
            const caps = getCapabilities();
            await startSession(caps, TEST_SESSION_ID, TEST_MIME_TYPE);
            await uploadChunk(caps, TEST_SESSION_ID, {
                chunk: Buffer.from("original-chunk"),
                startMs: 0,
                endMs: 10000,
                sequence: 0,
                mimeType: TEST_MIME_TYPE,
            });
            // Upload again with same sequence
            const result = await uploadChunk(caps, TEST_SESSION_ID, {
                chunk: Buffer.from("replacement-chunk"),
                startMs: 0,
                endMs: 10000,
                sequence: 0,
                mimeType: TEST_MIME_TYPE,
            });
            expect(result.stored.sequence).toBe(0);
            // fragmentCount should still be 1 (not 2)
            expect(result.session.fragmentCount).toBe(1);
        });

        it("throws for missing session", async () => {
            const caps = getCapabilities();
            let err = null;
            try {
                await uploadChunk(caps, "nonexistent-session", {
                    chunk: Buffer.from("data"),
                    startMs: 0,
                    endMs: 10000,
                    sequence: 0,
                    mimeType: TEST_MIME_TYPE,
                });
            } catch (e) {
                err = e;
            }
            expect(isAudioSessionNotFoundError(err)).toBe(true);
        });

        it("throws on upload to stopped session", async () => {
            const caps = getCapabilities();
            await startSession(caps, TEST_SESSION_ID, TEST_MIME_TYPE);
            await stopSession(caps, TEST_SESSION_ID, 0);
            let err = null;
            try {
                await uploadChunk(caps, TEST_SESSION_ID, {
                    chunk: Buffer.from("data"),
                    startMs: 0,
                    endMs: 10000,
                    sequence: 1,
                    mimeType: TEST_MIME_TYPE,
                });
            } catch (e) {
                err = e;
            }
            expect(isAudioSessionConflictError(err)).toBe(true);
        });

        it("rejects Infinity startMs", async () => {
            const caps = getCapabilities();
            await startSession(caps, TEST_SESSION_ID, TEST_MIME_TYPE);
            let err = null;
            try {
                await uploadChunk(caps, TEST_SESSION_ID, {
                    chunk: Buffer.from("data"),
                    startMs: Infinity,
                    endMs: 10000,
                    sequence: 0,
                    mimeType: TEST_MIME_TYPE,
                });
            } catch (e) {
                err = e;
            }
            expect(isAudioSessionChunkValidationError(err)).toBe(true);
        });

        it("rejects -Infinity endMs", async () => {
            const caps = getCapabilities();
            await startSession(caps, TEST_SESSION_ID, TEST_MIME_TYPE);
            let err = null;
            try {
                await uploadChunk(caps, TEST_SESSION_ID, {
                    chunk: Buffer.from("data"),
                    startMs: 0,
                    endMs: -Infinity,
                    sequence: 0,
                    mimeType: TEST_MIME_TYPE,
                });
            } catch (e) {
                err = e;
            }
            expect(isAudioSessionChunkValidationError(err)).toBe(true);
        });

        it("counts fragmentCount correctly for out-of-order uploads", async () => {
            const caps = getCapabilities();
            await startSession(caps, TEST_SESSION_ID, TEST_MIME_TYPE);
            // Upload sequence 1 first (out of order)
            await uploadChunk(caps, TEST_SESSION_ID, {
                chunk: Buffer.from("chunk-1"),
                startMs: 10000,
                endMs: 20000,
                sequence: 1,
                mimeType: TEST_MIME_TYPE,
            });
            // Upload sequence 0 second
            const result = await uploadChunk(caps, TEST_SESSION_ID, {
                chunk: Buffer.from("chunk-0"),
                startMs: 0,
                endMs: 10000,
                sequence: 0,
                mimeType: TEST_MIME_TYPE,
            });
            // fragmentCount should be 2, not 1
            expect(result.session.fragmentCount).toBe(2);
        });

        it("rejects invalid sequence", async () => {
            const caps = getCapabilities();
            await startSession(caps, TEST_SESSION_ID, TEST_MIME_TYPE);
            let err = null;
            try {
                await uploadChunk(caps, TEST_SESSION_ID, {
                    chunk: Buffer.from("data"),
                    startMs: 0,
                    endMs: 10000,
                    sequence: -1,
                    mimeType: TEST_MIME_TYPE,
                });
            } catch (e) {
                err = e;
            }
            expect(isAudioSessionChunkValidationError(err)).toBe(true);
        });

        it("rejects when max fragment count is reached", async () => {
            const {
                MAX_FRAGMENT_COUNT: MAX,
            } = require("../src/audio_recording_session");
            const caps = getCapabilities();
            await startSession(caps, TEST_SESSION_ID, TEST_MIME_TYPE);
            // Upload MAX chunks (sequence 0..MAX-1)
            for (let i = 0; i < MAX; i++) {
                await uploadChunk(caps, TEST_SESSION_ID, {
                    chunk: Buffer.from("data"),
                    startMs: i * 1000,
                    endMs: (i + 1) * 1000,
                    sequence: i,
                    mimeType: TEST_MIME_TYPE,
                });
            }
            // The (MAX+1)-th distinct chunk should be rejected
            let err = null;
            try {
                await uploadChunk(caps, TEST_SESSION_ID, {
                    chunk: Buffer.from("extra"),
                    startMs: MAX * 1000,
                    endMs: (MAX + 1) * 1000,
                    sequence: MAX,
                    mimeType: TEST_MIME_TYPE,
                });
            } catch (e) {
                err = e;
            }
            expect(isAudioSessionConflictError(err)).toBe(true);
        });

        it("derives filename extension from mimeType", async () => {
            const caps = getCapabilities();
            await startSession(caps, TEST_SESSION_ID, "audio/ogg");
            const result = await uploadChunk(caps, TEST_SESSION_ID, {
                chunk: Buffer.from("ogg-data"),
                startMs: 0,
                endMs: 10000,
                sequence: 0,
                mimeType: "audio/ogg",
            });
            expect(result.stored.filename).toBe("000000.ogg");
        });
    });

    describe("stopSession", () => {
        it("concatenates chunks and stores final audio", async () => {
            const caps = getCapabilities();
            await startSession(caps, TEST_SESSION_ID, TEST_MIME_TYPE);
            const chunk1 = Buffer.from("chunk-one-data");
            const chunk2 = Buffer.from("chunk-two-data");
            await uploadChunk(caps, TEST_SESSION_ID, {
                chunk: chunk1,
                startMs: 0,
                endMs: 10000,
                sequence: 0,
                mimeType: TEST_MIME_TYPE,
            });
            await uploadChunk(caps, TEST_SESSION_ID, {
                chunk: chunk2,
                startMs: 10000,
                endMs: 20000,
                sequence: 1,
                mimeType: TEST_MIME_TYPE,
            });

            const result = await stopSession(caps, TEST_SESSION_ID, 20);
            expect(result.status).toBe("stopped");
            expect(result.size).toBe(chunk1.length + chunk2.length);
        });

        it("persists elapsedSeconds in session metadata", async () => {
            const caps = getCapabilities();
            await startSession(caps, TEST_SESSION_ID, TEST_MIME_TYPE);
            await stopSession(caps, TEST_SESSION_ID, 42);
            const meta = await getSession(caps, TEST_SESSION_ID);
            expect(meta.elapsedSeconds).toBe(42);
            expect(meta.status).toBe("stopped");
        });

        it("rejects invalid elapsedSeconds", async () => {
            const caps = getCapabilities();
            await startSession(caps, TEST_SESSION_ID, TEST_MIME_TYPE);
            for (const bad of [NaN, Infinity, -1, -Infinity, "30", null]) {
                let err = null;
                try {
                    await stopSession(caps, TEST_SESSION_ID, /** @type {any} */ (bad));
                } catch (e) {
                    err = e;
                }
                expect(isAudioSessionChunkValidationError(err)).toBe(true);
            }
        });
    });

    describe("fetchFinalAudio", () => {
        it("returns final audio after stop", async () => {
            const caps = getCapabilities();
            await startSession(caps, TEST_SESSION_ID, TEST_MIME_TYPE);
            const audioData = Buffer.from("audio-bytes-here");
            await uploadChunk(caps, TEST_SESSION_ID, {
                chunk: audioData,
                startMs: 0,
                endMs: 10000,
                sequence: 0,
                mimeType: TEST_MIME_TYPE,
            });
            await stopSession(caps, TEST_SESSION_ID, 10);
            const { buffer, mimeType } = await fetchFinalAudio(caps, TEST_SESSION_ID);
            expect(buffer).toEqual(audioData);
            expect(mimeType).toBe(TEST_MIME_TYPE);
        });

        it("throws on not-yet-finalized session", async () => {
            const caps = getCapabilities();
            await startSession(caps, TEST_SESSION_ID, TEST_MIME_TYPE);
            let err = null;
            try {
                await fetchFinalAudio(caps, TEST_SESSION_ID);
            } catch (e) {
                err = e;
            }
            expect(isAudioSessionConflictError(err)).toBe(true);
        });

        it("throws for missing session", async () => {
            const caps = getCapabilities();
            let err = null;
            try {
                await fetchFinalAudio(caps, "nonexistent");
            } catch (e) {
                err = e;
            }
            expect(isAudioSessionNotFoundError(err)).toBe(true);
        });
    });

    describe("discardSession", () => {
        it("deletes session data", async () => {
            const caps = getCapabilities();
            await startSession(caps, TEST_SESSION_ID, TEST_MIME_TYPE);
            await uploadChunk(caps, TEST_SESSION_ID, {
                chunk: Buffer.from("data"),
                startMs: 0,
                endMs: 10000,
                sequence: 0,
                mimeType: TEST_MIME_TYPE,
            });
            await discardSession(caps, TEST_SESSION_ID);
            let err = null;
            try {
                await getSession(caps, TEST_SESSION_ID);
            } catch (e) {
                err = e;
            }
            expect(isAudioSessionNotFoundError(err)).toBe(true);
        });

        it("clears the index when discarding the current session", async () => {
            const caps = getCapabilities();
            await startSession(caps, TEST_SESSION_ID, TEST_MIME_TYPE);
            await discardSession(caps, TEST_SESSION_ID);
            // After discard, starting a new session with same id should behave like a fresh start
            const session = await startSession(caps, TEST_SESSION_ID, TEST_MIME_TYPE);
            expect(session.fragmentCount).toBe(0);
            expect(session.status).toBe("recording");
        });

        it("allows starting a different session after discarding current session", async () => {
            const caps = getCapabilities();
            await startSession(caps, TEST_SESSION_ID, TEST_MIME_TYPE);
            await discardSession(caps, TEST_SESSION_ID);
            // Start a completely different session; should not find any residue
            const newSession = await startSession(caps, "brand-new-session", TEST_MIME_TYPE);
            expect(newSession.fragmentCount).toBe(0);
        });
    });
});
