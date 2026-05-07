const { buildWav, buildWavFromPcm, isWavAssemblyInvariantError } = require("../src/build_wav");
const { parseWav } = require("../src/live_diary/wav_utils");

describe("build_wav", () => {
    it("buildWavFromPcm wraps PCM in a valid WAV header", () => {
        const pcm = Buffer.from(new Int16Array([1, -1, 2, -2]).buffer);
        const wav = buildWavFromPcm(pcm, 16000, 1, 16);
        const parsed = parseWav(wav);
        expect(parsed).not.toBeNull();
        expect(parsed.sampleRate).toBe(16000);
        expect(parsed.channels).toBe(1);
        expect(parsed.bitDepth).toBe(16);
        expect(parsed.pcm).toEqual(pcm);
    });

    it("buildWav assembles chunk sublevel data in key order", async () => {
        const chunkMap = new Map([
            ["000001", Buffer.from([3, 4])],
            ["000000", Buffer.from([1, 2])],
        ]);
        const sessionChunks = {
            async listKeys() {
                return ["000001", "000000"];
            },
            async get(key) {
                return chunkMap.get(String(key));
            },
        };

        const wav = await buildWav(sessionChunks, 16000, 1, 16);
        const parsed = parseWav(wav);
        expect(parsed).not.toBeNull();
        expect(parsed.pcm).toEqual(Buffer.from([1, 2, 3, 4]));
    });

    it("buildWav fails if chunks disappear between passes", async () => {
        let calls = 0;
        const sessionChunks = {
            async listKeys() {
                return ["000000"];
            },
            async get() {
                calls += 1;
                if (calls === 1) {
                    return Buffer.from([1, 2, 3, 4]);
                }
                return undefined;
            },
        };

        let err = null;
        try {
            await buildWav(sessionChunks, 16000, 1, 16);
        } catch (error) {
            err = error;
        }
        expect(isWavAssemblyInvariantError(err)).toBe(true);
    });
});
