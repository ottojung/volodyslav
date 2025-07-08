/**
 * Photo storage utilities using IndexedDB for large capacity storage
 * Replaces sessionStorage for photo data to avoid quota limitations
 */

import {
    makePhotoStorageError,
    makePhotoRetrievalError,
    isPhotoStorageError,
    isPhotoRetrievalError,
} from './error_helpers.js';

const DB_NAME = 'PhotoStorage';
const DB_VERSION = 1;
const STORE_NAME = 'photos';

/**
 * Opens the IndexedDB database
 * @returns {Promise<IDBDatabase>}
 * @throws {PhotoStorageError} When database cannot be opened
 */
async function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => {
            reject(makePhotoStorageError(
                'Failed to open photo storage database',
                request.error
            ));
        };

        request.onsuccess = () => {
            resolve(request.result);
        };

        request.onupgradeneeded = (event) => {
            const target = event.target;
            if (!target) {
                return;
            }
            if (typeof IDBOpenDBRequest !== "undefined") {
                if (!(target instanceof IDBOpenDBRequest)) {
                    return;
                }
                const db = target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME);
                }
            } else {
                // @ts-expect-error IDBOpenDBRequest is not available in this environment
                const db = target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME);
                }
            }
        };
    });
}

/**
 * Stores photo data in IndexedDB
 * @param {string} key - Storage key
 * @param {Array<{name: string, data: string, type: string}>} photosData - Photo data to store
 * @returns {Promise<void>}
 * @throws {PhotoStorageError} When storage operation fails
 */
export async function storePhotos(key, photosData) {
    try {
        const db = await openDatabase();

        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);

            transaction.onerror = () => {
                reject(makePhotoStorageError(
                    'Failed to store photos in database',
                    transaction.error
                ));
            };

            transaction.oncomplete = () => {
                resolve();
            };

            store.put(photosData, key);
        });
    } catch (/** @type {unknown} */ error) {
        if (isPhotoStorageError(error)) {
            throw error;
        }
        throw makePhotoStorageError(
            'Unexpected error during photo storage',
            error instanceof Error ? error : new Error(String(error))
        );
    }
}

/**
 * Retrieves photo data from IndexedDB
 * @param {string} key - Storage key
 * @returns {Promise<Array<{name: string, data: string, type: string}>|null>}
 * @throws {PhotoRetrievalError} When retrieval operation fails
 */
export async function retrievePhotos(key) {
    try {
        const db = await openDatabase();

        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.get(key);

            request.onerror = () => {
                reject(makePhotoRetrievalError(
                    'Failed to retrieve photos from database',
                    key,
                    request.error
                ));
            };

            request.onsuccess = () => {
                resolve(request.result || null);
            };
        });
    } catch (/** @type {unknown} */ error) {
        if (isPhotoRetrievalError(error)) {
            throw error;
        }
        throw makePhotoRetrievalError(
            'Unexpected error during photo retrieval',
            key,
            error instanceof Error ? error : new Error(String(error))
        );
    }
}

/**
 * Removes photo data from IndexedDB
 * @param {string} key - Storage key
 * @returns {Promise<void>}
 * @throws {PhotoStorageError} When removal operation fails
 */
export async function removePhotos(key) {
    try {
        const db = await openDatabase();

        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);

            transaction.onerror = () => {
                reject(makePhotoStorageError(
                    'Failed to remove photos from database',
                    transaction.error
                ));
            };

            transaction.oncomplete = () => {
                resolve();
            };

            store.delete(key);
        });
    } catch (/** @type {unknown} */ error) {
        if (isPhotoStorageError(error)) {
            throw error;
        }
        throw makePhotoStorageError(
            'Unexpected error during photo removal',
            error instanceof Error ? error : new Error(String(error))
        );
    }
}

/**
 * Clears all stored photos (useful for cleanup)
 * @returns {Promise<void>}
 * @throws {PhotoStorageError} When clear operation fails
 */
export async function clearAllPhotos() {
    try {
        const db = await openDatabase();

        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);

            transaction.onerror = () => {
                reject(makePhotoStorageError(
                    'Failed to clear photo database',
                    transaction.error
                ));
            };

            transaction.oncomplete = () => {
                resolve();
            };

            store.clear();
        });
    } catch (/** @type {unknown} */ error) {
        if (isPhotoStorageError(error)) {
            throw error;
        }
        throw makePhotoStorageError(
            'Unexpected error during photo clearing',
            error instanceof Error ? error : new Error(String(error))
        );
    }
}
