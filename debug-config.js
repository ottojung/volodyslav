#!/usr/bin/env node

// Debug script to test config loading
const path = require('path');

// Set up environment variables like the development server
process.env.VOLODYSLAV_EVENT_LOG_REPOSITORY = "dist/test/mock-event-log-repository";
process.env.VOLODYSLAV_WORKING_DIRECTORY = "dist/test/wd";
process.env.VOLODYSLAV_LOG_LEVEL = "debug";

// Import the modules
const { getConfig } = require('./backend/src/config_api');
const environment = require('./backend/src/environment');

// Create minimal capabilities
const capabilities = {
    environment: environment,
    logger: {
        logInfo: (data, msg) => console.log('[INFO]', msg, data),
        logWarning: (data, msg) => console.log('[WARN]', msg, data),
        logError: (data, msg) => console.log('[ERROR]', msg, data),
        logDebug: (data, msg) => console.log('[DEBUG]', msg, data)
    },
    checker: {
        fileExists: async (filePath) => {
            const fs = require('fs').promises;
            try {
                await fs.access(filePath);
                return true;
            } catch {
                return false;
            }
        },
        instantiate: async (filePath) => {
            const fs = require('fs').promises;
            try {
                await fs.access(filePath);
                return { path: filePath };
            } catch (err) {
                throw new Error(`File not found: ${filePath}`);
            }
        }
    },
    reader: {
        createReadStream: (file) => {
            const fs = require('fs');
            return fs.createReadStream(file.path);
        }
    },
    creator: {
        createTemporaryDirectory: async () => {
            const fs = require('fs').promises;
            const os = require('os');
            const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'volodyslav-debug-'));
            console.log('[DEBUG] Created temp directory:', tmpDir);
            return tmpDir;
        }
    },
    deleter: {
        deleteDirectory: async (dirPath) => {
            const fs = require('fs').promises;
            try {
                await fs.rm(dirPath, { recursive: true, force: true });
                console.log('[DEBUG] Deleted temp directory:', dirPath);
            } catch (err) {
                console.log('[DEBUG] Failed to delete temp directory:', dirPath, err.message);
            }
        }
    },
    git: {
        run: async (args, options = {}) => {
            const { spawn } = require('child_process');
            return new Promise((resolve, reject) => {
                console.log('[DEBUG] Running git command:', args.join(' '), 'in', options.cwd || process.cwd());
                const git = spawn('git', args, { 
                    ...options,
                    stdio: ['ignore', 'pipe', 'pipe']
                });
                
                let stdout = '';
                let stderr = '';
                
                git.stdout.on('data', (data) => {
                    stdout += data.toString();
                });
                
                git.stderr.on('data', (data) => {
                    stderr += data.toString();
                });
                
                git.on('close', (code) => {
                    if (code === 0) {
                        resolve(stdout);
                    } else {
                        reject(new Error(`Git command failed with code ${code}: ${stderr}`));
                    }
                });
            });
        }
    }
};

async function debugConfig() {
    try {
        console.log('[DEBUG] Event log repository path:', environment.eventLogRepository());
        console.log('[DEBUG] Working directory:', environment.workingDirectory());
        
        // Check if the repository exists
        const repoExists = await capabilities.checker.fileExists(environment.eventLogRepository());
        console.log('[DEBUG] Repository exists:', repoExists);
        
        if (repoExists) {
            // List repository contents
            const fs = require('fs').promises;
            const contents = await fs.readdir(environment.eventLogRepository());
            console.log('[DEBUG] Repository contents:', contents);
        }
        
        console.log('[DEBUG] Starting config retrieval...');
        const config = await getConfig(capabilities);
        console.log('[DEBUG] Config result:', config);
        
        if (config) {
            console.log('[DEBUG] Config has', config.shortcuts.length, 'shortcuts');
        } else {
            console.log('[DEBUG] No config found');
        }
    } catch (error) {
        console.error('[ERROR] Debug failed:', error.message);
        console.error(error.stack);
    }
}

debugConfig();
