import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// Mock Chakra UI useToast
const mockToast = jest.fn();
jest.mock('@chakra-ui/react', () => {
    const actual = jest.requireActual('@chakra-ui/react');
    return {
        __esModule: true,
        ...actual,
        useToast: () => mockToast,
    };
});

import Camera from '../src/Camera/Camera.jsx';

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
            callback(new Blob(['dummy'], { type: 'image/jpeg' }));
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
        // Make sure request_identifier is present
        window.history.replaceState({}, 'test', '/?request_identifier=TEST_ID');

        // Clear mocks
        mockToast.mockClear();
        global.fetch.mockClear();
    });

    test('initial render shows Take Photo and Done buttons', () => {
        render(<Camera />);
        expect(screen.getByText('Take Photo')).toBeInTheDocument();
        expect(screen.getByText('Done')).toBeInTheDocument();
        expect(screen.queryByText('Redo')).not.toBeInTheDocument();
        expect(screen.queryByText('More')).not.toBeInTheDocument();
    });

    test('takes photo and shows preview with controls', async () => {
        render(<Camera />);
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
        render(<Camera />);
        await waitFor(() => expect(getUserMediaMock).toHaveBeenCalled());
        fireEvent.click(screen.getByText('Take Photo'));
        await waitFor(() => screen.getByAltText('Preview'));

        fireEvent.click(screen.getByText('More'));
        expect(screen.getByText('Take Photo')).toBeInTheDocument();

        // Preview remains in the DOM but hidden
        expect(screen.getByAltText('Preview')).not.toBeVisible();
    });

    test('Redo button also returns to camera mode', async () => {
        render(<Camera />);
        await waitFor(() => expect(getUserMediaMock).toHaveBeenCalled());
        fireEvent.click(screen.getByText('Take Photo'));
        await waitFor(() => screen.getByAltText('Preview'));

        fireEvent.click(screen.getByText('Redo'));
        expect(screen.getByText('Take Photo')).toBeInTheDocument();
        expect(screen.getByAltText('Preview')).not.toBeVisible();
    });

    test('Done button without photos shows error toast', async () => {
        render(<Camera />);
        fireEvent.click(screen.getByText('Done'));

        await waitFor(() => {
            expect(mockToast).toHaveBeenCalledWith(
                expect.objectContaining({
                    title: 'No photos to upload',
                    status: 'error',
                    duration: 3000,
                    isClosable: true,
                    position: 'top',
                })
            );
        });
    });

    test('Done button with one photo uploads and shows success toast (and includes request_identifier)', async () => {
        render(<Camera />);
        await waitFor(() => expect(getUserMediaMock).toHaveBeenCalled());

        fireEvent.click(screen.getByText('Take Photo'));
        await waitFor(() => screen.getByAltText('Preview'));
        fireEvent.click(screen.getByText('Done'));

        // Should call fetch once
        await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));

        const [url, options] = global.fetch.mock.calls[0];
        const called_url = new URL('/api/upload', window.location.origin)
        called_url.searchParams.set('request_identifier', 'TEST_ID');
        expect(String(url)).toBe(String(called_url));
        expect(options.method).toBe('POST');
        expect(options.body).toBeInstanceOf(FormData);

        await waitFor(() => {
            expect(mockToast).toHaveBeenCalledWith(
                expect.objectContaining({
                    title: 'Upload successful',
                    status: 'success',
                    duration: 3000,
                    isClosable: true,
                    position: 'top',
                })
            );
        });
    });

    test('Done button upload failure shows error toast', async () => {
        // Simulate server error response
        global.fetch.mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve({}) });

        render(<Camera />);
        await waitFor(() => expect(getUserMediaMock).toHaveBeenCalled());

        fireEvent.click(screen.getByText('Take Photo'));
        await waitFor(() => screen.getByAltText('Preview'));
        fireEvent.click(screen.getByText('Done'));

        await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));

        await waitFor(() => {
            expect(mockToast).toHaveBeenCalledWith(
                expect.objectContaining({
                    title: 'Error uploading photos',
                    description: 'Server responded with 500',
                    status: 'error',
                    duration: null,
                    isClosable: true,
                    position: 'top',
                })
            );
        });
    });

    test('Done button uploads multiple photos correctly and shows success toast', async () => {
        render(<Camera />);
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

        await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));

        const fd = global.fetch.mock.calls[0][1].body;
        // Check that exactly two photos were appended
        const allPhotos = fd.getAll ? fd.getAll('photos') : Array.from(fd.entries()).filter(([n]) => n === 'photos');
        expect(allPhotos.length).toBe(2);

        await waitFor(() => {
            expect(mockToast).toHaveBeenCalledWith(
                expect.objectContaining({
                    title: 'Upload successful',
                    status: 'success',
                    duration: 3000,
                    isClosable: true,
                    position: 'top',
                })
            );
        });
    });
});
