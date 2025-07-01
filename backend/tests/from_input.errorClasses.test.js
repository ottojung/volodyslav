const {
    makeInputParseError,
    isInputParseError,
    makeShortcutApplicationError,
    isShortcutApplicationError
} = require("../src/event/from_input");

describe("Error Classes", () => {
    test("InputParseError stores input and message", () => {
        const error = makeInputParseError("Test message", "test input");
        expect(error.message).toBe("Test message");
        expect(error.input).toBe("test input");
        expect(error).toBeInstanceOf(Error);
        expect(isInputParseError(error)).toBe(true);
    });

    test("ShortcutApplicationError stores input and message", () => {
        const error = makeShortcutApplicationError("Test message", "test input", "pattern");
        expect(error.message).toBe("Test message");
        expect(error.input).toBe("test input");
        expect(error).toBeInstanceOf(Error);
        expect(isShortcutApplicationError(error)).toBe(true);
    });
});
