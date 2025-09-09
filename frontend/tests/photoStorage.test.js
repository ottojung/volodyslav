/**
 * Tests for photoStorage.js using IndexedDB
 */

import { storePhotos, retrievePhotos, removePhotos, clearAllPhotos } from '../src/DescriptionEntry/photoStorage.js';

const passThread = () => new Promise(resolve => setTimeout(resolve, 0));

// Mock IndexedDB
const mockIndexedDB = (() => {
    const mockStore = new Map();
    const mockDB = {
        transaction: jest.fn().mockImplementation(() => {
            const transaction = {
                objectStore: jest.fn().mockImplementation(() => ({
                    put: jest.fn().mockImplementation((data, key) => {
                        mockStore.set(key, data);
                        passThread().then(() => {
                            if (typeof transaction.oncomplete === 'function') {
                                transaction.oncomplete();
                            }
                        });
                    }),
                    get: jest.fn().mockImplementation((key) => {
                        const request = {
                            result: mockStore.get(key)
                        };
                        passThread().then(() => {
                            if (typeof request.onsuccess === 'function') {
                                request.onsuccess();
                            }
                        });
                        return request;
                    }),
                    delete: jest.fn().mockImplementation((key) => {
                        mockStore.delete(key);
                        passThread().then(() => {
                            if (typeof transaction.oncomplete === 'function') {
                                transaction.oncomplete();
                            }
                        });
                    }),
                    clear: jest.fn().mockImplementation(() => {
                        mockStore.clear();
                        passThread().then(() => {
                            if (typeof transaction.oncomplete === 'function') {
                                transaction.oncomplete();
                            }
                        });
                    })
                })),
                oncomplete: null,
                onerror: null
            };
            return transaction;
        }),
        objectStoreNames: {
            contains: jest.fn().mockReturnValue(false)
        },
        createObjectStore: jest.fn()
    };

    return {
        open: jest.fn().mockImplementation(() => {
            const req = {};
            passThread().then(() => {
                if (typeof req.onupgradeneeded === 'function') {
                    req.result = mockDB;
                    req.onupgradeneeded({ target: req });
                }
                if (typeof req.onsuccess === 'function') {
                    req.result = mockDB;
                    req.onsuccess({ target: req });
                }
            });
            return req;
        }),
        mockStore
    };
})();

// Set up global IndexedDB mock
global.indexedDB = mockIndexedDB;

describe('photoStorage', () => {
    beforeEach(() => {
        mockIndexedDB.mockStore.clear();
        jest.clearAllMocks();
    });

    test('storePhotos stores photo data successfully', async () => {
        const testPhotosData = [
            { name: 'photo1.jpg', data: 'base64data1', type: 'image/jpeg' },
            { name: 'photo2.jpg', data: 'base64data2', type: 'image/jpeg' }
        ];

        await storePhotos('test_key', testPhotosData);

        expect(mockIndexedDB.mockStore.has('test_key')).toBe(true);
        expect(mockIndexedDB.mockStore.get('test_key')).toEqual(testPhotosData);
    });

    test('retrievePhotos retrieves stored photo data', async () => {
        const testPhotosData = [
            { name: 'photo1.jpg', data: 'base64data1', type: 'image/jpeg' }
        ];

        // Store data first
        mockIndexedDB.mockStore.set('test_key', testPhotosData);

        const result = await retrievePhotos('test_key');

        expect(result).toEqual(testPhotosData);
    });

    test('retrievePhotos returns null for non-existent key', async () => {
        const result = await retrievePhotos('non_existent_key');

        expect(result).toBeNull();
    });

    test('removePhotos removes stored photo data', async () => {
        const testPhotosData = [
            { name: 'photo1.jpg', data: 'base64data1', type: 'image/jpeg' }
        ];

        // Store data first
        mockIndexedDB.mockStore.set('test_key', testPhotosData);
        expect(mockIndexedDB.mockStore.has('test_key')).toBe(true);

        await removePhotos('test_key');

        expect(mockIndexedDB.mockStore.has('test_key')).toBe(false);
    });

    test('clearAllPhotos clears all stored data', async () => {
        // Store some data
        mockIndexedDB.mockStore.set('key1', [{ name: 'photo1.jpg', data: 'data1', type: 'image/jpeg' }]);
        mockIndexedDB.mockStore.set('key2', [{ name: 'photo2.jpg', data: 'data2', type: 'image/jpeg' }]);
        
        expect(mockIndexedDB.mockStore.size).toBe(2);

        await clearAllPhotos();

        expect(mockIndexedDB.mockStore.size).toBe(0);
    });
});
