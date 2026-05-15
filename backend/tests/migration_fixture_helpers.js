const path = require("path");
const fs = require("fs/promises");

/**
 * @param {import('../src/capabilities/root').Capabilities} capabilities
 * @param {string} version
 * @returns {void}
 */
function forceVersion(capabilities, version) {
    const originalInstantiate = capabilities.checker.instantiate.bind(capabilities.checker);
    const originalReadFileAsText = capabilities.reader.readFileAsText.bind(capabilities.reader);

    capabilities.checker.instantiate = async (filePath) => {
        if (path.basename(filePath) === "VERSION") {
            return { path: filePath };
        }
        return originalInstantiate(filePath);
    };

    capabilities.reader.readFileAsText = async (filePath) => {
        if (path.basename(filePath) === "VERSION") {
            return `${version}\n`;
        }
        return originalReadFileAsText(filePath);
    };
}

/**
 * @param {string} dir
 * @returns {Promise<Map<string, Buffer>>}
 */
async function collectFiles(dir) {
    const files = new Map();

    async function visit(current, relPrefix) {
        const members = await fs.readdir(current, { withFileTypes: true });
        for (const member of members) {
            if (member.name === ".git") {
                continue;
            }
            const absolutePath = path.join(current, member.name);
            const relativePath = relPrefix === "" ? member.name : path.join(relPrefix, member.name);
            if (member.isDirectory()) {
                await visit(absolutePath, relativePath);
                continue;
            }
            files.set(relativePath, await fs.readFile(absolutePath));
        }
    }

    await visit(dir, "");
    return files;
}

/**
 * @param {string} actualDir
 * @param {string} expectedDir
 * @returns {Promise<void>}
 */
async function assertDirectoriesExactlyEqual(actualDir, expectedDir) {
    const actualFiles = await collectFiles(actualDir);
    const expectedFiles = await collectFiles(expectedDir);

    const actualPaths = [...actualFiles.keys()].sort();
    const expectedPaths = [...expectedFiles.keys()].sort();

    const missing = expectedPaths.filter((p) => !actualFiles.has(p));
    const extra = actualPaths.filter((p) => !expectedFiles.has(p));
    const changed = expectedPaths.filter((p) => {
        if (!actualFiles.has(p)) {
            return false;
        }
        return !actualFiles.get(p).equals(expectedFiles.get(p));
    });

    if (missing.length === 0 && extra.length === 0 && changed.length === 0) {
        return;
    }

    const sections = [];
    if (missing.length > 0) {
        sections.push(`Missing files:\n${missing.map((p) => `  - ${p}`).join("\n")}`);
    }
    if (extra.length > 0) {
        sections.push(`Extra files:\n${extra.map((p) => `  - ${p}`).join("\n")}`);
    }
    if (changed.length > 0) {
        sections.push(`Changed files:\n${changed.map((p) => `  - ${p}`).join("\n")}`);
    }

    throw new Error(sections.join("\n\n"));
}

module.exports = {
    forceVersion,
    assertDirectoriesExactlyEqual,
};
