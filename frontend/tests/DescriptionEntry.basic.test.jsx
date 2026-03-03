import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

// Mock the API module before any imports
jest.mock("../src/DescriptionEntry/api", () => ({
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

// Mock react-router-dom to intercept navigation
const mockNavigate = jest.fn();
jest.mock("react-router-dom", () => ({
    ...jest.requireActual("react-router-dom"),
    useNavigate: () => mockNavigate,
}));

import DescriptionEntry from "../src/DescriptionEntry/DescriptionEntry.jsx";
// Import the mocked functions after the mock is set up
import {
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

describe("DescriptionEntry", () => {
    // Default mock config for tests that need config functionality
    const defaultMockConfig = {
        help: "Event logging help text\n\nSyntax: TYPE [MODIFIERS...] DESCRIPTION\n\nExamples:\n   food [certainty 9] earl gray tea, unsweetened\n   food [when now] [certainty 9] pizza capricciossa, medium size\n   sleep [when 5 hours ago] went to bed\n\nModifiers:\n   [when TIME] - specify when the event happened\n   [certainty LEVEL] - specify how certain you are (1-10)\n\nTypes available: food, sleep, exercise, work, social",
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
        submitEntry.mockClear();
        fetchConfig.mockClear();
        mockNavigate.mockClear();

        // Reset camera mocks - use mockReset to clear all state
        generateRequestIdentifier.mockReset();
        navigateToCamera.mockReset();
        checkCameraReturn.mockReset();
        cleanupUrlParams.mockReset();
        restoreDescription.mockReset();
        retrievePhotos.mockReset();

        // Set default mock implementations that resolve immediately
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

    it("renders the main elements", async () => {
        render(<DescriptionEntry />);

        // Wait for all async operations to complete
        await waitFor(() => {
            expect(fetchConfig).toHaveBeenCalled();
        });

        // Should render the input field
        expect(
            screen.getByPlaceholderText("Type your event description here...")
        ).toBeInTheDocument();

        // Should render the Take Photos button
        expect(
            screen.getByRole("button", { name: /take photos/i })
        ).toBeInTheDocument();

        // Should render configuration section tabs (no Recent Entries tab since it was removed)
        expect(screen.getByText("Help")).toBeInTheDocument();
        expect(screen.getByText("Shortcuts")).toBeInTheDocument();
        expect(screen.queryByText("Recent Entries")).not.toBeInTheDocument();
    });

    it("updates input value when typing", async () => {
        render(<DescriptionEntry />);

        // Wait for component to be fully loaded
        await waitFor(() => {
            expect(fetchConfig).toHaveBeenCalled();
        });

        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );
        fireEvent.change(input, { target: { value: "test input" } });

        expect(input.value).toBe("test input");
    });

    it("renders Take Photos button correctly", async () => {
        render(<DescriptionEntry />);

        // Wait for component to be fully loaded
        await waitFor(() => {
            expect(fetchConfig).toHaveBeenCalled();
        });

        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );
        const takePhotosButton = screen.getByRole("button", { name: /take photos/i });

        // Take Photos button should always be enabled
        expect(takePhotosButton).toBeEnabled();

        // Type something 
        fireEvent.change(input, { target: { value: "some text" } });

        // Take Photos button should still be enabled
        expect(takePhotosButton).toBeEnabled();
    });

    it("does not render config section when no config is available", async () => {
        // Override default mock to return null for this test
        fetchConfig.mockResolvedValue(null);

        render(<DescriptionEntry />);

        // Wait for component to finish loading
        await waitFor(() => {
            expect(fetchConfig).toHaveBeenCalled();
        });

        // Should render the input field
        expect(
            screen.getByPlaceholderText("Type your event description here...")
        ).toBeInTheDocument();

        // Should not show config section when no config is available
        expect(screen.queryByText("Help")).not.toBeInTheDocument();
        expect(screen.queryByText("Shortcuts")).not.toBeInTheDocument();
        expect(screen.queryByText("Recent Entries")).not.toBeInTheDocument();
    });

    it("submits entry when Enter key is pressed", async () => {
        render(<DescriptionEntry />);

        // Wait for component to be fully loaded
        await waitFor(() => {
            expect(fetchConfig).toHaveBeenCalled();
        });

        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );
        // Type something
        fireEvent.change(input, { target: { value: "test event" } });

        // Press Enter
        fireEvent.keyUp(input, { key: "Enter", code: "Enter" });

        await waitFor(() => {
            expect(submitEntry).toHaveBeenCalledWith(
                "test event",
                undefined,
                []
            );
        });
    });

    it("does not submit when Enter is pressed with Shift key", async () => {
        render(<DescriptionEntry />);

        // Wait for component to be fully loaded
        await waitFor(() => {
            expect(fetchConfig).toHaveBeenCalled();
        });

        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );

        // Type something
        fireEvent.change(input, { target: { value: "test event" } });

        // Press Shift+Enter
        fireEvent.keyUp(input, { key: "Enter", code: "Enter", shiftKey: true });

        // Should not submit
        expect(submitEntry).not.toHaveBeenCalled();
    });


});
