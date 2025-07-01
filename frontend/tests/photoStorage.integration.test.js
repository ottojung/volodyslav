/**
 * Integration test for photo storage solution
 * Tests that the IndexedDB-based photo storage resolves the quota exceeded issue
 */

import { storePhotos, retrievePhotos } from '../src/DescriptionEntry/photoStorage.js';

// Mock IndexedDB for testing
const mockIndexedDB = (() => {
    const mockStore = new Map();
    const mockDB = {
        transaction: jest.fn().mockImplementation(() => {
            const transaction = {
                objectStore: jest.fn().mockImplementation(() => ({
                    put: jest.fn().mockImplementation((data, key) => {
                        mockStore.set(key, data);
                        setTimeout(() => {
                            if (typeof transaction.oncomplete === 'function') {
                                transaction.oncomplete();
                            }
                        }, 0);
                    }),
                    get: jest.fn().mockImplementation((key) => {
                        const request = {
                            result: mockStore.get(key)
                        };
                        setTimeout(() => {
                            if (typeof request.onsuccess === 'function') {
                                request.onsuccess();
                            }
                        }, 0);
                        return request;
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
            setTimeout(() => {
                if (typeof req.onupgradeneeded === 'function') {
                    req.result = mockDB;
                    req.onupgradeneeded({ target: req });
                }
                if (typeof req.onsuccess === 'function') {
                    req.result = mockDB;
                    req.onsuccess({ target: req });
                }
            }, 0);
            return req;
        }),
        mockStore
    };
})();

global.indexedDB = mockIndexedDB;

describe('Photo Storage Integration', () => {
    beforeEach(() => {
        mockIndexedDB.mockStore.clear();
        jest.clearAllMocks();
    });

    test('can store and retrieve large amounts of photo data without quota errors', async () => {
        // Create a large photo dataset that would exceed sessionStorage quota
        const largePhotoData = [];
        for (let i = 0; i < 20; i++) {
            // Simulate a 2MB base64-encoded photo (typical high-resolution mobile photo)
            const fakeBase64Data = 'A'.repeat(2 * 1024 * 1024); // 2MB of 'A' characters
            largePhotoData.push({
                name: `photo_${i.toString().padStart(2, '0')}.jpeg`,
                data: fakeBase64Data,
                type: 'image/jpeg'
            });
        }

        // This should work without quota exceeded errors
        await expect(storePhotos('large_photo_session', largePhotoData)).resolves.toBeUndefined();

        // Verify the data was stored correctly
        const retrievedData = await retrievePhotos('large_photo_session');
        expect(retrievedData).toEqual(largePhotoData);
        expect(retrievedData).toHaveLength(20);
    });

    test('successfully handles multiple concurrent photo storage operations', async () => {
        const promises = [];
        
        // Create multiple photo sessions simultaneously
        for (let session = 0; session < 5; session++) {
            const photosForSession = [];
            for (let photo = 0; photo < 3; photo++) {
                const fakeBase64Data = 'B'.repeat(1024 * 1024); // 1MB photo
                photosForSession.push({
                    name: `session_${session}_photo_${photo}.jpeg`,
                    data: fakeBase64Data,
                    type: 'image/jpeg'
                });
            }
            
            promises.push(storePhotos(`session_${session}`, photosForSession));
        }

        // All storage operations should complete successfully
        await expect(Promise.all(promises)).resolves.toBeDefined();

        // Verify all sessions can be retrieved
        for (let session = 0; session < 5; session++) {
            const retrievedData = await retrievePhotos(`session_${session}`);
            expect(retrievedData).toHaveLength(3);
            expect(retrievedData[0].name).toContain(`session_${session}`);
        }
    });

    test('handles edge case of extremely large single photo', async () => {
        // Simulate a 10MB photo (very large for mobile, but possible)
        const extremelyLargePhoto = [{
            name: 'extreme_photo.jpeg',
            data: 'C'.repeat(10 * 1024 * 1024), // 10MB
            type: 'image/jpeg'
        }];

        // This should work with IndexedDB but would fail with sessionStorage
        await expect(storePhotos('extreme_session', extremelyLargePhoto)).resolves.toBeUndefined();

        const retrievedData = await retrievePhotos('extreme_session');
        expect(retrievedData).toEqual(extremelyLargePhoto);
        expect(retrievedData[0].data).toHaveLength(10 * 1024 * 1024);
    });
});
