/**
 * @typedef {object} Capabilities
 * @property {import('../filesystem/reader').FileReader} reader
 */

const { parser } = require("stream-json");
const { streamValues } = require("stream-json/streamers/StreamValues");

/**
 * Reads JSON objects from a file using streaming
 * @param {Capabilities} capabilities - The capabilities object
 * @param {string} filepath - Path to the JSON file to read
 * @returns {Promise<Array<any>>} Array of parsed JSON objects
 */
async function readObjects(capabilities, filepath) {
    return new Promise((resolve, reject) => {
        /** @type {Array<any>} */
        const objects = [];

        // create a readable stream using capabilities
        const rs = capabilities.reader.createReadStream(filepath);
        rs.setEncoding("utf8");

        // parser({ jsonStreaming: true }) allows multiple top-level values
        const jsonParser = parser({ jsonStreaming: true });
        const pipeline = rs.pipe(jsonParser).pipe(streamValues());

        pipeline.on("data", (/** @type {{ value: any }} */ { value }) => {
            objects.push(value);
        });

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
