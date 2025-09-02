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
    submitEntry,
} from "../src/DescriptionEntry/api";

// Import the mocked camera functions
import {
    checkCameraReturn,
    restoreDescription,
    retrievePhotos,
} from "../src/DescriptionEntry/cameraUtils";


it("ensures photos are submitted with correct field name to backend", async () => {
    // This is a regression test for the field name mismatch bug
    // Backend expects files under "files" field, not "photos"

    // Mock returning from camera
    checkCameraReturn.mockReturnValue({
        isReturn: true,
        requestIdentifier: "test-field-name-123",
    });

    restoreDescription.mockReturnValue("Test with photos");

    // Mock photos being retrieved
    const mockFile = new File(["test"], "photo_01.jpeg", {
        type: "image/jpeg",
    });
    retrievePhotos.mockReturnValue([mockFile]);

    render(<DescriptionEntry />);

    // Wait for camera return processing
    await waitFor(() => {
        expect(restoreDescription).toHaveBeenCalledWith("test-field-name-123");
    });

    // Submit entry
    const input = screen.getByPlaceholderText(
        "Type your event description here..."
    );
    fireEvent.keyUp(input, { key: "Enter", code: "Enter" });

    // Verify API is called with correct parameters
    await waitFor(() => {
        expect(submitEntry).toHaveBeenCalledWith(
            "Test with photos",
            "test-field-name-123",
            [mockFile]
        );
    });
});
