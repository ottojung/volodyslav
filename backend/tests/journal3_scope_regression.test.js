const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "../..");

describe("Journal 3 does not introduce a Jest worker policy or review artifact", () => {
    const forbidden = [
        "backend/jest.config.js",
        "backend/tests/worker_count_gate.test.js",
        "backend/tests/jest_test_timeout.test.js",
        "backend/tests/deployment_sources_entry.test.js",
        "docs/reviews/BOARD92-INDEPENDENT-REVIEW.md",
        "jest_global_setup.js",
        "jest_projects.js",
        "jest_test_timeout.js",
        "scripts/check-jest-max-workers",
        "scripts/jest-configuration-scope.js",
        "scripts/jest-max-workers.js",
        "scripts/run-jest",
    ];

    test.each(forbidden)("%s does not exist", (filename) => {
        expect(fs.existsSync(path.join(ROOT, filename))).toBe(false);
    });

    test("the package scripts use plain Jest rather than a wrapper", () => {
        const rootPackage = require("../../package.json");
        expect(rootPackage.scripts.test).toBe("jest");
        expect(rootPackage.scripts["test-only"]).toBe("jest");
    });

    test("the existing Jest configurations have no worker limit", () => {
        for (const filename of ["jest.config.js", "frontend/jest.config.js"]) {
            const text = fs.readFileSync(path.join(ROOT, filename), "utf8");
            expect(text).not.toMatch(/maxWorkers|JEST_MAX_WORKERS|globalSetup/);
        }
    });
});
