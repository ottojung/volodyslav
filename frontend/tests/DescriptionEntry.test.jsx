import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

// Mock the API module
jest.mock("../src/DescriptionEntry/api", () => ({
    fetchRecentEntries: jest.fn(() => Promise.resolve([])),
    submitEntry: jest.fn(() =>
        Promise.resolve({ success: true, entry: { input: "test" } })
    ),
    fetchConfig: jest.fn(() => Promise.resolve(null)),
}));

import DescriptionEntry from "../src/DescriptionEntry/DescriptionEntry.jsx";

describe("DescriptionEntry", () => {
    it("renders the main elements", async () => {
        render(<DescriptionEntry />);

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

        // Wait for async operations to complete
        await waitFor(() => {
            expect(true).toBe(true); // Just wait for component to settle
        });
    });

    it("updates input value when typing", async () => {
        render(<DescriptionEntry />);

        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );
        fireEvent.change(input, { target: { value: "test input" } });

        expect(input.value).toBe("test input");

        // Wait for async operations to complete
        await waitFor(() => {
            expect(true).toBe(true);
        });
    });

    it("enables buttons when input has content", async () => {
        render(<DescriptionEntry />);

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

        // Wait for async operations to complete
        await waitFor(() => {
            expect(true).toBe(true);
        });
    });
});
