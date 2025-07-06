import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

jest.mock("../src/DescriptionEntry/api", () => ({
    fetchRecentEntries: jest.fn(),
    submitEntry: jest.fn(),
    fetchConfig: jest.fn(),
    deleteEntry: jest.fn(),
}));

jest.mock("../src/DescriptionEntry/logger", () => ({
    logger: {
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
    },
}));

jest.mock("../src/DescriptionEntry/cameraUtils", () => ({
    generateRequestIdentifier: jest.fn(),
    navigateToCamera: jest.fn(),
    checkCameraReturn: jest.fn(),
    cleanupUrlParams: jest.fn(),
    restoreDescription: jest.fn(),
    retrievePhotos: jest.fn(),
}));

import DescriptionEntry from "../src/DescriptionEntry/DescriptionEntry.jsx";
import {
    fetchRecentEntries,
    submitEntry,
    fetchConfig,
    deleteEntry,
} from "../src/DescriptionEntry/api";
import {
    generateRequestIdentifier,
    navigateToCamera,
    checkCameraReturn,
    cleanupUrlParams,
    restoreDescription,
    retrievePhotos,
} from "../src/DescriptionEntry/cameraUtils";


describe("DescriptionEntry deletion", () => {
    const defaultMockConfig = {
        help: "help text",
        shortcuts: [],
    };

    beforeEach(() => {
        fetchRecentEntries.mockClear();
        submitEntry.mockClear();
        fetchConfig.mockClear();
        deleteEntry.mockClear();

        generateRequestIdentifier.mockReset();
        navigateToCamera.mockReset();
        checkCameraReturn.mockReset();
        cleanupUrlParams.mockReset();
        restoreDescription.mockReset();
        retrievePhotos.mockReset();

        fetchRecentEntries.mockResolvedValue([]);
        submitEntry.mockResolvedValue({ success: true, entry: { input: "t" } });
        fetchConfig.mockResolvedValue(defaultMockConfig);
        deleteEntry.mockResolvedValue(true);
        generateRequestIdentifier.mockReturnValue("req");
        checkCameraReturn.mockReturnValue({ isReturn: false, requestIdentifier: null });
        restoreDescription.mockReturnValue(null);
        retrievePhotos.mockReturnValue([]);

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

    it("deletes an entry when delete button is clicked", async () => {
        const mockEntries = [
            { id: "1", original: "test entry", date: "2023-01-01", description: "desc", type: "note" },
        ];
        fetchRecentEntries.mockResolvedValueOnce(mockEntries);

        render(<DescriptionEntry />);

        await waitFor(() => {
            expect(fetchRecentEntries).toHaveBeenCalled();
        });

        fireEvent.click(screen.getByText("Recent Entries"));

        await waitFor(() => {
            expect(screen.getByLabelText("Delete entry")).toBeInTheDocument();
        });

        fireEvent.click(screen.getByLabelText("Delete entry"));

        await waitFor(() => {
            expect(deleteEntry).toHaveBeenCalledWith("1");
            expect(fetchRecentEntries).toHaveBeenCalledTimes(2);
        });
    });
});
