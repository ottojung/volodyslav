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

describe("Camera Integration", () => {
    beforeEach(() => {
        submitEntry.mockClear();
        generateRequestIdentifier.mockReset();
        navigateToCamera.mockReset();
        checkCameraReturn.mockReset();
        cleanupUrlParams.mockReset();
        restoreDescription.mockReset();
        retrievePhotos.mockReset();
    });
    it("navigates to camera when take photos button is clicked", async () => {
        // Reset and set up mocks for camera navigation
        generateRequestIdentifier.mockReset();
        navigateToCamera.mockReset();
        checkCameraReturn.mockReset();

        // Set specific mock values for this test
        generateRequestIdentifier.mockReturnValue("test-req-id-123");
        checkCameraReturn.mockReturnValue({ isReturn: false });

        render(<DescriptionEntry />);

        // Wait for the component to settle
        await waitFor(() => {
            expect(
                screen.getByPlaceholderText(
                    "Type your event description here..."
                )
            ).toBeInTheDocument();
        });

        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );
        const takePhotosButton = screen.getByRole("button", {
            name: /take photos/i,
        });

        // Type a description
        const description = "Beautiful sunset at the beach";
        fireEvent.change(input, { target: { value: description } });

        // Click take photos button
        fireEvent.click(takePhotosButton);

        // Should generate request identifier and navigate to camera
        expect(generateRequestIdentifier).toHaveBeenCalled();
        expect(navigateToCamera).toHaveBeenCalledWith(
            "test-req-id-123",
            description
        );

        // Should not call submitEntry since we're going to camera
        expect(submitEntry).not.toHaveBeenCalled();
    });

    it("restores description when returning from camera", async () => {
        // Mock returning from camera
        checkCameraReturn.mockReturnValue({
            isReturn: true,
            requestIdentifier: "test-req-id-123",
        });
        restoreDescription.mockReturnValue(
            "Take a photo [phone_take_photo] of the sunset"
        );

        render(<DescriptionEntry />);

        await waitFor(() => {
            expect(checkCameraReturn).toHaveBeenCalled();
            expect(restoreDescription).toHaveBeenCalledWith("test-req-id-123");
            expect(cleanupUrlParams).toHaveBeenCalled();
        });

        // The description should be restored
        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );
        expect(input.value).toBe(
            "Take a photo [phone_take_photo] of the sunset"
        );

        // Should show photos attached indicator
        expect(screen.getByText(/Photos attached/)).toBeInTheDocument();
    });

    it("submits entry with photos when returning from camera", async () => {
        // Reset and set up mocks for returning from camera
        checkCameraReturn.mockReset();
        restoreDescription.mockReset();
        submitEntry.mockReset();
        retrievePhotos.mockReset();

        // Mock returning from camera
        checkCameraReturn.mockReturnValue({
            isReturn: true,
            requestIdentifier: "test-req-id-123",
        });
        restoreDescription.mockReturnValue(
            "Take a photo [phone_take_photo] of the sunset"
        );

        // Mock some photos being retrieved
        const mockFile1 = new File(["fake content 1"], "photo_01.jpeg", {
            type: "image/jpeg",
        });
        const mockFile2 = new File(["fake content 2"], "photo_02.jpeg", {
            type: "image/jpeg",
        });
        retrievePhotos.mockReturnValue([mockFile1, mockFile2]);

        submitEntry.mockResolvedValue({
            success: true,
            entry: { input: "Take a photo [phone_take_photo] of the sunset" },
        });

        render(<DescriptionEntry />);

        // Wait for the component to process the camera return
        await waitFor(() => {
            expect(restoreDescription).toHaveBeenCalledWith("test-req-id-123");
        });

        // Verify description is restored
        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );
        expect(input.value).toBe(
            "Take a photo [phone_take_photo] of the sunset"
        );


        // Submit using Enter key to include photos
        fireEvent.keyUp(input, { key: "Enter", code: "Enter" });

        await waitFor(() => {
            // Should submit with request identifier for photos
            expect(submitEntry).toHaveBeenCalledWith(
                "Take a photo [phone_take_photo] of the sunset",
                "test-req-id-123",
                [mockFile1, mockFile2]
            );
        });
    });

    it("does not navigate to camera for regular descriptions", async () => {
        // Start fresh - explicitly reset all camera mocks for this test
        generateRequestIdentifier.mockReset();
        navigateToCamera.mockReset();
        checkCameraReturn.mockReset();

        // Set specific mock values for this test
        checkCameraReturn.mockReturnValue({ isReturn: false }); // Ensure no camera return state

        render(<DescriptionEntry />);

        // Wait for the component to settle
        await waitFor(() => {
            expect(
                screen.getByPlaceholderText(
                    "Type your event description here..."
                )
            ).toBeInTheDocument();
        });

        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );
        // Type a regular description without camera trigger
        const regularDescription = "Just had a great lunch";
        fireEvent.change(input, { target: { value: regularDescription } });

        // Submit using Enter key
        fireEvent.keyUp(input, { key: "Enter", code: "Enter" });

        await waitFor(() => {
            // Should submit normally without camera and without request identifier
            expect(submitEntry).toHaveBeenCalledWith(
                regularDescription,
                undefined,
                []
            );
        });

        // Should not navigate to camera
        expect(navigateToCamera).not.toHaveBeenCalled();
    });

    it("preserves description text exactly as typed", async () => {
        // Mock returning from camera
        checkCameraReturn.mockReturnValue({
            isReturn: true,
            requestIdentifier: "test-req-id-123",
        });
        const originalDescription =
            "Meeting [phone_take_photo] with client about new project";
        restoreDescription.mockReturnValue(originalDescription);

        // Mock some photos being retrieved
        const mockFile = new File(["fake content"], "photo_01.jpeg", {
            type: "image/jpeg",
        });
        retrievePhotos.mockReturnValue([mockFile]);

        render(<DescriptionEntry />);

        await waitFor(() => {
            expect(restoreDescription).toHaveBeenCalledWith("test-req-id-123");
        });

        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );

        // The description should be preserved exactly as typed
        expect(input.value).toBe(originalDescription);

        fireEvent.keyUp(input, { key: "Enter", code: "Enter" });

        await waitFor(() => {
            // Should submit with the exact original description and the photos
            expect(submitEntry).toHaveBeenCalledWith(
                originalDescription,
                "test-req-id-123",
                [mockFile]
            );
        });
    });

    it("take photos button works independently of description content", async () => {
        // Reset and set up mocks specifically for this test
        generateRequestIdentifier.mockReset();
        navigateToCamera.mockReset();
        submitEntry.mockReset();
        checkCameraReturn.mockReset();
        generateRequestIdentifier.mockReturnValue("test-req-id-123");
        checkCameraReturn.mockReturnValue({
            isReturn: false,
            requestIdentifier: null,
        });

        render(<DescriptionEntry />);

        // Wait for the component to settle
        await waitFor(() => {
            expect(
                screen.getByPlaceholderText(
                    "Type your event description here..."
                )
            ).toBeInTheDocument();
        });

        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );
        const takePhotosButton = screen.getByRole("button", {
            name: /take photos/i,
        });

        // Type a regular description (no camera trigger pattern)
        const description = "Regular meeting notes";
        fireEvent.change(input, { target: { value: description } });

        // The take photos button should still work
        expect(takePhotosButton).toBeEnabled();

        // Click take photos button
        fireEvent.click(takePhotosButton);

        // Should navigate to camera with the description stored
        expect(generateRequestIdentifier).toHaveBeenCalled();
        expect(navigateToCamera).toHaveBeenCalledWith(
            "test-req-id-123",
            description
        );

        // Should not submit the entry yet
        expect(submitEntry).not.toHaveBeenCalled();
    });
});
