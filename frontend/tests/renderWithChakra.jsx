import React from "react";
import { render } from "@testing-library/react";

/** @typedef {import("@testing-library/react").RenderResult} RenderResult */
import { ChakraProvider } from "@chakra-ui/react";

/**
 * Render a component with the same Chakra provider used by the app.
 * @param {React.ReactElement} ui
 * @returns {RenderResult}
 */
export function renderWithChakra(ui) {
    return render(<ChakraProvider>{ui}</ChakraProvider>);
}
