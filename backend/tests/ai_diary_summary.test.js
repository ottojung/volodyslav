const { makeUserMessage } = require("../src/ai/diary_summary");

describe("ai/diary_summary makeUserMessage", () => {
    const baseInput = {
        currentSummaryMarkdown: "## Current snapshot\n- nothing yet",
        currentSummaryDateISO: "2024-01-01T00:00:00.000Z",
        newEntryDateISO: "2024-03-15T10:00:00.000Z",
    };

    test("includes both typed text and transcribed audio when both are present", () => {
        const message = makeUserMessage({
            ...baseInput,
            newEntryTypedText: "Today I went for a walk.",
            newEntryTranscribedAudioRecording: "Uh, today I went for a walk.",
        });

        expect(message).toContain("## TYPED TEXT");
        expect(message).toContain("Today I went for a walk.");
        expect(message).toContain("## TRANSCRIBED AUDIO");
        expect(message).toContain("Uh, today I went for a walk.");
    });

    test("includes only typed text section when transcribed audio is absent", () => {
        const message = makeUserMessage({
            ...baseInput,
            newEntryTypedText: "A typed note.",
            newEntryTranscribedAudioRecording: undefined,
        });

        expect(message).toContain("## TYPED TEXT");
        expect(message).toContain("A typed note.");
        expect(message).not.toContain("## TRANSCRIBED AUDIO");
    });

    test("includes only transcribed audio section when typed text is absent", () => {
        const message = makeUserMessage({
            ...baseInput,
            newEntryTypedText: undefined,
            newEntryTranscribedAudioRecording: "Some spoken words.",
        });

        expect(message).not.toContain("## TYPED TEXT");
        expect(message).toContain("## TRANSCRIBED AUDIO");
        expect(message).toContain("Some spoken words.");
    });

    test("includes neither content section when both are absent", () => {
        const message = makeUserMessage({
            ...baseInput,
            newEntryTypedText: undefined,
            newEntryTranscribedAudioRecording: undefined,
        });

        expect(message).not.toContain("## TYPED TEXT");
        expect(message).not.toContain("## TRANSCRIBED AUDIO");
    });

    test("includes current summary and dates", () => {
        const message = makeUserMessage({
            ...baseInput,
            newEntryTypedText: "some text",
            newEntryTranscribedAudioRecording: undefined,
        });

        expect(message).toContain("Current summary date: 2024-01-01T00:00:00.000Z");
        expect(message).toContain("New entry date: 2024-03-15T10:00:00.000Z");
        expect(message).toContain("## Current snapshot");
    });

    test("uses (no summary yet) placeholder when current summary is empty", () => {
        const message = makeUserMessage({
            ...baseInput,
            currentSummaryMarkdown: "",
            newEntryTypedText: "text",
            newEntryTranscribedAudioRecording: undefined,
        });

        expect(message).toContain("(no summary yet)");
    });
});
