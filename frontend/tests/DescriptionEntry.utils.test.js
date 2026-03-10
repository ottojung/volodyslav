import { DateTime } from "luxon";
import { formatRelativeDate } from "../src/DescriptionEntry/utils.js";

describe("formatRelativeDate", () => {
    it("returns just now for invalid ISO inputs", () => {
        expect(formatRelativeDate("not-an-iso-date")).toBe("just now");
    });

    it("returns just now for future dates", () => {
        const future = DateTime.now().plus({ minutes: 5 }).toISO();
        expect(formatRelativeDate(future)).toBe("just now");
    });
});
