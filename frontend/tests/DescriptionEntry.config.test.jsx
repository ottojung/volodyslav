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

    it("handles shortcut clicks from config section", async () => {
        render(<DescriptionEntry />);

        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );

        // Wait for config to load and find a shortcut to click
        await waitFor(() => {
            expect(screen.getByText("Help")).toBeInTheDocument();
        });

        // Find and click the shortcuts tab
        const shortcutsTab = screen.getByText("Shortcuts");
        fireEvent.click(shortcutsTab);

        // Find and click a shortcut (breakfast pattern)
        await waitFor(() => {
            const breakfastShortcut = screen.getByText("breakfast");
            fireEvent.click(
                breakfastShortcut.closest(
                    '[role="button"], [data-testid], div[cursor="pointer"]'
                ) || breakfastShortcut
            );
        });

        // Input should be updated with the pattern
        await waitFor(() => {
            expect(input.value).toBe("food [when this morning]");
        });

        // Input should be focused after shortcut click
        expect(input).toHaveFocus();
    });

    it("handles syntax example clicks from config section", async () => {
        render(<DescriptionEntry />);

        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );

        // Wait for config to load
        await waitFor(() => {
            expect(screen.getByText("Help")).toBeInTheDocument();
        });

        // Click on the Help tab to see syntax examples
        const helpTab = screen.getByText("Help");
        fireEvent.click(helpTab);

        // Click on a syntax example
        const syntaxExample = screen.getByText(
            "food [certainty 9] earl gray tea, unsweetened"
        );
        fireEvent.click(syntaxExample);

        // Input should be updated with the example
        expect(input.value).toBe(
            "food [certainty 9] earl gray tea, unsweetened"
        );
    });

});
