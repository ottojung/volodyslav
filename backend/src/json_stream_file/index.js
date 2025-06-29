
/**
 * Minimal capabilities needed for reading JSON stream files
 * @typedef {object} JSONStreamCapabilities
 * @property {import('../filesystem/reader').FileReader} reader - A file reader instance
 */

const { parser } = require("stream-json");
const { streamValues } = require("stream-json/streamers/StreamValues");

/**
 * Reads JSON objects from a file using streaming
 * @param {JSONStreamCapabilities} capabilities - The minimal capabilities needed for reading JSON streams
 * @param {import('../filesystem/file').ExistingFile} file - The JSON file to read
 * @returns {Promise<Array<unknown>>} Array of parsed JSON objects
 */
async function readObjects(capabilities, file) {
    return new Promise((resolve, reject) => {
        /** @type {Array<unknown>} */
        const objects = [];

        // create a readable stream using capabilities
        const rs = capabilities.reader.createReadStream(file);
        rs.setEncoding("utf8");

        // parser({ jsonStreaming: true }) allows multiple top-level values
        const jsonParser = parser({ jsonStreaming: true });
        const pipeline = rs.pipe(jsonParser).pipe(streamValues());

        /**
         * @param {{ value: unknown }} chunk
         */
        function onData(chunk) {
            objects.push(chunk.value);
        }

        pipeline.on("data", onData);

        pipeline.on("end", () => {
            resolve(objects);
        });

        // Listen for errors on each component of the pipeline
        jsonParser.on("error", (/** @type {Error} */ error) => {
            rs.destroy(); // Clean up the stream
            reject(error);
        });

        pipeline.on("error", (/** @type {Error} */ error) => {
            rs.destroy(); // Clean up the stream
            reject(error);
        });

        rs.on("error", (/** @type {Error} */ error) => {
            reject(error);
        });
    });
}

module.exports = { readObjects };
