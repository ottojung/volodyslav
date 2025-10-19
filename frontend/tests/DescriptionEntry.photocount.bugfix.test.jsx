import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

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

// Mock the API module before any imports
jest.mock("../src/DescriptionEntry/api", () => ({
    fetchRecentEntries: jest.fn(),
    submitEntry: jest.fn(),
    fetchConfig: jest.fn(),
}));

// Mock the logger module to prevent console output during tests
jest.mock("../src/DescriptionEntry/logger", () => ({
    logger: {
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
    },
}));

// Mock camera utilities to test camera integration
jest.mock("../src/DescriptionEntry/cameraUtils", () => ({
    generateRequestIdentifier: jest.fn(),
    navigateToCamera: jest.fn(),
    checkCameraReturn: jest.fn(),
    cleanupUrlParams: jest.fn(),
    restoreDescription: jest.fn(),
    retrievePhotos: jest.fn(),
}));

// Mock IndexedDB photo storage
jest.mock("../src/DescriptionEntry/photoStorage", () => ({
    retrievePhotos: jest.fn(),
}));

import DescriptionEntry from "../src/DescriptionEntry/DescriptionEntry.jsx";
import { 
    fetchRecentEntries,
    submitEntry,
    fetchConfig,
} from "../src/DescriptionEntry/api";
import {
    generateRequestIdentifier,
    navigateToCamera,
    checkCameraReturn,
    cleanupUrlParams,
    restoreDescription,
    retrievePhotos,
} from "../src/DescriptionEntry/cameraUtils";
import { retrievePhotos as retrievePhotosFromIndexedDB } from "../src/DescriptionEntry/photoStorage";

describe("Photo Count Display Bug Fix", () => {
    const mockConfig = {
        shortcuts: [
            ["breakfast", "food [when this morning]", "Quick breakfast entry"],
            ["lunch", "food [when noon]", "Quick lunch entry"],
            ["dinner", "food [when evening]", "Quick dinner entry"],
            ["\\bcoffee\\b", "food [certainty 10] coffee", "Coffee shortcut"],
            ["\\btea\\b", "food [certainty 10] tea", "Tea shortcut"],
            [
                "slept (\\d+)h",
                "sleep [duration $1 hours]",
                "Sleep duration shortcut",
            ],
            [
                "worked (\\d+)h",
                "work [duration $1 hours]",
                "Work duration shortcut",
            ],
        ],
    };

    beforeEach(() => {
        // Reset mocks before each test
        fetchRecentEntries.mockClear();
        submitEntry.mockClear();
        fetchConfig.mockClear();
        mockToast.mockClear();

        // Reset camera mocks
        generateRequestIdentifier.mockReset();
        navigateToCamera.mockReset();
        checkCameraReturn.mockReset();
        cleanupUrlParams.mockReset();
        restoreDescription.mockReset();
        retrievePhotos.mockReset();
        retrievePhotosFromIndexedDB.mockReset();

        // Set default returns
        fetchRecentEntries.mockResolvedValue([]);
        fetchConfig.mockResolvedValue(mockConfig);
        submitEntry.mockResolvedValue({
            success: true,
            entry: { input: "test entry" },
        });
    });

    test("displays correct photo count when returning from camera with photos stored in IndexedDB", async () => {
        // Mock returning from camera
        checkCameraReturn.mockReturnValue({
            isReturn: true,
            requestIdentifier: "test-req-id-123",
        });

        // Mock restored description
        restoreDescription.mockReturnValue("Test description with photos");

        // Mock IndexedDB having 3 photos
        const mockPhotosData = [
            { name: "photo_01.jpeg", data: "base64data1", type: "image/jpeg" },
            { name: "photo_02.jpeg", data: "base64data2", type: "image/jpeg" },
            { name: "photo_03.jpeg", data: "base64data3", type: "image/jpeg" },
        ];
        retrievePhotosFromIndexedDB.mockResolvedValue(mockPhotosData);

        render(<DescriptionEntry />);

        // Wait for the component to process the camera return
        await waitFor(() => {
            expect(checkCameraReturn).toHaveBeenCalled();
            expect(restoreDescription).toHaveBeenCalledWith("test-req-id-123");
            expect(cleanupUrlParams).toHaveBeenCalled();
        });

        // Wait for the toast to be called with correct photo count
        await waitFor(() => {
            expect(mockToast).toHaveBeenCalledWith(
                expect.objectContaining({
                    title: "3 photos ready",
                    description: "Complete your description and submit to create the entry.",
                    status: "success",
                    duration: 5000,
                    isClosable: true,
                    position: "bottom",
                })
            );
        });

        // Verify the IndexedDB retrieval was called correctly
        expect(retrievePhotosFromIndexedDB).toHaveBeenCalledWith("photos_test-req-id-123");

        // Verify description is restored
        const input = screen.getByPlaceholderText("Type your event description here...");
        expect(input.value).toBe("Test description with photos");

        // Should show photos attached indicator with count
        await waitFor(() => {
            expect(screen.getByText(/\+3 photos/)).toBeInTheDocument();
        });
    });

    test("displays 0 photos when no photos are stored in IndexedDB", async () => {
        // Mock returning from camera
        checkCameraReturn.mockReturnValue({
            isReturn: true,
            requestIdentifier: "test-req-id-456",
        });

        // Mock restored description
        restoreDescription.mockReturnValue("Test description without photos");

        // Mock IndexedDB having no photos (null return)
        retrievePhotosFromIndexedDB.mockResolvedValue(null);

        render(<DescriptionEntry />);

        // Wait for the component to process the camera return
        await waitFor(() => {
            expect(checkCameraReturn).toHaveBeenCalled();
            expect(restoreDescription).toHaveBeenCalledWith("test-req-id-456");
            expect(cleanupUrlParams).toHaveBeenCalled();
        });

        // Wait for the toast to be called with correct photo count
        await waitFor(() => {
            expect(mockToast).toHaveBeenCalledWith(
                expect.objectContaining({
                    title: "0 photos ready",
                    description: "Complete your description and submit to create the entry.",
                    status: "success",
                    duration: 5000,
                    isClosable: true,
                    position: "bottom",
                })
            );
        });        // Verify the IndexedDB retrieval was called correctly
        expect(retrievePhotosFromIndexedDB).toHaveBeenCalledWith("photos_test-req-id-456");
    });

    test("displays 0 photos when IndexedDB returns empty array", async () => {
        // Mock returning from camera
        checkCameraReturn.mockReturnValue({
            isReturn: true,
            requestIdentifier: "test-req-id-789",
        });

        // Mock restored description
        restoreDescription.mockReturnValue("Test description with empty photos");

        // Mock IndexedDB having empty array
        retrievePhotosFromIndexedDB.mockResolvedValue([]);

        render(<DescriptionEntry />);

        // Wait for the component to process the camera return
        await waitFor(() => {
            expect(checkCameraReturn).toHaveBeenCalled();
            expect(restoreDescription).toHaveBeenCalledWith("test-req-id-789");
            expect(cleanupUrlParams).toHaveBeenCalled();
        });

        // Wait for the toast to be called with correct photo count
        await waitFor(() => {
            expect(mockToast).toHaveBeenCalledWith(
                expect.objectContaining({
                    title: "0 photos ready",
                    description: "Complete your description and submit to create the entry.",
                    status: "success",
                    duration: 5000,
                    isClosable: true,
                    position: "bottom",
                })
            );
        });

        // Verify the IndexedDB retrieval was called correctly
        expect(retrievePhotosFromIndexedDB).toHaveBeenCalledWith("photos_test-req-id-789");
    });

    test("handles IndexedDB retrieval errors gracefully", async () => {
        // Mock returning from camera
        checkCameraReturn.mockReturnValue({
            isReturn: true,
            requestIdentifier: "test-req-id-error",
        });

        // Mock restored description
        restoreDescription.mockReturnValue("Test description with error");

        // Mock IndexedDB retrieval failing
        retrievePhotosFromIndexedDB.mockRejectedValue(new Error("IndexedDB error"));

        render(<DescriptionEntry />);

        // Wait for the component to process the camera return
        await waitFor(() => {
            expect(checkCameraReturn).toHaveBeenCalled();
            expect(restoreDescription).toHaveBeenCalledWith("test-req-id-error");
            expect(cleanupUrlParams).toHaveBeenCalled();
        });

        // Should show a warning about photo data issue first
        await waitFor(() => {
            expect(mockToast).toHaveBeenCalledWith(
                expect.objectContaining({
                    title: "Photo data issue",
                    description: "There may be an issue with your photos. Please check if photos are attached before submitting.",
                    status: "warning",
                    duration: 6000,
                    isClosable: true,
                    position: "bottom",
                })
            );
        });

        // Wait for the error case to show 0 photos
        await waitFor(() => {
            expect(mockToast).toHaveBeenCalledWith(
                expect.objectContaining({
                    title: "0 photos ready",
                    description: "Complete your description and submit to create the entry.",
                    status: "success",
                    duration: 5000,
                    isClosable: true,
                    position: "bottom",
                })
            );
        });

        // Verify the IndexedDB retrieval was called correctly
        expect(retrievePhotosFromIndexedDB).toHaveBeenCalledWith("photos_test-req-id-error");
    });
});
