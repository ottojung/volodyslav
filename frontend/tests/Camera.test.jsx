import React from 'react';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { renderWithProviders } from "./renderWithProviders.jsx";

import Camera from '../src/Camera/Camera.jsx';

function renderCamera() {
    return renderWithProviders(<Camera />);
}

const passThread = () => new Promise(resolve => setTimeout(resolve, 0));

describe('Camera component', () => {
    let getUserMediaMock;

    beforeAll(() => {
        // Mock navigator.mediaDevices.getUserMedia
        if (!navigator.mediaDevices) {
            navigator.mediaDevices = {};
        }
        getUserMediaMock = jest.fn().mockResolvedValue(
            { getTracks: () => [{ stop: jest.fn() }] } /* mock MediaStream */
        );
        navigator.mediaDevices.getUserMedia = getUserMediaMock;

        // Mock video.play()
        jest.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());

        // Mock canvas methods
        HTMLCanvasElement.prototype.getContext = () => ({ drawImage: jest.fn() });
        HTMLCanvasElement.prototype.toBlob = function(callback) {
            const mockBlob = new Blob(['dummy'], { type: 'image/jpeg' });
            // Add arrayBuffer method if it doesn't exist
            if (!mockBlob.arrayBuffer) {
                mockBlob.arrayBuffer = () => Promise.resolve(new ArrayBuffer(4));
            }
            callback(mockBlob);
        };

        // Mock URL APIs
        URL.createObjectURL = jest.fn(() => 'blob:url');
        URL.revokeObjectURL = jest.fn();

        // Mock fetch for upload
        global.fetch = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

        // Suppress console.error
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterAll(() => {
        jest.restoreAllMocks();
        delete global.fetch;
    });

    beforeEach(() => {
        window.history.replaceState({}, "", "/?request_identifier=TEST_ID");

        // Mock IndexedDB
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
                        get: jest.fn().mockImplementation((key) => ({
                            result: mockStore.get(key)
                        })),
                        delete: jest.fn().mockImplementation((key) => {
                            mockStore.delete(key);
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
        const mockOpen = jest.fn().mockImplementation(() => {
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
        });
        Object.defineProperty(window, 'indexedDB', {
            value: { open: mockOpen },
            writable: true
        });
        window.mockPhotoStore = mockStore;
        global.fetch.mockClear();
    });

    test('initial render shows Take Photo and Done buttons', () => {
        renderCamera();
        expect(screen.getByText('Take Photo')).toBeInTheDocument();
        expect(screen.getByText('Done')).toBeInTheDocument();
        expect(screen.queryByText('Redo')).not.toBeInTheDocument();
        expect(screen.queryByText('More')).not.toBeInTheDocument();
    });

    test('takes photo and shows preview with controls', async () => {
        renderCamera();
        await waitFor(() => expect(getUserMediaMock).toHaveBeenCalled());
        fireEvent.click(screen.getByText('Take Photo'));

        await waitFor(() => {
            const img = screen.getByAltText('Preview');
            expect(img).toBeInTheDocument();
            expect(img).toHaveAttribute('src', 'blob:url');
        });

        expect(screen.getByText('Redo')).toBeInTheDocument();
        expect(screen.getByText('More')).toBeInTheDocument();
        expect(screen.getByText('Done')).toBeInTheDocument();
        expect(screen.queryByText('Take Photo')).not.toBeInTheDocument();
    });

    test('More button returns to camera mode', async () => {
        renderCamera();
        await waitFor(() => expect(getUserMediaMock).toHaveBeenCalled());
        fireEvent.click(screen.getByText('Take Photo'));
        await waitFor(() => screen.getByAltText('Preview'));

        fireEvent.click(screen.getByText('More'));
        expect(screen.getByText('Take Photo')).toBeInTheDocument();

        // Preview remains in the DOM but hidden
        expect(screen.getByAltText('Preview')).not.toBeVisible();
    });

    test('Redo button also returns to camera mode', async () => {
        renderCamera();
        await waitFor(() => expect(getUserMediaMock).toHaveBeenCalled());
        fireEvent.click(screen.getByText('Take Photo'));
        await waitFor(() => screen.getByAltText('Preview'));

        fireEvent.click(screen.getByText('Redo'));
        expect(screen.getByText('Take Photo')).toBeInTheDocument();
        expect(screen.getByAltText('Preview')).not.toBeVisible();
    });

    test('Done button without photos shows error toast', async () => {
        renderCamera();
        fireEvent.click(screen.getByText('Done'));

        await waitFor(() => {
            expect(screen.getByText('No photos to upload')).toBeInTheDocument();
        });
    });

    test('Done button with one photo stores photos and shows success toast', async () => {
        renderCamera();
        await waitFor(() => expect(getUserMediaMock).toHaveBeenCalled());

        fireEvent.click(screen.getByText('Take Photo'));
        await waitFor(() => screen.getByAltText('Preview'));
        
        // Wait a bit for the blob to be processed
        await new Promise(resolve => setTimeout(resolve, 100));
        
        fireEvent.click(screen.getByText('Done'));

        // Should store photos
        await waitFor(() => {
            expect(window.mockPhotoStore.has('photos_TEST_ID')).toBe(true);
            const storedData = window.mockPhotoStore.get('photos_TEST_ID');
            expect(Array.isArray(storedData)).toBe(true);
            expect(storedData).toHaveLength(1);
        });

        // Should not call fetch (no upload to backend)
        expect(global.fetch).not.toHaveBeenCalled();

        await waitFor(() => {
            expect(screen.getByText('Photos ready')).toBeInTheDocument();
        });
    });

    test('Done button with no photos shows error toast', async () => {
        renderCamera();
        await waitFor(() => expect(getUserMediaMock).toHaveBeenCalled());

        // Click done without taking any photos
        fireEvent.click(screen.getByText('Done'));

        await waitFor(() => {
            expect(screen.getByText('No photos to upload')).toBeInTheDocument();
        });

        // Should not store anything
        expect(window.mockPhotoStore.size).toBe(0);
    });

    test('Done button stores multiple photos correctly and shows success toast', async () => {
        renderCamera();
        await waitFor(() => expect(getUserMediaMock).toHaveBeenCalled());

        // Take first photo
        fireEvent.click(screen.getByText('Take Photo'));
        await waitFor(() => screen.getByAltText('Preview'));
        fireEvent.click(screen.getByText('More'));

        // Take second photo
        await waitFor(() => screen.getByText('Take Photo'));
        fireEvent.click(screen.getByText('Take Photo'));
        await waitFor(() => screen.getByAltText('Preview'));
        fireEvent.click(screen.getByText('Done'));

        // Should store both photos
        await waitFor(() => {
            expect(window.mockPhotoStore.has('photos_TEST_ID')).toBe(true);
            const storedData = window.mockPhotoStore.get('photos_TEST_ID');
            expect(Array.isArray(storedData)).toBe(true);
            expect(storedData).toHaveLength(2);
        });

        await waitFor(() => {
            expect(screen.getByText('Photos ready')).toBeInTheDocument();
        });
    });
});
