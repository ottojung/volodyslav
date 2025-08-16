/**
 * Scheduled transcription module for processing diary assets that need transcription.
 * 
 * This module implements Issue #7: "Implement scheduled transcription"
 * It walks through diary entries in the event log assets directory and checks
 * if any need transcription, then transcribes them using the existing AI transcription system.
 */

const path = require("path");
const { transcribeFile } = require("../transcribe");

/** @typedef {import('../capabilities/root').Capabilities} Capabilities */

/**
 * Audio file extensions that should be transcribed.
 */
const AUDIO_EXTENSIONS = [".mp3", ".wav", ".m4a", ".mp4", ".webm"];

/**
 * Custom error class for scheduled transcription errors.
 */
class ScheduledTranscriptionError extends Error {
    /**
     * @param {string} message
     * @param {unknown} cause
     */
    constructor(message, cause) {
        super(message);
        this.name = "ScheduledTranscriptionError";
        this.cause = cause;
    }
}

/**
 * @param {unknown} object
 * @returns {object is ScheduledTranscriptionError}
 */
function isScheduledTranscriptionError(object) {
    return object instanceof ScheduledTranscriptionError;
}

/**
 * Checks if a file is an audio file based on its extension.
 * @param {string} filePath - The path to the file.
 * @returns {boolean} - True if the file is an audio file.
 */
function isAudioFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return AUDIO_EXTENSIONS.includes(ext);
}

/**
 * Generates the expected transcription file path for an audio file.
 * @param {string} audioFilePath - The path to the audio file.
 * @returns {string} - The expected path to the transcription file.
 */
function getTranscriptionPath(audioFilePath) {
    return `${audioFilePath}.transcription.json`;
}

/**
 * Checks if a transcription file already exists for an audio file.
 * @param {Capabilities} capabilities
 * @param {string} audioFilePath - The path to the audio file.
 * @returns {Promise<boolean>} - True if transcription exists.
 */
async function transcriptionExists(capabilities, audioFilePath) {
    const transcriptionPath = getTranscriptionPath(audioFilePath);
    try {
        await capabilities.checker.instantiate(transcriptionPath);
        return true;
    } catch {
        return false;
    }
}

/**
 * Recursively scans a directory and finds all audio files that need transcription.
 * @param {Capabilities} capabilities
 * @param {string} dirPath - The directory path to scan.
 * @returns {Promise<string[]>} - Array of audio file paths that need transcription.
 */
async function findAudioFilesNeedingTranscription(capabilities, dirPath) {
    const fs = require("fs").promises;
    const audioFilesNeedingTranscription = [];
    
    try {
        const entries = await capabilities.scanner.scanDirectory(dirPath);
        
        for (const entry of entries) {
            try {
                const stat = await fs.stat(entry.path);
                
                if (stat.isDirectory()) {
                    // Recursively scan subdirectories
                    const subDirResults = await findAudioFilesNeedingTranscription(capabilities, entry.path);
                    audioFilesNeedingTranscription.push(...subDirResults);
                } else if (isAudioFile(entry.path)) {
                    // Check if this audio file needs transcription
                    const needsTranscription = !(await transcriptionExists(capabilities, entry.path));
                    if (needsTranscription) {
                        audioFilesNeedingTranscription.push(entry.path);
                    }
                }
            } catch (entryError) {
                // Log error for individual entries but continue processing
                capabilities.logger.logWarning(
                    { 
                        error: entryError instanceof Error ? entryError.message : String(entryError),
                        entryPath: entry.path
                    },
                    `Failed to process entry: ${entry.path}`
                );
            }
        }
    } catch (error) {
        // Log the error but continue processing other directories
        capabilities.logger.logWarning(
            { 
                error: error instanceof Error ? error.message : String(error),
                dirPath 
            },
            `Failed to scan directory for transcription candidates: ${dirPath}`
        );
    }
    
    return audioFilesNeedingTranscription;
}

/**
 * Transcribes a single audio file and stores the result.
 * @param {Capabilities} capabilities
 * @param {string} audioFilePath - The path to the audio file to transcribe.
 * @returns {Promise<void>}
 */
async function transcribeAudioFile(capabilities, audioFilePath) {
    try {
        const audioFile = await capabilities.checker.instantiate(audioFilePath);
        const transcriptionPath = getTranscriptionPath(audioFilePath);
        
        capabilities.logger.logInfo(
            { audioFilePath, transcriptionPath },
            `Starting transcription of audio file: ${path.basename(audioFilePath)}`
        );
        
        await transcribeFile(capabilities, audioFile, transcriptionPath);
        
        capabilities.logger.logInfo(
            { audioFilePath, transcriptionPath },
            `Successfully transcribed audio file: ${path.basename(audioFilePath)}`
        );
    } catch (error) {
        capabilities.logger.logError(
            { 
                error: error instanceof Error ? error.message : String(error),
                audioFilePath 
            },
            `Failed to transcribe audio file: ${path.basename(audioFilePath)}`
        );
        throw new ScheduledTranscriptionError(
            `Failed to transcribe ${audioFilePath}: ${error instanceof Error ? error.message : String(error)}`,
            error
        );
    }
}

/**
 * Main function that performs scheduled transcription of diary assets.
 * This is the function that should be called by the scheduler.
 * @param {Capabilities} capabilities
 * @returns {Promise<void>}
 */
async function executeScheduledTranscription(capabilities) {
    capabilities.logger.logInfo({}, "Starting scheduled transcription task");
    
    try {
        const assetsDir = capabilities.environment.eventLogAssetsDirectory();
        
        capabilities.logger.logInfo(
            { assetsDir },
            `Scanning event log assets directory for audio files needing transcription`
        );
        
        const audioFilesNeedingTranscription = await findAudioFilesNeedingTranscription(
            capabilities, 
            assetsDir
        );
        
        if (audioFilesNeedingTranscription.length === 0) {
            capabilities.logger.logInfo({}, "No audio files found that need transcription");
            return;
        }
        
        capabilities.logger.logInfo(
            { 
                count: audioFilesNeedingTranscription.length,
                files: audioFilesNeedingTranscription.map(f => path.basename(f))
            },
            `Found ${audioFilesNeedingTranscription.length} audio files that need transcription`
        );
        
        let successCount = 0;
        let failureCount = 0;
        
        for (const audioFilePath of audioFilesNeedingTranscription) {
            try {
                await transcribeAudioFile(capabilities, audioFilePath);
                successCount++;
            } catch (error) {
                failureCount++;
                // Error is already logged in transcribeAudioFile, just continue with next file
            }
        }
        
        capabilities.logger.logInfo(
            { 
                totalFiles: audioFilesNeedingTranscription.length,
                successCount,
                failureCount 
            },
            `Scheduled transcription task completed. Successfully transcribed ${successCount} files, ${failureCount} failures`
        );
        
    } catch (error) {
        capabilities.logger.logError(
            { error: error instanceof Error ? error.message : String(error) },
            "Error during scheduled transcription task"
        );
        throw new ScheduledTranscriptionError(
            `Scheduled transcription task failed: ${error instanceof Error ? error.message : String(error)}`,
            error
        );
    }
}

module.exports = {
    executeScheduledTranscription,
    isScheduledTranscriptionError,
    ScheduledTranscriptionError,
    // Export internal functions for testing
    isAudioFile,
    getTranscriptionPath,
    transcriptionExists,
    findAudioFilesNeedingTranscription,
    transcribeAudioFile,
};