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
const { parseWav } = require("../src/live_diary/wav_utils");

function getCapabilities() {
    const caps = getMockedRootCapabilities();
    stubEnvironment(caps);
    stubLogger(caps);
    return caps;
}

const TEST_SESSION_ID = "test-session-abc123";

/** Minimal PCM chunk parameters used across tests. */
const TEST_PCM_PARAMS = {
    pcm: Buffer.from(new Int16Array(8).buffer),
    sampleRateHz: 16000,
    channels: 1,
    bitDepth: 16,
};

describe("audio_recording_session", () => {
    describe("startSession", () => {
        it("creates session metadata in temporary storage", async () => {
            const caps = getCapabilities();
            const session = await startSession(caps, TEST_SESSION_ID);
            expect(session.sessionId).toBe(TEST_SESSION_ID);
            expect(session.status).toBe("recording");
            expect(session.mimeType).toBe("audio/wav");
            expect(session.fragmentCount).toBe(0);
            expect(session.elapsedSeconds).toBe(0);
        });

        it("touches session when called twice with same id", async () => {
            const caps = getCapabilities();
            await startSession(caps, TEST_SESSION_ID);
            const session2 = await startSession(caps, TEST_SESSION_ID);
            expect(session2.sessionId).toBe(TEST_SESSION_ID);
            expect(session2.mimeType).toBe("audio/wav");
            expect(session2.fragmentCount).toBe(0);
        });

        it("throws on invalid session id", async () => {
            const caps = getCapabilities();
            let err = null;
            try {
                await startSession(caps, "invalid/session");
            } catch (e) {
                err = e;
            }
            expect(isAudioSessionChunkValidationError(err)).toBe(true);
        });

        it("deletes prior session when new session id is used", async () => {
            const caps = getCapabilities();
            await startSession(caps, "old-session-id");
            await uploadChunk(caps, "old-session-id", {
                ...TEST_PCM_PARAMS,
                startMs: 0,
                endMs: 10000,
                sequence: 0,
            });
            // Verify old session exists
            const oldSession = await getSession(caps, "old-session-id");
            expect(oldSession.fragmentCount).toBe(1);

            // Start new session - should delete old one
            await startSession(caps, "new-session-id");

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
            await startSession(caps, "orphan-session-1");
            await uploadChunk(caps, "orphan-session-1", {
                ...TEST_PCM_PARAMS,
                startMs: 0,
                endMs: 10000,
                sequence: 0,
            });

            // Manually create a second session to simulate orphan (not indexed)
            await startSession(caps, "orphan-session-2");

            // Start a third new session - should clean up both orphans
            await startSession(caps, "fresh-session");

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
            await startSession(caps, TEST_SESSION_ID);
            const result = await uploadChunk(caps, TEST_SESSION_ID, {
                ...TEST_PCM_PARAMS,
                startMs: 0,
                endMs: 10000,
                sequence: 0,
            });
            expect(result.stored.sequence).toBe(0);
            expect(result.stored.filename).toBe("000000.pcm");
            expect(result.session.fragmentCount).toBe(1);
            expect(result.session.lastEndMs).toBe(10000);
        });

        it("accepts duplicate sequence by overwriting", async () => {
            const caps = getCapabilities();
            await startSession(caps, TEST_SESSION_ID);
            await uploadChunk(caps, TEST_SESSION_ID, {
                ...TEST_PCM_PARAMS,
                startMs: 0,
                endMs: 10000,
                sequence: 0,
            });
            // Upload again with same sequence
            const result = await uploadChunk(caps, TEST_SESSION_ID, {
                ...TEST_PCM_PARAMS,
                startMs: 0,
                endMs: 10000,
                sequence: 0,
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
                    ...TEST_PCM_PARAMS,
                    startMs: 0,
                    endMs: 10000,
                    sequence: 0,
                });
            } catch (e) {
                err = e;
            }
            expect(isAudioSessionNotFoundError(err)).toBe(true);
        });

        it("throws on upload to stopped session", async () => {
            const caps = getCapabilities();
            await startSession(caps, TEST_SESSION_ID);
            await stopSession(caps, TEST_SESSION_ID);
            let err = null;
            try {
                await uploadChunk(caps, TEST_SESSION_ID, {
                    ...TEST_PCM_PARAMS,
                    startMs: 0,
                    endMs: 10000,
                    sequence: 1,
                });
            } catch (e) {
                err = e;
            }
            expect(isAudioSessionConflictError(err)).toBe(true);
        });

        it("rejects Infinity startMs", async () => {
            const caps = getCapabilities();
            await startSession(caps, TEST_SESSION_ID);
            let err = null;
            try {
                await uploadChunk(caps, TEST_SESSION_ID, {
                    ...TEST_PCM_PARAMS,
                    startMs: Infinity,
                    endMs: 10000,
                    sequence: 0,
                });
            } catch (e) {
                err = e;
            }
            expect(isAudioSessionChunkValidationError(err)).toBe(true);
        });

        it("rejects -Infinity endMs", async () => {
            const caps = getCapabilities();
            await startSession(caps, TEST_SESSION_ID);
            let err = null;
            try {
                await uploadChunk(caps, TEST_SESSION_ID, {
                    ...TEST_PCM_PARAMS,
                    startMs: 0,
                    endMs: -Infinity,
                    sequence: 0,
                });
            } catch (e) {
                err = e;
            }
            expect(isAudioSessionChunkValidationError(err)).toBe(true);
        });

        it("counts fragmentCount correctly for out-of-order uploads", async () => {
            const caps = getCapabilities();
            await startSession(caps, TEST_SESSION_ID);
            // Upload sequence 1 first (out of order)
            await uploadChunk(caps, TEST_SESSION_ID, {
                ...TEST_PCM_PARAMS,
                startMs: 10000,
                endMs: 20000,
                sequence: 1,
            });
            // Upload sequence 0 second
            const result = await uploadChunk(caps, TEST_SESSION_ID, {
                ...TEST_PCM_PARAMS,
                startMs: 0,
                endMs: 10000,
                sequence: 0,
            });
            // fragmentCount should be 2, not 1
            expect(result.session.fragmentCount).toBe(2);
        });

        it("rejects invalid sequence", async () => {
            const caps = getCapabilities();
            await startSession(caps, TEST_SESSION_ID);
            let err = null;
            try {
                await uploadChunk(caps, TEST_SESSION_ID, {
                    ...TEST_PCM_PARAMS,
                    startMs: 0,
                    endMs: 10000,
                    sequence: -1,
                });
            } catch (e) {
                err = e;
            }
            expect(isAudioSessionChunkValidationError(err)).toBe(true);
        });

        it("rejects zero sampleRateHz", async () => {
            const caps = getCapabilities();
            await startSession(caps, TEST_SESSION_ID);
            let err = null;
            try {
                await uploadChunk(caps, TEST_SESSION_ID, {
                    ...TEST_PCM_PARAMS,
                    sampleRateHz: 0,
                    startMs: 0,
                    endMs: 10000,
                    sequence: 0,
                });
            } catch (e) {
                err = e;
            }
            expect(isAudioSessionChunkValidationError(err)).toBe(true);
        });

        it("rejects zero channels", async () => {
            const caps = getCapabilities();
            await startSession(caps, TEST_SESSION_ID);
            let err = null;
            try {
                await uploadChunk(caps, TEST_SESSION_ID, {
                    ...TEST_PCM_PARAMS,
                    channels: 0,
                    startMs: 0,
                    endMs: 10000,
                    sequence: 0,
                });
            } catch (e) {
                err = e;
            }
            expect(isAudioSessionChunkValidationError(err)).toBe(true);
        });

        it("rejects bitDepth other than 16", async () => {
            const caps = getCapabilities();
            await startSession(caps, TEST_SESSION_ID);
            let err = null;
            try {
                await uploadChunk(caps, TEST_SESSION_ID, {
                    ...TEST_PCM_PARAMS,
                    bitDepth: 24,
                    startMs: 0,
                    endMs: 10000,
                    sequence: 0,
                });
            } catch (e) {
                err = e;
            }
            expect(isAudioSessionChunkValidationError(err)).toBe(true);
        });

        it("rejects pcm buffer not aligned to frame size", async () => {
            const caps = getCapabilities();
            await startSession(caps, TEST_SESSION_ID);
            let err = null;
            try {
                await uploadChunk(caps, TEST_SESSION_ID, {
                    ...TEST_PCM_PARAMS,
                    // 3 bytes: not aligned to 2 bytes/frame (16-bit mono)
                    pcm: Buffer.alloc(3),
                    startMs: 0,
                    endMs: 10000,
                    sequence: 0,
                });
            } catch (e) {
                err = e;
            }
            expect(isAudioSessionChunkValidationError(err)).toBe(true);
        });

        it("rejects PCM format mismatch between chunks", async () => {
            const caps = getCapabilities();
            await startSession(caps, TEST_SESSION_ID);
            await uploadChunk(caps, TEST_SESSION_ID, {
                ...TEST_PCM_PARAMS,
                startMs: 0,
                endMs: 10000,
                sequence: 0,
            });
            let err = null;
            try {
                await uploadChunk(caps, TEST_SESSION_ID, {
                    ...TEST_PCM_PARAMS,
                    sampleRateHz: 44100, // different from first chunk
                    startMs: 10000,
                    endMs: 20000,
                    sequence: 1,
                });
            } catch (e) {
                err = e;
            }
            expect(isAudioSessionChunkValidationError(err)).toBe(true);
        });
    });
    describe("stopSession", () => {
        it("concatenates PCM chunks and stores final WAV audio", async () => {
            const caps = getCapabilities();
            await startSession(caps, TEST_SESSION_ID);
            // Upload two PCM fragments (silent 8-sample buffers each)
            const pcm1 = Buffer.from(new Int16Array(8).buffer);
            const pcm2 = Buffer.from(new Int16Array(8).buffer);
            await uploadChunk(caps, TEST_SESSION_ID, {
                pcm: pcm1,
                sampleRateHz: 16000,
                channels: 1,
                bitDepth: 16,
                startMs: 0,
                endMs: 10000,
                sequence: 0,
            });
            await uploadChunk(caps, TEST_SESSION_ID, {
                pcm: pcm2,
                sampleRateHz: 16000,
                channels: 1,
                bitDepth: 16,
                startMs: 10000,
                endMs: 20000,
                sequence: 1,
            });

            const result = await stopSession(caps, TEST_SESSION_ID);
            expect(result.status).toBe("stopped");
            // Final buffer is WAV: 44-byte header + concatenated PCM
            expect(result.size).toBe(44 + pcm1.length + pcm2.length);
        });

        it("derives elapsedSeconds from lastEndMs in session metadata", async () => {
            const caps = getCapabilities();
            await startSession(caps, TEST_SESSION_ID);
            await uploadChunk(caps, TEST_SESSION_ID, {
                ...TEST_PCM_PARAMS,
                startMs: 0,
                endMs: 42000,
                sequence: 0,
            });
            await stopSession(caps, TEST_SESSION_ID);
            const meta = await getSession(caps, TEST_SESSION_ID);
            expect(meta.elapsedSeconds).toBe(42);
            expect(meta.status).toBe("stopped");
        });
    });

    describe("fetchFinalAudio", () => {
        it("returns WAV final audio after stop", async () => {
            const caps = getCapabilities();
            await startSession(caps, TEST_SESSION_ID);
            const pcmSamples = Buffer.from(new Int16Array(8).buffer);
            await uploadChunk(caps, TEST_SESSION_ID, {
                pcm: pcmSamples,
                sampleRateHz: 16000,
                channels: 1,
                bitDepth: 16,
                startMs: 0,
                endMs: 10000,
                sequence: 0,
            });
            await stopSession(caps, TEST_SESSION_ID);
            const { buffer, mimeType } = await fetchFinalAudio(caps, TEST_SESSION_ID);
            expect(mimeType).toBe("audio/wav");
            // Verify it parses as a valid WAV file containing the uploaded PCM
            const wavInfo = parseWav(buffer);
            expect(wavInfo).not.toBeNull();
            expect(wavInfo.sampleRate).toBe(16000);
            expect(wavInfo.channels).toBe(1);
            expect(wavInfo.bitDepth).toBe(16);
            expect(wavInfo.pcm).toEqual(pcmSamples);
        });

        it("throws on not-yet-finalized session", async () => {
            const caps = getCapabilities();
            await startSession(caps, TEST_SESSION_ID);
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
            await startSession(caps, TEST_SESSION_ID);
            await uploadChunk(caps, TEST_SESSION_ID, {
                ...TEST_PCM_PARAMS,
                startMs: 0,
                endMs: 10000,
                sequence: 0,
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
            await startSession(caps, TEST_SESSION_ID);
            await discardSession(caps, TEST_SESSION_ID);
            // After discard, starting a new session with same id should behave like a fresh start
            const session = await startSession(caps, TEST_SESSION_ID);
            expect(session.fragmentCount).toBe(0);
            expect(session.status).toBe("recording");
        });

        it("allows starting a different session after discarding current session", async () => {
            const caps = getCapabilities();
            await startSession(caps, TEST_SESSION_ID);
            await discardSession(caps, TEST_SESSION_ID);
            // Start a completely different session; should not find any residue
            const newSession = await startSession(caps, "brand-new-session");
            expect(newSession.fragmentCount).toBe(0);
        });
    });
});
