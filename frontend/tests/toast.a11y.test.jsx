import React from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { useToast } from "../src/toast.jsx";
import { renderWithProviders } from "./renderWithProviders.jsx";

/** @returns {React.JSX.Element} */
function ToastTrigger() {
    const toast = useToast();

    return (
        <button
            type="button"
            onClick={() => {
                toast({
                    title: "Saved",
                    description: "Entry saved successfully",
                    status: "success",
                    duration: null,
                });
                toast({
                    title: "Save failed",
                    description: "Could not persist entry",
                    status: "error",
                    duration: null,
                });
            }}
        >
            Trigger toasts
        </button>
    );
}

describe("ToastProvider accessibility", () => {
    it("announces toasts using aria-live semantics", async () => {
        renderWithProviders(<ToastTrigger />);

        fireEvent.click(screen.getByRole("button", { name: "Trigger toasts" }));

        await waitFor(() => {
            expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
            expect(screen.getByRole("alert")).toHaveAttribute("aria-live", "assertive");
        });

        expect(screen.getByText("Saved")).toBeInTheDocument();
        expect(screen.getByText("Save failed")).toBeInTheDocument();
    });
});
