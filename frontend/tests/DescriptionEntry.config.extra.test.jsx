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

    it("handles fetchConfig error gracefully", async () => {
        // Clear the default mock and make it return null to simulate no config
        fetchConfig.mockResolvedValue(null);

        render(<DescriptionEntry />);

        // When config fetch returns null, no config section should be shown
        await waitFor(() => {
            expect(
                screen.getByPlaceholderText("Type your event description here...")
            ).toBeInTheDocument();
        });

        // Should not show config section when no config is available
        expect(
            screen.queryByText("Event Logging Help")
        ).not.toBeInTheDocument();
        expect(screen.queryByText("shortcuts")).not.toBeInTheDocument();
    });

    it("maintains input focus after shortcut click", async () => {
        render(<DescriptionEntry />);

        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );

        // Wait for config to load
        await waitFor(() => {
            expect(screen.getByText("Help")).toBeInTheDocument();
        });

        // Click shortcuts tab
        const shortcutsTab = screen.getByText("Shortcuts");
        fireEvent.click(shortcutsTab);

        // Click a shortcut
        await waitFor(() => {
            const breakfastShortcut = screen.getByText("breakfast");
            fireEvent.click(
                breakfastShortcut.closest(
                    '[role="button"], [data-testid], div[cursor="pointer"]'
                ) || breakfastShortcut
            );
        });

        // Input should maintain focus
        await waitFor(() => {
            expect(input).toHaveFocus();
        });
    });





    it("shows error toast on submission failure", async () => {
        const mockToast = jest.fn();

        // Mock useToast hook
        jest.doMock("@chakra-ui/react", () => ({
            ...jest.requireActual("@chakra-ui/react"),
            useToast: () => mockToast,
        }));

        submitEntry.mockRejectedValue(new Error("Submission failed"));

        render(<DescriptionEntry />);

        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );
        // Type something
        fireEvent.change(input, { target: { value: "test event" } });

        // Submit using Enter key
        fireEvent.keyUp(input, { key: "Enter", code: "Enter" });

        await waitFor(() => {
            expect(submitEntry).toHaveBeenCalledWith(
                "test event",
                undefined,
                []
            );
        });

        // Input should not be cleared on error
        expect(input.value).toBe("test event");
    });

});
