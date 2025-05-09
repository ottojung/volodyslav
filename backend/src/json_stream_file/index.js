const { createReadStream } = require("fs");
const { parser } = require("stream-json");
const { streamValues } = require("stream-json/streamers/StreamValues");

/**
 * Reads JSON objects from a file using streaming
 * @param {string} filepath - Path to the JSON file to read
 * @returns {Promise<Array<any>>} Array of parsed JSON objects
 */
async function readObjects(filepath) {
    return new Promise((resolve, reject) => {
        /** @type {Array<any>} */
        const objects = [];
        // create a readable stream
        const rs = createReadStream(filepath, { encoding: "utf8" });
        // parser({ jsonStreaming: true }) allows multiple top-level values
        const pipeline = rs
            .pipe(parser({ jsonStreaming: true }))
            .pipe(streamValues());

        pipeline.on("data", ({ value }) => {
            objects.push(value);
        });

        pipeline.on("end", () => {
            resolve(objects);
        });

        pipeline.on("error", (error) => {
            reject(error);
        });

        rs.on("error", (error) => {
            reject(error);
        });
    });
}

module.exports = { readObjects };
