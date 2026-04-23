const assets = require("../assets");
const { makeExclusiveProcess } = require("../exclusive_process");
/** @typedef {import('../capabilities/root').Capabilities} Capabilities */

// ---------------------------------------------------------------------------
// Sync state types
// ---------------------------------------------------------------------------

/**
 * @typedef {{ name: string, message: string, causes: string[] }} SyncErrorDetail
 */

/**
 * @typedef {{ message: string, details: SyncErrorDetail[] }} SyncErrorResponse
 */

/**
 * @typedef {{ status: "idle" }} IdleSyncState
 */

/**
 * @typedef {{ status: "running", started_at: string, reset_to_hostname?: string, steps: SyncStepResult[] }} RunningSyncState
 */

/**
 * @typedef {{ status: "success", started_at: string, finished_at: string, reset_to_hostname?: string, steps: SyncStepResult[] }} SuccessfulSyncState
 */

/**
 * @typedef {{ status: "error", started_at: string, finished_at: string, reset_to_hostname?: string, error: SyncErrorResponse, steps: SyncStepResult[] }} FailedSyncState
 */

/**
 * @typedef {IdleSyncState | RunningSyncState | SuccessfulSyncState | FailedSyncState} SyncState
 */

// ---------------------------------------------------------------------------
// Per-destination error types
// ---------------------------------------------------------------------------

class AssetsSyncError extends Error {
    /** @param {unknown} cause */
    constructor(cause) {
        super(`Assets sync failed: ${cause}`);
        this.name = "AssetsSyncError";
        this.cause = cause;
    }
}

/** @param {unknown} object @returns {object is AssetsSyncError} */
function isAssetsSyncError(object) {
    return object instanceof AssetsSyncError;
}

class GeneratorsSyncError extends Error {
    /** @param {unknown} cause */
    constructor(cause) {
        super(`Generators database sync failed: ${cause}`);
        this.name = "GeneratorsSyncError";
        this.cause = cause;
    }
}

/** @param {unknown} object @returns {object is GeneratorsSyncError} */
function isGeneratorsSyncError(object) {
    return object instanceof GeneratorsSyncError;
}

// ---------------------------------------------------------------------------
// Aggregate error
// ---------------------------------------------------------------------------

/**
 * @typedef {AssetsSyncError | GeneratorsSyncError} SyncDestinationError
 */

class SynchronizeAllError extends Error {
    /**
     * @param {SyncDestinationError[]} errors
     */
    constructor(errors) {
        super(`Synchronization failed: ${errors.map((e) => e.message).join("; ")}`);
        this.name = "SynchronizeAllError";
        /** @type {SyncDestinationError[]} */
        this.errors = errors;
    }
}

/** @param {unknown} object @returns {object is SynchronizeAllError} */
function isSynchronizeAllError(object) {
    return object instanceof SynchronizeAllError;
}

// ---------------------------------------------------------------------------
// synchronizeAll
// ---------------------------------------------------------------------------

/**
 * @typedef {{ name: string, status: "success" | "error" }} SyncStepResult
 */

/**
 * @param {unknown} error
 * @returns {string[]}
 */
function describeErrorCauses(error) {
    /** @type {string[]} */
    const causes = [];
    let current = error;

    while (current !== undefined) {
        if (current instanceof Error) {
            causes.push(current.message);
            current = "cause" in current ? current.cause : undefined;
            continue;
        }

        causes.push(String(current));
        break;
    }

    return causes;
}

/**
 * @param {unknown} error
 * @returns {SyncErrorResponse}
 */
function makeSyncErrorResponse(error) {
    if (isSynchronizeAllError(error)) {
        const details = error.errors.map((entry) => ({
            name: entry.name,
            message: entry.message,
            causes: describeErrorCauses(entry.cause),
        }));
        return {
            message: `Sync failed: ${details.map((entry) => entry.message).join("; ")}`,
            details,
        };
    }

    const message = error instanceof Error ? error.message : String(error);
    return {
        message: `Sync failed: ${message}`,
        details: [
            {
                name: error instanceof Error ? error.name : "Error",
                message,
                causes: error instanceof Error && "cause" in error
                    ? describeErrorCauses(error.cause)
                    : [],
            },
        ],
    };
}

/**
 * Returns `"queue"` if the incoming options conflict with the current run's
 * options.  A conflict occurs when the new caller wants to reset to a specific
 * hostname that differs from what the current run is doing (either the current
 * run has no reset, or is resetting to a different hostname).
 *
 * If the new caller has no reset requirement (`resetToHostname` is absent),
 * any ongoing run is acceptable and the new call attaches.
 *
 * @param {{ resetToHostname?: string } | undefined} initiating
 * @param {{ resetToHostname?: string } | undefined} attaching
 * @returns {"attach" | "queue"}
 */
function _syncConflictor(initiating, attaching) {
    const incomingReset = attaching?.resetToHostname;
    if (incomingReset === undefined) return "attach";
    return incomingReset !== initiating?.resetToHostname ? "queue" : "attach";
}

// ---------------------------------------------------------------------------
// Exclusive process
// ---------------------------------------------------------------------------

/**
 * Shared ExclusiveProcess for synchronization.
 *
 * Both the hourly scheduled job and the POST /sync route use this instance.
 *
 * The procedure uses `mutateState` to transition the state through:
 * `idle → running → success | error`.
 *
 * The first `mutateState` call in the procedure is synchronous, so by the time
 * `invoke` returns the state is already `"running"`.
 *
 * Behaviour when a second call arrives while a run is active:
 * - **Compatible options** (same `resetToHostname` or none) → attaches to the
 *   current run; both share the same state updates.
 * - **Conflicting options** (wants a reset the current run isn't doing) →
 *   queued: after the current run ends a fresh run starts with the queued
 *   options; last-write-wins when multiple conflicting calls queue up.
 */
const synchronizeAllExclusiveProcess = makeExclusiveProcess({
    /** @type {SyncState} */
    initialState: { status: "idle" },
    /**
     * @param {(fn: (state: SyncState) => SyncState | Promise<SyncState>) => Promise<void>} mutateState
     * @param {{ resetToHostname?: string } | undefined} options
     * @returns {Promise<void>}
     */
    procedure: (mutateState, options) => {
        const capabilities = synchronizeAllExclusiveProcess.getCapabilities();
        const started_at = capabilities.datetime.now().toISOString();
        const reset_to_hostname = options?.resetToHostname;
        const runningHostname = capabilities.environment.hostname();

        // Sync transformer → state is updated synchronously before invoke returns.
        mutateState(() => ({
            status: "running",
            started_at,
            reset_to_hostname,
            steps: [],
        }));

        capabilities.logger.logInfo(
            { started_at, reset_to_hostname, runningHostname },
            "Sync started in background"
        );

        /** @param {SyncStepResult} step */
        const onStepComplete = (step) => {
            mutateState((current) => {
                if (current.status !== "running") return current;
                return { ...current, steps: [...current.steps, step] };
            });
        };

        return _synchronizeAllUnlocked(capabilities, options, onStepComplete)
            .then(() => {
                const finished_at = capabilities.datetime.now().toISOString();
                mutateState((current) => ({
                    status: "success",
                    started_at,
                    finished_at,
                    reset_to_hostname,
                    steps: current.status === "running" ? current.steps : [],
                }));
                capabilities.logger.logInfo(
                    { started_at, finished_at, reset_to_hostname, runningHostname },
                    "Sync finished successfully"
                );
            })
            .catch((error) => {
                const finished_at = capabilities.datetime.now().toISOString();
                const syncError = makeSyncErrorResponse(error);
                mutateState((current) => ({
                    status: "error",
                    started_at,
                    finished_at,
                    reset_to_hostname,
                    error: syncError,
                    steps: current.status === "running" ? current.steps : [],
                }));
                capabilities.logger.logError(
                    { error: syncError.message, details: syncError.details },
                    "Errors during synchronization"
                );
                throw error;
            });
    },
    conflictor: _syncConflictor,
});

/**
 * Synchronizes all destinations and then invalidates the incremental graph interface.
 *
 * All destinations are always attempted even if earlier ones fail (best-effort).
 * If any step fails it is wrapped in a dedicated typed error and collected.
 * A {@link SynchronizeAllError} containing all per-destination errors is thrown
 * at the end if at least one step failed; callers can inspect `.errors` and
 * dispatch on each type to produce per-destination log messages or responses.
 *
 * Uses a shared ExclusiveProcess so that concurrent invocations with compatible
 * options attach to the running computation rather than starting a new one.
 * Invocations with conflicting reset options are queued and run after the
 * current one completes.
 *
 * @param {Capabilities} capabilities
 * @param {{ resetToHostname?: string }} [options]
 * @param {((state: SyncState) => void | Promise<void>) | null} [subscriber]
 * @returns {Promise<void>}
 * @throws {SynchronizeAllError}
 */
function synchronizeAll(capabilities, options, subscriber) {
    return synchronizeAllExclusiveProcess.invoke(capabilities, options, subscriber).result;
}

/**
 * Internal (unlocked) implementation of synchronizeAll.
 *
 * @param {Capabilities} capabilities
 * @param {{ resetToHostname?: string }} [options]
 * @param {(step: SyncStepResult) => void} [onStepComplete]
 * @returns {Promise<void>}
 */
async function _synchronizeAllUnlocked(capabilities, options, onStepComplete) {
    /** @type {SyncDestinationError[]} */
    const errors = [];

    await capabilities.interface.synchronizeDatabase(options).then(() => {
        onStepComplete?.({ name: "generators", status: "success" });
    }).catch((cause) => {
        errors.push(new GeneratorsSyncError(cause));
        onStepComplete?.({ name: "generators", status: "error" });
    });

    await assets.synchronize(capabilities).then(() => {
        onStepComplete?.({ name: "assets", status: "success" });
    }).catch((cause) => {
        errors.push(new AssetsSyncError(cause));
        onStepComplete?.({ name: "assets", status: "error" });
    });

    if (errors.length > 0) {
        throw new SynchronizeAllError(errors);
    }
}

module.exports = {
    synchronizeAll,
    synchronizeAllExclusiveProcess,
    isSynchronizeAllError,
    isAssetsSyncError,
    isGeneratorsSyncError,
};
