/**
 * Test to enforce no recursion in dependency graph codebase.
 * This test scans all dependency_graph source files for recursive patterns.
 */

const fs = require("fs");
const path = require("path");

/**
 * Recursively finds all .js files in a directory.
 * @param {string} dir
 * @param {string[]} fileList
 * @returns {string[]}
 */
function findJsFiles(dir, fileList = []) {
    const files = fs.readdirSync(dir);

    for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);

        if (stat.isDirectory()) {
            findJsFiles(filePath, fileList);
        } else if (file.endsWith(".js")) {
            fileList.push(filePath);
        }
    }

    return fileList;
}

/**
 * Detects potential recursion in a source file.
 * Returns array of issues found.
 * @param {string} filePath
 * @returns {Array<{line: number, pattern: string, context: string}>}
 */
function detectRecursion(filePath) {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const issues = [];

    // Pattern: Known recursive helper names (dfs, visit, walk, traverse, etc.)
    const recursiveHelpers = [
        "dfs",
        "visit",
        "walk",
        "traverse",
        "recurse",
        "propagateOutdated", // Add known recursive method
        "pullByNodeKeyStringWithStatus", // Method that calls itself
        "maybeRecalculate", // Method that may indirectly cause recursion
    ];

    for (const helperName of recursiveHelpers) {
        // Look for function definition
        const defRegex = new RegExp(
            `\\b(?:async\\s+)?function\\s+${helperName}\\s*\\(`
        );
        const arrowDefRegex = new RegExp(
            `\\b(?:const|let|var)\\s+${helperName}\\s*=`
        );
        const methodDefRegex = new RegExp(
            `\\b(?:async\\s+)?${helperName}\\s*\\([^)]*\\)\\s*\\{`
        );

        let braceDepth = 0;
        let insideFunction = false;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line) continue;

            // Check if this line defines the function
            if (
                defRegex.test(line) ||
                arrowDefRegex.test(line) ||
                methodDefRegex.test(line)
            ) {
                insideFunction = true;
                braceDepth = 0;
                // Count braces on the definition line
                const openBraces = (line.match(/\{/g) || []).length;
                const closeBraces = (line.match(/\}/g) || []).length;
                braceDepth += openBraces - closeBraces;
                continue;
            }

            // Track braces when inside the function
            if (insideFunction) {
                const openBraces = (line.match(/\{/g) || []).length;
                const closeBraces = (line.match(/\}/g) || []).length;
                braceDepth += openBraces - closeBraces;

                // Look for recursive call inside the function body
                const callRegex = new RegExp(`\\b${helperName}\\s*\\(`);
                if (callRegex.test(line) && braceDepth > 0) {
                    const trimmed = line.trim();
                    // Exclude comments
                    if (
                        !trimmed.startsWith("//") &&
                        !trimmed.startsWith("*") &&
                        !trimmed.startsWith("/*")
                    ) {
                        issues.push({
                            line: i + 1,
                            pattern: `recursive-call-${helperName}`,
                            context: trimmed,
                        });
                        // Only report first call to avoid noise
                        insideFunction = false;
                        break;
                    }
                }

                // Check if function has ended
                if (braceDepth === 0) {
                    insideFunction = false;
                }
            }
        }
    }

    return issues;
}

describe("no recursion in dependency_graph", () => {
    test("dependency_graph source files must not contain recursion", () => {
        const depGraphDir = path.join(
            __dirname,
            "../src/generators/dependency_graph"
        );

        const jsFiles = findJsFiles(depGraphDir);
        
        // Verify we found some files
        expect(jsFiles.length).toBeGreaterThan(0);

        const allIssues = [];

        for (const file of jsFiles) {
            const issues = detectRecursion(file);
            if (issues.length > 0) {
                allIssues.push({
                    file: path.relative(depGraphDir, file),
                    issues,
                });
            }
        }

        if (allIssues.length > 0) {
            let message = "Recursion detected in dependency_graph files:\n\n";

            for (const { file, issues } of allIssues) {
                message += `File: ${file}\n`;
                for (const issue of issues) {
                    message += `  Line ${issue.line}: [${issue.pattern}] ${issue.context}\n`;
                }
                message += "\n";
            }

            message +=
                "All recursion must be replaced with iterative algorithms (explicit stacks, queues, or Kahn's algorithm).";

            throw new Error(message);
        }
    });
});
