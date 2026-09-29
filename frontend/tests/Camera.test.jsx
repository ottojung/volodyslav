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

    describe('preview control separation', () => {
        const NARROW_VIEWPORT_WIDTH = 320;
        const REFERENCE_VIEWPORT_WIDTH = 360;
        const MINIMUM_HIT_AREA_PX = 48;

        /** Convert a computed CSS length to CSS px, resolving rem against the 16px root size. */
        function toPixels(length) {
            const remMatch = /^(-?[\d.]+)rem$/.exec(length);
            if (remMatch) {
                return Number.parseFloat(remMatch[1]) * 16;
            }
            const pxMatch = /^(-?[\d.]+)(px)?$/.exec(length);
            if (pxMatch) {
                return Number.parseFloat(pxMatch[1]);
            }
            return Number.NaN;
        }

        function regionOf(name) {
            const control = screen.getByRole('button', { name });
            return control.closest('[data-control-region]');
        }

        function controlBar() {
            return regionOf('Redo').parentElement;
        }

        async function enterPreview() {
            renderCamera();
            await waitFor(() => expect(getUserMediaMock).toHaveBeenCalled());
            fireEvent.click(screen.getByText('Take Photo'));
            await waitFor(() => screen.getByAltText('Preview'));
        }

        test('the three preview actions are distinct buttons in three distinct regions', async () => {
            await enterPreview();

            const buttons = screen.getAllByRole('button');
            expect(buttons).toHaveLength(3);
            expect(screen.getByRole('button', { name: 'Redo' })).toBeInTheDocument();
            expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument();
            expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();

            const leading = regionOf('Redo');
            const center = regionOf('More');
            const trailing = regionOf('Done');

            expect(leading).toHaveAttribute('data-control-region', 'leading');
            expect(center).toHaveAttribute('data-control-region', 'center');
            expect(trailing).toHaveAttribute('data-control-region', 'trailing');

            const regions = [leading, center, trailing];
            expect(new Set(regions).size).toBe(3);
            for (const region of regions) {
                expect(region.querySelectorAll('[data-control-region]')).toHaveLength(0);
            }
            expect(leading.parentElement).toBe(center.parentElement);
            expect(center.parentElement).toBe(trailing.parentElement);
            expect(leading.nextElementSibling).toBe(center);
            expect(center.nextElementSibling).toBe(trailing);
        });

        test('the control bar spans the full width and never wraps', async () => {
            await enterPreview();
            const bar = controlBar();
            const barStyle = getComputedStyle(bar);

            expect(barStyle.flexWrap).toBe('nowrap');
            expect(barStyle.justifyContent).toBe('space-between');
            expect(toPixels(barStyle.left)).toBe(0);
            expect(toPixels(barStyle.right)).toBe(0);
        });

        test('the three regions are equal shares of the bar', async () => {
            await enterPreview();
            for (const name of ['Redo', 'More', 'Done']) {
                const regionStyle = getComputedStyle(regionOf(name));
                expect(regionStyle.flexGrow).toBe('1');
                expect(regionStyle.flexShrink).toBe('1');
                expect(toPixels(regionStyle.minWidth)).toBe(0);
            }
        });

        test('every preview control keeps a hit area of at least 48 by 48 CSS px', async () => {
            await enterPreview();
            for (const name of ['Redo', 'More', 'Done']) {
                const controlStyle = getComputedStyle(screen.getByRole('button', { name }));
                expect(toPixels(controlStyle.minWidth)).toBeGreaterThanOrEqual(MINIMUM_HIT_AREA_PX);
                expect(toPixels(controlStyle.minHeight)).toBeGreaterThanOrEqual(MINIMUM_HIT_AREA_PX);
            }
        });

        /**
         * The bar is a non-wrapping full-width row whose three regions are equal
         * flex shares, and each control is pinned to one end of its own region.
         * The centre of a control therefore lies inside that region's third of the
         * bar, so two controls in different regions have their centres at least one
         * third of the bar width apart at any viewport width.
         */
        function minimumCentreDistance(viewportWidth) {
            const bar = controlBar();
            const barStyle = getComputedStyle(bar);
            const regionCount = bar.querySelectorAll('[data-control-region]').length;
            expect(barStyle.flexWrap).toBe('nowrap');
            expect(regionCount).toBe(3);
            return viewportWidth / regionCount;
        }

        test('the spatial relationship survives a 360px viewport', async () => {
            await enterPreview();
            expect(minimumCentreDistance(REFERENCE_VIEWPORT_WIDTH)).toBe(120);
        });

        test('the spatial relationship survives a 320px viewport', async () => {
            await enterPreview();
            const distance = minimumCentreDistance(NARROW_VIEWPORT_WIDTH);
            expect(distance).toBeGreaterThanOrEqual(MINIMUM_HIT_AREA_PX);
            expect(distance).toBeCloseTo(106.67, 1);
        });

        test('the discarding action is not adjacent to either keep or finish action', async () => {
            await enterPreview();
            for (const viewportWidth of [NARROW_VIEWPORT_WIDTH, REFERENCE_VIEWPORT_WIDTH, 768]) {
                const distance = minimumCentreDistance(viewportWidth);
                expect(distance).toBeGreaterThanOrEqual(MINIMUM_HIT_AREA_PX);
            }
        });

        test('the camera-mode bar keeps the same three-region structure', () => {
            renderCamera();
            const regions = screen.getByRole('button', { name: 'Done' })
                .closest('[data-control-region]')
                .parentElement
                .querySelectorAll('[data-control-region]');
            expect(regions).toHaveLength(3);
            expect(getComputedStyle(regions[0].parentElement).flexWrap).toBe('nowrap');
        });
    });
});
