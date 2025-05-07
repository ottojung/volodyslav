import path from "path";
import { diaryAudiosDirectory, eventLogAssetsDirectory } from "./environment";
import { transcribeAllGeneric } from "./transcribe_all";
import { formatFileTimestamp } from "./formatFileTimestamp";
import { copyFile } from "fs/promises";

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
        const ret = path.join(eventLogAssetsDirectory(), date)
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
    const transcriptionResults = await transcribeAllGeneric(diaryAudiosDir, namer);

    const successes = transcriptionResults.successes;
    const failures = transcriptionResults.failures;

    for (const filename of successes) {
        const inputPath = path.join(diaryAudiosDir, filename);
        const targetDir = assets_directory(filename);
        const targetPath = path.join(targetDir, filename);
        await copyFile(inputPath, targetPath);
    }

    // TODO:
    // - copy file "$eventLogDirectory/data.json" into a private temporary workfile.
    // - start editing that file.
    // - for every $success in successes:
    //   - append a json object to the file like this:
    //     
    //       {
    //          date: filename_to_date($success),
    // 	        original: "diary [when 0 hours ago]",
	// input: "diary [when 0 hours ago]",
	// modifiers: {
	// 	when: "0 hours ago"
	// },
	// type: "diary",
	// description: "",
    //       }
    //
    //
    // - move the file back into the original (effectively atomically updating it)
    //
}
