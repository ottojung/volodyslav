jest.mock("../src/api_base_url.js", () => ({
    API_BASE_URL: "/api",
}));

import { submitEntry } from "../src/DescriptionEntry/api.js";
import { API_BASE_URL } from "../src/api_base_url.js";

describe("DescriptionEntry API submission", () => {
    beforeEach(() => {
        global.fetch = jest.fn();
    });

    afterEach(() => {
        jest.resetAllMocks();
    });

    it("uses JSON body when submitting without files", async () => {
        fetch.mockResolvedValue({
            status: 201,
            json: async () => ({ success: true, entry: { id: "entry-1" } }),
        });

        const result = await submitEntry("test event");

        expect(result).toEqual({ success: true, entry: { id: "entry-1" } });
        expect(fetch).toHaveBeenCalledWith(`${API_BASE_URL}/entries`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ rawInput: "test event" }),
        });
    });

    it("uses multipart form-data with rawInput and files fields when files are provided", async () => {
        fetch.mockResolvedValue({
            status: 201,
            json: async () => ({ success: true, entry: { id: "entry-2" } }),
        });

        const firstFile = new File(["first"], "photo1.jpg", { type: "image/jpeg" });
        const secondFile = new File(["second"], "audio.webm", { type: "audio/webm" });

        await submitEntry("diary [audiorecording]", undefined, [firstFile, secondFile]);

        expect(fetch).toHaveBeenCalledTimes(1);
        const [url, options] = fetch.mock.calls[0];

        expect(url).toBe(`${API_BASE_URL}/entries`);
        expect(options.method).toBe("POST");
        expect(options.body).toBeInstanceOf(FormData);

        const formData = options.body;
        expect(formData.get("rawInput")).toBe("diary [audiorecording]");
        const files = formData.getAll("files");
        expect(files).toHaveLength(2);
        expect(files[0]).toBe(firstFile);
        expect(files[1]).toBe(secondFile);
    });

    it("appends request_identifier query parameter when provided", async () => {
        fetch.mockResolvedValue({
            status: 201,
            json: async () => ({ success: true, entry: { id: "entry-3" } }),
        });

        const file = new File(["audio"], "diary-recording.webm", { type: "audio/webm" });
        const requestIdentifier = "camera id/with spaces";

        await submitEntry("test input", requestIdentifier, [file]);

        expect(fetch).toHaveBeenCalledTimes(1);
        const [url] = fetch.mock.calls[0];
        expect(url).toBe(
            `${API_BASE_URL}/entries?request_identifier=${encodeURIComponent(requestIdentifier)}`
        );
    });
});
