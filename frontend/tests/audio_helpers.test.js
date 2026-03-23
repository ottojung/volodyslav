import {
    extensionForMime,
    makeDiaryRequestIdentifier,
} from "../src/AudioDiary/audio_helpers.js";

describe("audio_helpers", () => {
    it("uses the backend-compatible weba extension for webm audio", () => {
        expect(extensionForMime("audio/webm;codecs=opus")).toBe("weba");
        expect(extensionForMime("audio/webm")).toBe("weba");
    });

    it("keeps known non-webm audio extensions unchanged", () => {
        expect(extensionForMime("audio/ogg")).toBe("ogg");
        expect(extensionForMime("audio/mp4")).toBe("mp4");
    });

    it("builds diary submission request identifiers with a stable prefix", () => {
        const firstIdentifier = makeDiaryRequestIdentifier();
        const secondIdentifier = makeDiaryRequestIdentifier();

        expect(firstIdentifier).toMatch(/^diary_/);
        expect(secondIdentifier).toMatch(/^diary_/);
        expect(secondIdentifier).not.toBe(firstIdentifier);
    });
});
