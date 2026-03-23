import React from "react";
import { render } from "@testing-library/react";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { ToastProvider } from "../src/toast.jsx";

/** @typedef {import("@testing-library/react").RenderResult} RenderResult */

/**
 * Render UI with Chakra and toast providers.
 * @param {React.ReactElement} ui
 * @returns {RenderResult}
 */
export function renderWithProviders(ui) {
    return render(
        <ChakraProvider value={defaultSystem}>
            <ToastProvider>{ui}</ToastProvider>
        </ChakraProvider>
    );
}
