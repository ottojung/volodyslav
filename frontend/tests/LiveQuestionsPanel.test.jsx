/**
 * Tests for the LiveQuestionsPanel component.
 */

import React from "react";
import { render, screen, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";

import LiveQuestionsPanel from "../src/AudioDiary/LiveQuestionsPanel.jsx";

/** @typedef {import('../src/AudioDiary/useDiaryLiveQuestioningController.js').QuestionGeneration} QuestionGeneration */

/**
 * @param {React.ReactElement} ui
 */
function renderPanel(ui) {
    return render(<ChakraProvider value={defaultSystem}>{ui}</ChakraProvider>);
}

/**
 * @param {number} n
 * @param {number} [milestone]
 * @returns {QuestionGeneration}
 */
function makeGeneration(n, milestone = 1) {
    return {
        generationId: `gen-${n}`,
        milestoneNumber: milestone,
        questions: [
            { text: `Question ${n}-1`, intent: "warm_reflective" },
            { text: `Question ${n}-2`, intent: "clarifying" },
        ],
    };
}

describe("LiveQuestionsPanel", () => {
    it("renders nothing when there are no generations and no error", () => {
        const { container } = renderPanel(
            <LiveQuestionsPanel displayedGenerations={[]} errorMessage={null} />
        );
        expect(container.firstChild).toBeNull();
    });

    it("renders the panel when there are generations", () => {
        renderPanel(
            <LiveQuestionsPanel
                displayedGenerations={[makeGeneration(1)]}
                errorMessage={null}
            />
        );
        expect(screen.getByTestId("live-questions-panel")).toBeInTheDocument();
    });

    it("renders the panel when there is only an error message", () => {
        renderPanel(
            <LiveQuestionsPanel
                displayedGenerations={[]}
                errorMessage="Live prompts are catching up…"
            />
        );
        expect(screen.getByTestId("live-questions-panel")).toBeInTheDocument();
        expect(screen.getByTestId("live-questions-error")).toBeInTheDocument();
    });

    it("renders all question texts from the generation", () => {
        renderPanel(
            <LiveQuestionsPanel
                displayedGenerations={[makeGeneration(1)]}
                errorMessage={null}
            />
        );
        expect(screen.getByText("Question 1-1")).toBeInTheDocument();
        expect(screen.getByText("Question 1-2")).toBeInTheDocument();
    });

    it("renders newest generation first", () => {
        renderPanel(
            <LiveQuestionsPanel
                displayedGenerations={[makeGeneration(3), makeGeneration(2), makeGeneration(1)]}
                errorMessage={null}
            />
        );
        const cards = screen.getAllByText(/Question \d-1/);
        expect(cards[0].textContent).toBe("Question 3-1");
        expect(cards[1].textContent).toBe("Question 2-1");
        expect(cards[2].textContent).toBe("Question 1-1");
    });

    it("renders all generations up to the visible limit", () => {
        const generations = [
            makeGeneration(4, 4),
            makeGeneration(3, 3),
            makeGeneration(2, 2),
            makeGeneration(1, 1),
        ];
        renderPanel(
            <LiveQuestionsPanel displayedGenerations={generations} errorMessage={null} />
        );
        expect(screen.getByTestId("question-generation-gen-4")).toBeInTheDocument();
        expect(screen.getByTestId("question-generation-gen-1")).toBeInTheDocument();
    });

    it("shows error message alongside existing generations", () => {
        renderPanel(
            <LiveQuestionsPanel
                displayedGenerations={[makeGeneration(1)]}
                errorMessage="Catching up..."
            />
        );
        expect(screen.getByTestId("live-questions-error")).toHaveTextContent("Catching up...");
        expect(screen.getByText("Question 1-1")).toBeInTheDocument();
    });

    it("adds fade-in animation class when a new generation arrives", async () => {
        const { rerender } = renderPanel(
            <LiveQuestionsPanel displayedGenerations={[makeGeneration(1)]} errorMessage={null} />
        );

        // Add a new generation
        await act(async () => {
            rerender(
                <ChakraProvider value={defaultSystem}>
                    <LiveQuestionsPanel
                        displayedGenerations={[makeGeneration(2), makeGeneration(1)]}
                        errorMessage={null}
                    />
                </ChakraProvider>
            );
        });

        // The newest generation card should have an animation style applied
        const newestCard = screen.getByTestId("question-generation-gen-2");
        const style = newestCard.getAttribute("style") ?? "";
        expect(style).toMatch(/animation/i);
    });
});
