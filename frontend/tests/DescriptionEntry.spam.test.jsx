import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

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

import DescriptionEntry from "../src/DescriptionEntry/DescriptionEntry.jsx";
// Import the mocked functions after the mock is set up
import {
    fetchRecentEntries,
    submitEntry,
    fetchConfig,
} from "../src/DescriptionEntry/api";

// Import the mocked camera functions
import {
    generateRequestIdentifier,
    navigateToCamera,
    checkCameraReturn,
    cleanupUrlParams,
    restoreDescription,
    retrievePhotos,
} from "../src/DescriptionEntry/cameraUtils";

describe("DescriptionEntry spam prevention", () => {
    // Default mock config for tests that need config functionality
    const defaultMockConfig = {
        help: "Event logging help text",
        shortcuts: [],
    };

    beforeEach(() => {
        // Reset mocks before each test
        fetchRecentEntries.mockClear();
        submitEntry.mockClear();
        fetchConfig.mockClear();

        // Reset camera mocks - use mockReset to clear all state
        generateRequestIdentifier.mockReset();
        navigateToCamera.mockReset();
        checkCameraReturn.mockReset();
        cleanupUrlParams.mockReset();
        restoreDescription.mockReset();
        retrievePhotos.mockReset();

        // Set default mock implementations that resolve immediately
        fetchRecentEntries.mockResolvedValue([]);
        submitEntry.mockResolvedValue({
            success: true,
            entry: { input: "test" },
        });
        // Use default mock config instead of null
        fetchConfig.mockResolvedValue(defaultMockConfig);
        // Set default camera mock implementations - ensure clean state
        generateRequestIdentifier.mockReturnValue("test-req-id-123");
        checkCameraReturn.mockReturnValue({
            isReturn: false,
            requestIdentifier: null,
        });
        restoreDescription.mockReturnValue(null);
        retrievePhotos.mockReturnValue([]);

        // Clear sessionStorage to ensure clean state
        Object.defineProperty(window, "sessionStorage", {
            value: {
                getItem: jest.fn(),
                setItem: jest.fn(),
                removeItem: jest.fn(),
                clear: jest.fn(),
            },
            writable: true,
        });
    });

    it("prevents multiple submissions via rapid Enter key presses", async () => {
        // Make submitEntry take some time to simulate network delay
        submitEntry.mockImplementation(() => {
            return new Promise((resolve) => {
                setTimeout(() => {
                    resolve({
                        success: true,
                        entry: { input: "test event" },
                    });
                }, 100);
            });
        });

        render(<DescriptionEntry />);

        // Wait for component to settle
        await waitFor(() => {
            expect(screen.getByText("Help")).toBeInTheDocument();
        });

        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );
        
        // Type something
        fireEvent.change(input, { target: { value: "test event" } });

        // Simulate rapid Enter key presses (spam)
        fireEvent.keyUp(input, { key: "Enter", code: "Enter" });
        fireEvent.keyUp(input, { key: "Enter", code: "Enter" });
        fireEvent.keyUp(input, { key: "Enter", code: "Enter" });

        // Wait for the submission to complete
        await waitFor(() => {
            expect(input.value).toBe("");
        }, { timeout: 3000 });

        // Should only have called submitEntry once, not three times
        expect(submitEntry).toHaveBeenCalledTimes(1);
    });

    it("prevents multiple submissions via rapid button clicks", async () => {
        // Make submitEntry take some time to simulate network delay
        submitEntry.mockImplementation(() => {
            return new Promise((resolve) => {
                setTimeout(() => {
                    resolve({
                        success: true,
                        entry: { input: "test event" },
                    });
                }, 100);
            });
        });

        render(<DescriptionEntry />);

        // Wait for component to settle
        await waitFor(() => {
            expect(screen.getByText("Help")).toBeInTheDocument();
        });

        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );
        
        // Type something
        fireEvent.change(input, { target: { value: "test event" } });

        const submitButton = screen.getByText("Submit");

        // Simulate rapid button clicks (spam)
        fireEvent.click(submitButton);
        fireEvent.click(submitButton);
        fireEvent.click(submitButton);

        // Wait for the submission to complete
        await waitFor(() => {
            expect(input.value).toBe("");
        }, { timeout: 3000 });

        // Should only have called submitEntry once, not three times
        expect(submitEntry).toHaveBeenCalledTimes(1);
    });

    it("prevents submission via Enter after field is cleared but submission is in progress", async () => {
        // Make submitEntry take some time to simulate network delay
        let resolveSubmit;
        submitEntry.mockImplementation(() => {
            return new Promise((resolve) => {
                resolveSubmit = () => resolve({
                    success: true,
                    entry: { input: "test event" },
                });
            });
        });

        render(<DescriptionEntry />);

        // Wait for component to settle
        await waitFor(() => {
            expect(screen.getByText("Help")).toBeInTheDocument();
        });

        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );
        
        // Type something
        fireEvent.change(input, { target: { value: "test event" } });

        // Submit via Enter
        fireEvent.keyUp(input, { key: "Enter", code: "Enter" });

        // Wait a bit for the description to be cleared
        await waitFor(() => {
            expect(input.value).toBe("");
        });

        // Now try to submit again via Enter while the first submission is still pending
        fireEvent.keyUp(input, { key: "Enter", code: "Enter" });

        // Complete the first submission
        resolveSubmit();

        // Wait for everything to settle
        await waitFor(() => {
            expect(fetchRecentEntries).toHaveBeenCalled();
        }, { timeout: 3000 });

        // Should only have called submitEntry once
        expect(submitEntry).toHaveBeenCalledTimes(1);
    });
});
