const { execFile } = require("node:child_process");
const { promisify } = require("node:util");


/**
 * Executes a subprocess and returns a promise with the result.
 *
 * @param {string} command - The command to execute.
 * @param {string[]} args - The arguments to pass to the command.
 * @param {import('child_process').ExecFileOptions} options - Options for the subprocess.
 * @returns {Promise<{ stdout: string, stderr: string }>} - The result of the subprocess execution.
 */
const callSubprocess = promisify(execFile);

module.exports = {
    callSubprocess,
};
