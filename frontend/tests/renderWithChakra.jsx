import React from "react";
import { renderWithProviders } from "./renderWithProviders.jsx";

/** @typedef {import("@testing-library/react").RenderResult} RenderResult */

/**
 * Render a component with the same Chakra provider used by the app.
 * @param {React.ReactElement} ui
 * @returns {RenderResult}
 */
export function renderWithChakra(ui) {
    return renderWithProviders(ui);
}
