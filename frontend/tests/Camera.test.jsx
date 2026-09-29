import React from 'react';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { renderWithProviders } from "./renderWithProviders.jsx";

import Camera from '../src/Camera/Camera.jsx';
import { MINIMUM_SEPARATION_PX } from '../src/Camera/Camera.styles.js';

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
        const MINIMUM_HIT_AREA_PX = 48;

        /**
         * The floor this file asserts independently of the stylesheet's own
         * declaration, so that lowering `MINIMUM_SEPARATION_PX` cannot make the
         * separation assertion pass by moving its own goalpost.
         */
        const SEPARATION_FLOOR_PX = 56;

        /**
         * Convert a computed CSS length to CSS px, resolving rem and em against
         * the 16px root size. Every control declares `fontSize: 1rem`, so an `em`
         * on a control resolves against the same 16px as the root.
         */
        function toPixels(length) {
            const remMatch = /^(-?[\d.]+)(rem|em)$/.exec(length);
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

        /** The bar, found through whichever control is present in the current mode. */
        function controlBarOf(controlName) {
            return regionOf(controlName).parentElement;
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
            expect(toPixels(barStyle.left)).toBe(0);
            expect(toPixels(barStyle.right)).toBe(0);
        });

        test('the bar separates neighbouring regions by a declared length rather than a share of the bar', async () => {
            await enterPreview();
            const gap = getComputedStyle(controlBar()).getPropertyValue('gap');
            expect(gap).not.toBe('');
            expect(gap).toMatch(/^-?[\d.]+(px|rem|em)$/);
            expect(toPixels(gap)).toBeGreaterThan(0);
        });

        /**
         * One inline padding side of an element, in CSS px. jsdom resolves the
         * `padding-inline` logical property but does not expand it onto
         * `padding-left` and `padding-right`, so the logical property is read
         * first and the physical one is the fallback.
         */
        function inlinePadding(style) {
            const logical = style.getPropertyValue('padding-inline');
            if (logical !== '') {
                return toPixels(logical);
            }
            const left = toPixels(style.paddingLeft);
            const right = toPixels(style.paddingRight);
            if (Number.isNaN(left) || Number.isNaN(right)) {
                return Number.NaN;
            }
            return Math.max(left, right);
        }

        /**
         * The separation a finger meets is measured between the edges of two hit
         * areas, so this re-derives that distance from the declarations that
         * produce it rather than from the width of the bar.
         *
         * Two controls in neighbouring regions are held apart by the bar's `gap`,
         * plus the region padding on the facing side of each of the two regions
         * between them. A flex `gap` is an exact offset that is never compressed,
         * and each region is at least `min-content` wide, so this sum is a lower
         * bound on the edge-to-edge distance at every viewport width and in both
         * modes. This asserts enforced CSS; jsdom performs no layout, so it does
         * not assert a measured rectangle.
         */
        function minimumEdgeSeparation() {
            const gap = toPixels(getComputedStyle(controlBar()).getPropertyValue('gap'));
            const regions = Array.from(controlBar().querySelectorAll('[data-control-region]'));
            const insets = regions.map((region) => inlinePadding(getComputedStyle(region)));
            return gap + insets[0] + insets[1];
        }

        test('neighbouring hit areas are held at least 56 CSS px apart edge to edge', async () => {
            await enterPreview();
            const separation = minimumEdgeSeparation();
            expect(separation).toBeGreaterThanOrEqual(SEPARATION_FLOOR_PX);
            expect(separation).toBeGreaterThanOrEqual(MINIMUM_SEPARATION_PX);
        });

        test('a region is never narrower than the control it holds', async () => {
            await enterPreview();
            for (const name of ['Redo', 'More', 'Done']) {
                const regionStyle = getComputedStyle(regionOf(name));
                expect(regionStyle.minWidth).toBe('min-content');
                expect(regionStyle.flexBasis).not.toBe('0');
            }
        });

        test('the centre region is sized by its own control and cannot be squeezed', async () => {
            await enterPreview();
            const centerStyle = getComputedStyle(regionOf('More'));
            expect(centerStyle.flexGrow).toBe('0');
            expect(centerStyle.flexShrink).toBe('0');
        });

        test('the leading and trailing regions take their base width from their own control', async () => {
            await enterPreview();
            for (const name of ['Redo', 'Done']) {
                const regionStyle = getComputedStyle(regionOf(name));
                expect(regionStyle.flexBasis).toBe('auto');
                expect(regionStyle.minWidth).toBe('min-content');
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
         * A declared `gap` and a `min-content` floor only buy separation if the
         * bar's contents still fit at the narrowest supported viewport. This checks
         * that budget from the declarations: a control is its label at a
         * deliberately generous per-character advance plus its declared horizontal
         * padding, floored at its declared minimum; a region adds its declared
         * padding; the bar adds its declared gaps.
         *
         * The per-character advance is an upper bound chosen by this test, not a
         * measured value, so a passing run means the declared geometry leaves room
         * for text this wide, not that this exact text was laid out and measured.
         */
        const GENEROUS_ADVANCE_EM = 0.62;

        function controlWidthOf(label) {
            const controlStyle = getComputedStyle(screen.getByRole('button', { name: label }));
            const fontSize = toPixels(controlStyle.fontSize);
            const text = label.length * GENEROUS_ADVANCE_EM * fontSize;
            const padding = 2 * inlinePadding(controlStyle);
            return Math.max(toPixels(controlStyle.minWidth), text + padding);
        }

        /**
         * The width the bar's contents demand, in CSS px, in the mode currently
         * rendered. Each region claims its own control's width plus its own
         * padding, and a region holding no control claims its padding alone; the
         * bar then adds one declared gap between each neighbouring pair. Because
         * every region is floored at `min-content`, this total is what the bar
         * must satisfy to avoid overflowing the narrowest supported viewport.
         */
        function demandedBarWidth(bar) {
            const gap = toPixels(getComputedStyle(bar).getPropertyValue('gap'));
            const regions = Array.from(bar.querySelectorAll('[data-control-region]'));
            const contents = regions.map((region) => {
                const control = region.querySelector('button');
                const inset = 2 * inlinePadding(getComputedStyle(region));
                return control === null ? inset : controlWidthOf(control.textContent.trim()) + inset;
            });
            return contents.reduce((sum, width) => sum + width, 0) + gap * (regions.length - 1);
        }

        test('the bar still fits its contents at a 320px viewport in camera mode', () => {
            renderCamera();
            expect(demandedBarWidth(controlBarOf('Take Photo'))).toBeLessThanOrEqual(NARROW_VIEWPORT_WIDTH);
        });

        test('the bar still fits its contents at a 320px viewport in preview mode', async () => {
            await enterPreview();
            expect(demandedBarWidth(controlBar())).toBeLessThanOrEqual(NARROW_VIEWPORT_WIDTH);
        });

        test('the discarding action leads and the two keep/finish actions trail it', async () => {
            await enterPreview();
            const regions = Array.from(controlBar().querySelectorAll('[data-control-region]'));
            expect(regions[0].querySelector('button')).toHaveTextContent('Redo');
            expect(regions[1].querySelector('button')).toHaveTextContent('More');
            expect(regions[2].querySelector('button')).toHaveTextContent('Done');
        });

        test('camera mode leaves the leading region empty', () => {
            renderCamera();
            const regions = Array.from(controlBarOf('Take Photo').querySelectorAll('[data-control-region]'));
            expect(regions[0].querySelector('button')).toBeNull();
            expect(regions[1].querySelector('button')).toHaveTextContent('Take Photo');
            expect(regions[2].querySelector('button')).toHaveTextContent('Done');
        });

        test('the camera-mode bar keeps the same three-region structure', () => {
            renderCamera();
            const bar = controlBarOf('Take Photo');
            expect(bar.querySelectorAll('[data-control-region]')).toHaveLength(3);
            expect(getComputedStyle(bar).flexWrap).toBe('nowrap');
        });
    });
});
