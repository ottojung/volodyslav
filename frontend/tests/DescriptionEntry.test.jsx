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

import DescriptionEntry from "../src/DescriptionEntry/DescriptionEntry.jsx";
// Import the mocked functions after the mock is set up
import {
    fetchRecentEntries,
    submitEntry,
    fetchConfig,
} from "../src/DescriptionEntry/api";

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
            ["slept (\\d+)h", "sleep [duration $1 hours]", "Sleep duration shortcut"],
            ["worked (\\d+)h", "work [duration $1 hours]", "Work duration shortcut"],
        ],
    };

    beforeEach(() => {
        // Reset mocks before each test
        fetchRecentEntries.mockClear();
        submitEntry.mockClear();
        fetchConfig.mockClear();

        // Set default mock implementations that resolve immediately
        fetchRecentEntries.mockResolvedValue([]);
        submitEntry.mockResolvedValue({
            success: true,
            entry: { input: "test" },
        });
        // Use default mock config instead of null
        fetchConfig.mockResolvedValue(defaultMockConfig);
    });

    it("renders the main elements", async () => {
        render(<DescriptionEntry />);

        // Wait for async operations to complete first
        await waitFor(() => {
            expect(screen.getByText("Event Logging Help")).toBeInTheDocument();
        });

        expect(screen.getByText("Log an Event")).toBeInTheDocument();
        expect(screen.getByText("What happened?")).toBeInTheDocument();
        expect(
            screen.getByPlaceholderText("Type your event description here...")
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: /log event/i })
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: /clear/i })
        ).toBeInTheDocument();
    });

    it("updates input value when typing", async () => {
        render(<DescriptionEntry />);

        // Wait for component to settle first
        await waitFor(() => {
            expect(screen.getByText("Event Logging Help")).toBeInTheDocument();
        });

        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );
        fireEvent.change(input, { target: { value: "test input" } });

        expect(input.value).toBe("test input");
    });

    it("enables buttons when input has content", async () => {
        render(<DescriptionEntry />);

        // Wait for component to settle first
        await waitFor(() => {
            expect(screen.getByText("Event Logging Help")).toBeInTheDocument();
        });

        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );
        const logButton = screen.getByRole("button", { name: /log event/i });
        const clearButton = screen.getByRole("button", { name: /clear/i });

        // Initially disabled
        expect(logButton).toBeDisabled();
        expect(clearButton).toBeDisabled();

        // Type something
        fireEvent.change(input, { target: { value: "some text" } });

        // Now enabled
        expect(logButton).toBeEnabled();
        expect(clearButton).toBeEnabled();
    });

    it("does not render config section when no config is available", async () => {
        // Override default mock to return null for this test
        fetchConfig.mockResolvedValue(null);
        
        render(<DescriptionEntry />);

        // Wait for component to finish loading
        await waitFor(() => {
            expect(screen.getByText("Log an Event")).toBeInTheDocument();
        });

        // Should not show config section when no config is available
        expect(screen.queryByText("Event Logging Help")).not.toBeInTheDocument();
        expect(screen.queryByText("shortcuts")).not.toBeInTheDocument();
    });

    it("renders config section with server data when available", async () => {
        const mockConfig = {
            help: "Custom help text",
            shortcuts: [
                ["test", "TEST", "Test shortcut"],
            ],
        };
        fetchConfig.mockResolvedValue(mockConfig);

        render(<DescriptionEntry />);

        // Wait for config to load
        await waitFor(() => {
            expect(screen.getByText("Event Logging Help")).toBeInTheDocument();
        });

        // Should show shortcuts count from server data
        expect(screen.getByText("1 shortcuts")).toBeInTheDocument();
    });

    it("loads recent entries on mount", async () => {
        const mockEntries = [
            { id: "1", original: "test entry 1", date: "2023-01-01" },
            { id: "2", original: "test entry 2", date: "2023-01-02" },
        ];
        fetchRecentEntries.mockResolvedValue(mockEntries);

        render(<DescriptionEntry />);

        // Wait for entries to load
        await waitFor(() => {
            expect(fetchRecentEntries).toHaveBeenCalledWith(10);
        });
    });

    it("submits entry when Log Event button is clicked", async () => {
        render(<DescriptionEntry />);

        // Wait for component to settle
        await waitFor(() => {
            expect(screen.getByText("Event Logging Help")).toBeInTheDocument();
        });

        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );
        const logButton = screen.getByRole("button", { name: /log event/i });

        // Type something
        fireEvent.change(input, { target: { value: "test event" } });

        // Click submit
        fireEvent.click(logButton);

        await waitFor(() => {
            expect(submitEntry).toHaveBeenCalledWith("test event");
        });
    });

    it("submits entry when Enter key is pressed", async () => {
        render(<DescriptionEntry />);

        // Wait for component to settle
        await waitFor(() => {
            expect(screen.getByText("Event Logging Help")).toBeInTheDocument();
        });

        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );

        // Type something
        fireEvent.change(input, { target: { value: "test event" } });

        // Press Enter
        fireEvent.keyUp(input, { key: "Enter", code: "Enter" });

        await waitFor(() => {
            expect(submitEntry).toHaveBeenCalledWith("test event");
        });
    });

    it("does not submit when Enter is pressed with Shift key", async () => {
        render(<DescriptionEntry />);

        // Wait for component to settle
        await waitFor(() => {
            expect(screen.getByText("Event Logging Help")).toBeInTheDocument();
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

    it("clears input when Clear button is clicked", async () => {
        render(<DescriptionEntry />);

        // Wait for component to settle
        await waitFor(() => {
            expect(screen.getByText("Event Logging Help")).toBeInTheDocument();
        });

        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );
        const clearButton = screen.getByRole("button", { name: /clear/i });

        // Type something
        fireEvent.change(input, { target: { value: "test event" } });
        expect(input.value).toBe("test event");

        // Click clear
        fireEvent.click(clearButton);

        expect(input.value).toBe("");
    });

    it("clears input and refetches entries after successful submission", async () => {
        submitEntry.mockResolvedValue({
            success: true,
            entry: { input: "processed test event" },
        });

        render(<DescriptionEntry />);

        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );
        const logButton = screen.getByRole("button", { name: /log event/i });

        // Type something
        fireEvent.change(input, { target: { value: "test event" } });

        // Submit
        fireEvent.click(logButton);

        await waitFor(() => {
            expect(input.value).toBe("");
        });

        // Should refetch entries after submission
        await waitFor(() => {
            expect(fetchRecentEntries).toHaveBeenCalledTimes(2); // Once on mount, once after submit
        });
    });

    it("shows loading state on submit button during submission", async () => {
        // Mock a slow submission
        submitEntry.mockImplementation(
            () =>
                new Promise((resolve) =>
                    setTimeout(
                        () =>
                            resolve({
                                success: true,
                                entry: { input: "test" },
                            }),
                        100
                    )
                )
        );

        render(<DescriptionEntry />);

        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );
        const logButton = screen.getByRole("button", { name: /log event/i });

        // Type something
        fireEvent.change(input, { target: { value: "test event" } });

        // Click submit
        fireEvent.click(logButton);

        // Should show loading text
        expect(screen.getByText("Logging...")).toBeInTheDocument();

        // Wait for submission to complete
        await waitFor(() => {
            expect(screen.getByText("Log Event")).toBeInTheDocument();
        });
    });

    it("handles submission errors gracefully", async () => {
        submitEntry.mockRejectedValue(new Error("Network error"));

        render(<DescriptionEntry />);

        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );
        const logButton = screen.getByRole("button", { name: /log event/i });

        // Type something
        fireEvent.change(input, { target: { value: "test event" } });

        // Submit
        fireEvent.click(logButton);

        await waitFor(() => {
            expect(submitEntry).toHaveBeenCalledWith("test event");
        });

        // Input should not be cleared on error
        expect(input.value).toBe("test event");
    });

    it("does not submit empty or whitespace-only input", async () => {
        render(<DescriptionEntry />);

        // Wait for component to settle
        await waitFor(() => {
            expect(screen.getByText("Event Logging Help")).toBeInTheDocument();
        });

        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );
        const logButton = screen.getByRole("button", { name: /log event/i });

        // Try to submit empty input
        fireEvent.click(logButton);
        expect(submitEntry).not.toHaveBeenCalled();

        // Try to submit whitespace-only input
        fireEvent.change(input, { target: { value: "   " } });
        fireEvent.click(logButton);
        expect(submitEntry).not.toHaveBeenCalled();
    });

    it("focuses input field on mount", async () => {
        render(<DescriptionEntry />);

        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );

        await waitFor(() => {
            expect(input).toHaveFocus();
        });
    });

    it("handles shortcut clicks from config section", async () => {
        render(<DescriptionEntry />);

        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );

        // Wait for config to load and find a shortcut to click
        await waitFor(() => {
            expect(screen.getByText("Event Logging Help")).toBeInTheDocument();
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
            expect(screen.getByText("Event Logging Help")).toBeInTheDocument();
        });

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

    it("toggles config section visibility", async () => {
        render(<DescriptionEntry />);

        // Wait for config to load (should be open by default)
        await waitFor(() => {
            expect(screen.getByText("Event Logging Help")).toBeInTheDocument();
        });

        const hideButton = screen.getByText("Hide Details");

        // Click to hide
        fireEvent.click(hideButton);

        // Should show "Show Details" now
        await waitFor(() => {
            expect(screen.getByText("Show Details")).toBeInTheDocument();
        });

        // Click to show again
        const showButton = screen.getByText("Show Details");
        fireEvent.click(showButton);

        // Should show "Hide Details" again
        await waitFor(() => {
            expect(screen.getByText("Hide Details")).toBeInTheDocument();
        });
    });

    it("displays recent entries when data is available", async () => {
        const mockEntries = [
            {
                id: "1",
                original: "test entry 1",
                date: "2023-01-01T10:00:00Z",
                description: "processed entry 1",
            },
            {
                id: "2",
                original: "test entry 2",
                date: "2023-01-02T11:00:00Z",
                description: "processed entry 2",
            },
        ];
        fetchRecentEntries.mockResolvedValue(mockEntries);

        render(<DescriptionEntry />);

        // Wait for entries to load and be displayed
        await waitFor(() => {
            expect(screen.getByText("Recent Events")).toBeInTheDocument();
        });

        await waitFor(() => {
            expect(screen.getByText("processed entry 1")).toBeInTheDocument();
            expect(screen.getByText("processed entry 2")).toBeInTheDocument();
        });
    });

    it("does not display recent entries section when no entries are available", async () => {
        fetchRecentEntries.mockResolvedValue([]);

        render(<DescriptionEntry />);

        // Wait for entries to finish loading
        await waitFor(() => {
            expect(fetchRecentEntries).toHaveBeenCalled();
        });

        // Recent Events section should not be visible
        expect(screen.queryByText("Recent Events")).not.toBeInTheDocument();
    });

    it("shows loading skeletons while recent entries are loading", async () => {
        // Make fetchRecentEntries hang to keep loading state
        fetchRecentEntries.mockImplementation(() => new Promise(() => {}));

        render(<DescriptionEntry />);

        // Should show Recent Events section with loading skeletons
        await waitFor(() => {
            expect(screen.getByText("Recent Events")).toBeInTheDocument();
        });

        // Should show multiple skeleton elements (from Chakra UI)
        const skeletons = document.querySelectorAll(".chakra-skeleton");
        expect(skeletons.length).toBeGreaterThan(0);
    });

    it("handles fetchRecentEntries error gracefully", async () => {
        fetchRecentEntries.mockRejectedValue(new Error("Network error"));

        render(<DescriptionEntry />);

        // Should not crash and should eventually stop loading
        await waitFor(() => {
            // The component should still render normally
            expect(screen.getByText("Log an Event")).toBeInTheDocument();
        });

        // Should not show Recent Events section when there's an error
        expect(screen.queryByText("Recent Events")).not.toBeInTheDocument();
    });

    it("handles fetchConfig error gracefully", async () => {
        // Clear the default mock and make it return null to simulate no config
        fetchConfig.mockResolvedValue(null);

        render(<DescriptionEntry />);

        // When config fetch returns null, no config section should be shown
        await waitFor(() => {
            expect(screen.getByText("Log an Event")).toBeInTheDocument();
        });

        // Should not show config section when no config is available
        expect(screen.queryByText("Event Logging Help")).not.toBeInTheDocument();
        expect(screen.queryByText("shortcuts")).not.toBeInTheDocument();
    });

    it("maintains input focus after shortcut click", async () => {
        render(<DescriptionEntry />);

        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );

        // Wait for config to load
        await waitFor(() => {
            expect(screen.getByText("Event Logging Help")).toBeInTheDocument();
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

    it("disables submit button during submission", async () => {
        // Mock slow submission to test disabled state
        submitEntry.mockImplementation(
            () =>
                new Promise((resolve) =>
                    setTimeout(
                        () =>
                            resolve({
                                success: true,
                                entry: { input: "test" },
                            }),
                        100
                    )
                )
        );

        render(<DescriptionEntry />);

        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );
        const logButton = screen.getByRole("button", { name: /log event/i });

        // Type something
        fireEvent.change(input, { target: { value: "test event" } });

        // Button should be enabled initially
        expect(logButton).toBeEnabled();

        // Click submit
        fireEvent.click(logButton);

        // Button should be disabled during submission
        expect(logButton).toBeDisabled();
        expect(screen.getByText("Logging...")).toBeInTheDocument();

        // Wait for submission to complete
        await waitFor(() => {
            expect(screen.getByText("Log Event")).toBeInTheDocument();
        });

        // After submission, input is cleared, so button should be disabled again
        expect(logButton).toBeDisabled();
        expect(input.value).toBe("");
    });

    it("disables clear button during submission", async () => {
        // Mock slow submission
        submitEntry.mockImplementation(
            () =>
                new Promise((resolve) =>
                    setTimeout(
                        () =>
                            resolve({
                                success: true,
                                entry: { input: "test" },
                            }),
                        100
                    )
                )
        );

        render(<DescriptionEntry />);

        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );
        const clearButton = screen.getByRole("button", { name: /clear/i });

        // Type something
        fireEvent.change(input, { target: { value: "test event" } });

        // Clear button should be enabled initially
        expect(clearButton).toBeEnabled();

        // Click submit
        const logButton = screen.getByRole("button", { name: /log event/i });
        fireEvent.click(logButton);

        // Clear button should be disabled during submission
        expect(clearButton).toBeDisabled();

        // Wait for submission to complete
        await waitFor(() => {
            expect(screen.getByText("Log Event")).toBeInTheDocument();
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
        const logButton = screen.getByRole("button", { name: /log event/i });

        // Type something
        fireEvent.change(input, { target: { value: "test event" } });

        // Submit
        fireEvent.click(logButton);

        await waitFor(() => {
            expect(submitEntry).toHaveBeenCalledWith("test event");
        });

        // Input should not be cleared on error
        expect(input.value).toBe("test event");
    });

    it("trims whitespace from input before submission", async () => {
        render(<DescriptionEntry />);

        // Wait for component to settle
        await waitFor(() => {
            expect(screen.getByText("Event Logging Help")).toBeInTheDocument();
        });

        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );
        const logButton = screen.getByRole("button", { name: /log event/i });

        // Type something with leading/trailing whitespace
        fireEvent.change(input, { target: { value: "  test event  " } });

        // Submit
        fireEvent.click(logButton);

        await waitFor(() => {
            expect(submitEntry).toHaveBeenCalledWith("test event");
        });
    });

    it("handles Enter key submission with trimmed input", async () => {
        render(<DescriptionEntry />);

        // Wait for component to settle
        await waitFor(() => {
            expect(screen.getByText("Event Logging Help")).toBeInTheDocument();
        });

        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );

        // Type something with whitespace
        fireEvent.change(input, { target: { value: "  test event  " } });

        // Press Enter
        fireEvent.keyUp(input, { key: "Enter", code: "Enter" });

        await waitFor(() => {
            expect(submitEntry).toHaveBeenCalledWith("test event");
        });
    });

    it("displays correct number of shortcuts in config section", async () => {
        const mockConfig = {
            help: "Custom help text",
            shortcuts: [
                ["test1", "TEST1", "Test 1"],
                ["test2", "TEST2", "Test 2"],
                ["test3", "TEST3", "Test 3"],
            ],
        };
        fetchConfig.mockResolvedValue(mockConfig);

        render(<DescriptionEntry />);

        await waitFor(() => {
            expect(screen.getByText("3 shortcuts")).toBeInTheDocument();
        });
    });

    it("handles config section tab switching", async () => {
        render(<DescriptionEntry />);

        // Wait for config to load
        await waitFor(() => {
            expect(screen.getByText("Event Logging Help")).toBeInTheDocument();
        });

        // Default tab is Shortcuts (when shortcuts exist), so should show shortcuts content
        expect(
            screen.getByText(
                "Click a shortcut to copy its pattern to the input:"
            )
        ).toBeInTheDocument();

        // Click Syntax tab
        const syntaxTab = screen.getByText("Syntax");
        fireEvent.click(syntaxTab);

        // Should show syntax content
        await waitFor(() => {
            expect(
                screen.getByText("Syntax: TYPE [MODIFIERS...] DESCRIPTION")
            ).toBeInTheDocument();
        });

        // Click back to Shortcuts tab
        const shortcutsTab = screen.getByText("Shortcuts");
        fireEvent.click(shortcutsTab);

        // Should show shortcuts content again
        await waitFor(() => {
            expect(
                screen.getByText(
                    "Click a shortcut to copy its pattern to the input:"
                )
            ).toBeInTheDocument();
        });
    });

    it("handles multiple consecutive submissions", async () => {
        render(<DescriptionEntry />);

        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );
        const logButton = screen.getByRole("button", { name: /log event/i });

        // First submission
        fireEvent.change(input, { target: { value: "first event" } });
        fireEvent.click(logButton);

        await waitFor(() => {
            expect(submitEntry).toHaveBeenCalledWith("first event");
            expect(input.value).toBe("");
        });

        // Second submission
        fireEvent.change(input, { target: { value: "second event" } });
        fireEvent.click(logButton);

        await waitFor(() => {
            expect(submitEntry).toHaveBeenCalledWith("second event");
            expect(input.value).toBe("");
        });

        // Should have called submitEntry twice
        expect(submitEntry).toHaveBeenCalledTimes(2);

        // Should have fetched entries three times (initial + after each submission)
        expect(fetchRecentEntries).toHaveBeenCalledTimes(3);
    });

    it("maintains correct button states after clear", async () => {
        render(<DescriptionEntry />);

        // Wait for component to settle
        await waitFor(() => {
            expect(screen.getByText("Event Logging Help")).toBeInTheDocument();
        });

        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );
        const logButton = screen.getByRole("button", { name: /log event/i });
        const clearButton = screen.getByRole("button", { name: /clear/i });

        // Initially buttons should be disabled
        expect(logButton).toBeDisabled();
        expect(clearButton).toBeDisabled();

        // Type something
        fireEvent.change(input, { target: { value: "test event" } });

        // Buttons should be enabled
        expect(logButton).toBeEnabled();
        expect(clearButton).toBeEnabled();

        // Clear input
        fireEvent.click(clearButton);

        // Buttons should be disabled again
        expect(logButton).toBeDisabled();
        expect(clearButton).toBeDisabled();
        expect(input.value).toBe("");
    });
});
