const {
    fromRequest,
    MissingRequestIdentifierError,
} = require("../src/request_identifier");

describe("Request Identifier", () => {
    describe("fromRequest", () => {
        it("extracts request identifier from query params", () => {
            const req = { query: { request_identifier: "test123" } };
            const reqId = fromRequest(req);
            expect(reqId.identifier).toBe("test123");
        });

        it("throws error when request_identifier is missing", () => {
            const req = { query: {} };
            expect(() => fromRequest(req)).toThrow(MissingRequestIdentifierError);
        });

        it("throws error when request_identifier is empty", () => {
            const req = { query: { request_identifier: "" } };
            expect(() => fromRequest(req)).toThrow(MissingRequestIdentifierError);
        });

        it("trims whitespace from request_identifier", () => {
            const req = { query: { request_identifier: "  test123  " } };
            const reqId = fromRequest(req);
            expect(reqId.identifier).toBe("test123");
        });

        it("throws error when request_identifier is only whitespace", () => {
            const req = { query: { request_identifier: "   " } };
            expect(() => fromRequest(req)).toThrow(MissingRequestIdentifierError);
        });
    });
});
