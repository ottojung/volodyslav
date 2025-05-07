const fs = require("fs/promises");
const path = require("path");
const { getTargetDirectory, markDone } = require("./request_identifier");
const { transcribeFile } = require("./transcribe");

/**
 * @class
 */
class InputDirectoryNotFound extends Error {
  /** @type {string} */
  path;

  /**
   * @param {string} message
   * @param {string} path
   */
  constructor(message, path) {
    super(message);
    this.path = path;
  }
}

/**
 * @typedef {{ file: string, message: string }} TranscriptionFailure
 */

/**
 * @typedef {{ successes: string[], failures: TranscriptionFailure[] }} TranscriptionStatus
 */

/**
 * Transcribe a request with a generic namer.
 * @param {string} inputDir
 * @param {(file: string) => string} targetFun
 * @returns {Promise<TranscriptionStatus>}
 */
async function transcribeAllGeneric(inputDir, targetFun) {
  const resolvedDir = path.resolve(inputDir);

  let entries;
  try {
    entries = await fs.readdir(resolvedDir);
  } catch {
    throw new InputDirectoryNotFound(`Input directory not found`, resolvedDir);
  }

  const successes = [];
  const failures = [];
  for (const file of entries) {
    const inputPath = path.join(resolvedDir, file);
    const outputPath = targetFun(file);
    try {
      await transcribeFile(inputPath, outputPath);
      successes.push(file);
    } catch (/** @type {unknown} */ err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ file, message });
    }
  }

  return { successes, failures };
}

/**
 * Transcribe a request.
 * @param {string} inputDir
 * @param {string} targetDir
 * @returns {Promise<TranscriptionStatus>}
 */
async function transcribeAllDirectory(inputDir, targetDir) {
  /**
   * @param {string} filename
   * @returns {string}
   */
  function namer(filename) {
    const targetName = `${filename}.json`;
    return path.join(targetDir, targetName);
  }

  return transcribeAllGeneric(inputDir, namer);
}

/**
 * Transcribe a request.
 * @param {string} inputDir
 * @param {import('./request_identifier').RequestIdentifier} reqId
 * @returns {Promise<TranscriptionStatus>}
 */
async function transcribeAllRequest(inputDir, reqId) {
  const targetDir = getTargetDirectory(reqId);
  const result = await transcribeAllDirectory(inputDir, targetDir);
  await markDone(reqId);
  return result;
}

module.exports = {
  InputDirectoryNotFound,
  transcribeAllGeneric,
  transcribeAllDirectory,
  transcribeAllRequest,
};
