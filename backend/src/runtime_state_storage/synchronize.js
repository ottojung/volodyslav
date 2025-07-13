const path = require("path");
const { init } = require("../gitstore/wrappers");

/** @typedef {import('./types').Capabilities} Capabilities */

/**
 * Custom error for runtime state repository operations.
 */
class RuntimeStateRepositoryError extends Error {
    /**
     * @param {string} message
     * @param {string} repositoryPath
     */
    constructor(message, repositoryPath) {
        super(message);
        this.name = "RuntimeStateRepositoryError";
        this.repositoryPath = repositoryPath;
    }
}

/**
 * Type guard for RuntimeStateRepositoryError.
 * @param {unknown} object
 * @returns {object is RuntimeStateRepositoryError}
 */
function isRuntimeStateRepositoryError(object) {
    return object instanceof RuntimeStateRepositoryError;
}

/**
 * Get local runtime state repository path.
 * @param {Capabilities} capabilities
 * @returns {string}
 */
function pathToLocalRepository(capabilities) {
    const wd = capabilities.environment.workingDirectory();
    return path.join(wd, "runtime-state-repository");
}

/**
 * Get the path to the local repository's .git directory.
 * @param {Capabilities} capabilities
 * @returns {string}
 */
function pathToLocalRepositoryGitDir(capabilities) {
    return path.join(pathToLocalRepository(capabilities), ".git");
}

/**
 * Initialize an empty local repository for runtime state.
 * Unlike event_log_storage, this doesn't sync with a remote - it's purely local.
 * @param {Capabilities} capabilities
 * @returns {Promise<void>}
 * @throws {RuntimeStateRepositoryError}
 */
async function initializeRepository(capabilities) {
    const workDir = pathToLocalRepository(capabilities);
    const gitDir = pathToLocalRepositoryGitDir(capabilities);
    const indexFile = path.join(gitDir, "index");
    
    try {
        capabilities.logger.logInfo({ repository: workDir }, "Initializing runtime state repository");
        
        // Only initialize if it doesn't exist
        if (!(await capabilities.checker.fileExists(indexFile))) {
            await capabilities.creator.createDirectory(workDir);
            await init(capabilities, workDir);
            
            // Configure the repository to allow pushing to the current branch
            await capabilities.git.call(
                "-C",
                workDir,
                "config",
                "receive.denyCurrentBranch",
                "updateInstead"
            );
            
            // Create an initial commit so the repository has a master branch
            const readmeFile = path.join(workDir, "README.md");
            const file = await capabilities.creator.createFile(readmeFile);
            await capabilities.writer.writeFile(
                file,
                "# Runtime State Repository\n\nThis repository stores runtime state for Volodyslav."
            );
            
            // Add and commit the initial file
            await capabilities.git.call("-C", workDir, "add", "--all");
            await capabilities.git.call(
                "-C",
                workDir,
                "-c",
                "user.name=volodyslav",
                "-c",
                "user.email=volodyslav",
                "commit",
                "-m",
                "Initial commit"
            );
            
            capabilities.logger.logInfo({ repository: workDir }, "Runtime state repository initialized");
        }
    } catch (err) {
        throw new RuntimeStateRepositoryError(
            `Failed to initialize runtime state repository: ${err}`,
            workDir
        );
    }
}

/**
 * Ensures the runtime state repository is accessible locally.
 * @param {Capabilities} capabilities
 * @returns {Promise<string>} The path to the .git directory
 */
async function ensureAccessible(capabilities) {
    const gitDir = pathToLocalRepositoryGitDir(capabilities);
    const indexFile = path.join(gitDir, "index");

    if (!(await capabilities.checker.fileExists(indexFile))) {
        await initializeRepository(capabilities);
    }

    return gitDir;
}

/**
 * Synchronizes the runtime state repository.
 * Since this is a local-only repository, this is essentially a no-op
 * that ensures the repository is accessible.
 * @param {Capabilities} capabilities
 * @returns {Promise<void>}
 */
async function synchronize(capabilities) {
    await ensureAccessible(capabilities);
}

module.exports = { synchronize, ensureAccessible, isRuntimeStateRepositoryError };
