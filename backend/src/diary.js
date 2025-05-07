import path from "path";
import os from "os";
import {
    diaryAudiosDirectory,
    eventLogDirectory,
    eventLogAssetsDirectory,
} from "./environment";
import { transcribeAllGeneric } from "./transcribe_all";
import { formatFileTimestamp } from "./formatFileTimestamp";
import { copyFile, appendFile, writeFile, rename } from "fs/promises";

/**
 * @param {string} originalPath 
 * @param {string} resultPath 
 * @returns {Promise<void>}
 */
async function copyOrTouch(originalPath, resultPath) {
    try {
        await copyFile(originalPath, resultPath);
    } catch (error) {
        if (error instanceof Error) {
            if ("code" in error && error.code === "ENOENT") {
                await writeFile(resultPath, "", "utf8");
                return;
            }
        }

        throw error;
    }
}

/**
 * @returns {Promise<void>}
 */
async function processDiaryAudios() {
    /**
     * @param {string} filename
     * @returns {string}
     */
    function filename_to_date(filename) {
        return formatFileTimestamp(filename);
    }

    /**
     * @param {string} filename
     * @returns {string}
     */
    function assets_directory(filename) {
        const date = filename_to_date(filename);
        const ret = path.join(eventLogAssetsDirectory(), date);
        return ret;
    }

    /**
     * @param {string} filename
     * @returns {string}
     */
    function namer(filename) {
        const targetDir = assets_directory(filename);
        const targetName = `transcription.json`;
        return path.join(targetDir, targetName);
    }

    const diaryAudiosDir = diaryAudiosDirectory();
    const transcriptionResults = await transcribeAllGeneric(
        diaryAudiosDir,
        namer
    );

    const successes = transcriptionResults.successes;
    const failures = transcriptionResults.failures;

    for (const filename of successes) {
        const inputPath = path.join(diaryAudiosDir, filename);
        const targetDir = assets_directory(filename);
        const targetPath = path.join(targetDir, filename);
        await copyFile(inputPath, targetPath);
    }

    //
    // now update the event-log data.json
    //
    const eventLogDir = eventLogDirectory();
    const originalDataPath = path.join(eventLogDir, "data.json");
    const tempDataPath = path.join(os.tmpdir(), `data.json`);

    // try to copy the original; if missing, start with empty
    copyOrTouch(originalDataPath, tempDataPath);

    // append one object per successful file
    for (const filename of successes) {
        const dateStr = filename_to_date(filename);

        const entry = {
            date: dateStr,
            original: `diary [when 0 hours ago]`,
            input: `diary [when 0 hours ago]`,
            modifiers: {
                when: "0 hours ago",
            },
            type: "diary",
            description: "",
        };

        const entryString = JSON.stringify(entry, null, "\t");
        await appendFile(tempDataPath, entryString + "\n", "utf8");
    }

    // atomically replace original
    await rename(tempDataPath, originalDataPath);
}

export {
    processDiaryAudios,
}
