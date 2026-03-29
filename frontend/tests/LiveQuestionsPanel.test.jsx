/**
 * Tests for the LiveQuestionsPanel component.
 */

import React from "react";
import { render, screen, act, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";

import LiveQuestionsPanel from "../src/AudioDiary/LiveQuestionsPanel.jsx";

/** @typedef {import('../src/AudioDiary/useDiaryLiveQuestioningController.js').DisplayedQuestion} DisplayedQuestion */

/**
 * @param {React.ReactElement} ui
 */
function renderPanel(ui) {
    return render(<ChakraProvider value={defaultSystem}>{ui}</ChakraProvider>);
}

/**
 * @param {string} text
 * @param {string} [id]
 * @returns {DisplayedQuestion}
 */
function makeQuestion(text, id = undefined) {
    return {
        questionId: id ?? `q-${text}`,
        text,
        intent: "warm_reflective",
        isNew: false,
    };
}

const noopToggle = () => {};

describe("LiveQuestionsPanel", () => {
    it("renders nothing when there are no questions and no error", () => {
        const { container } = renderPanel(
            <LiveQuestionsPanel
                displayedQuestions={[]}
                pinnedQuestions={[]}
                pinnedQuestionIds={[]}
                onTogglePin={noopToggle}
                errorMessage={null}
            />
        );
        expect(container.firstChild).toBeNull();
    });

    it("renders the panel when there are questions", () => {
        renderPanel(
            <LiveQuestionsPanel
                displayedQuestions={[makeQuestion("First question")]}
                pinnedQuestions={[]}
                pinnedQuestionIds={[]}
                onTogglePin={noopToggle}
                errorMessage={null}
            />
        );
        expect(screen.getByTestId("live-questions-panel")).toBeInTheDocument();
    });

    it("renders the panel when there is only an error message", () => {
        renderPanel(
            <LiveQuestionsPanel
                displayedQuestions={[]}
                pinnedQuestions={[]}
                pinnedQuestionIds={[]}
                onTogglePin={noopToggle}
                errorMessage="Live prompts are catching up…"
            />
        );
        expect(screen.getByTestId("live-questions-panel")).toBeInTheDocument();
        expect(screen.getByTestId("live-questions-error")).toBeInTheDocument();
    });

    it("renders all question texts", () => {
        renderPanel(
            <LiveQuestionsPanel
                displayedQuestions={[
                    makeQuestion("Question A"),
                    makeQuestion("Question B"),
                ]}
                pinnedQuestions={[]}
                pinnedQuestionIds={[]}
                onTogglePin={noopToggle}
                errorMessage={null}
            />
        );
        expect(screen.getByText("Question A")).toBeInTheDocument();
        expect(screen.getByText("Question B")).toBeInTheDocument();
    });

    it("renders questions newest first (unpinned)", () => {
        renderPanel(
            <LiveQuestionsPanel
                displayedQuestions={[
                    makeQuestion("Newest Q", "q3"),
                    makeQuestion("Middle Q", "q2"),
                    makeQuestion("Oldest Q", "q1"),
                ]}
                pinnedQuestions={[]}
                pinnedQuestionIds={[]}
                onTogglePin={noopToggle}
                errorMessage={null}
            />
        );
        const items = screen.getAllByTestId(/question-item-/);
        expect(items[0].textContent).toContain("Newest Q");
        expect(items[1].textContent).toContain("Middle Q");
        expect(items[2].textContent).toContain("Oldest Q");
    });

    it("shows pinned questions before unpinned questions", () => {
        const pinned = makeQuestion("Pinned Q", "pinned-q");
        const unpinned = makeQuestion("Unpinned Q", "unpinned-q");
        renderPanel(
            <LiveQuestionsPanel
                displayedQuestions={[unpinned]}
                pinnedQuestions={[pinned]}
                pinnedQuestionIds={["pinned-q"]}
                onTogglePin={noopToggle}
                errorMessage={null}
            />
        );
        const items = screen.getAllByTestId(/question-item-/);
        expect(items[0].textContent).toContain("Pinned Q");
        expect(items[1].textContent).toContain("Unpinned Q");
    });

    it("calls onTogglePin with the question id when a question is clicked", () => {
        const onToggle = jest.fn();
        const q = makeQuestion("Clickable Q", "click-q");
        renderPanel(
            <LiveQuestionsPanel
                displayedQuestions={[q]}
                pinnedQuestions={[]}
                pinnedQuestionIds={[]}
                onTogglePin={onToggle}
                errorMessage={null}
            />
        );
        fireEvent.click(screen.getByTestId("question-item-click-q"));
        expect(onToggle).toHaveBeenCalledWith("click-q");
    });

    it("shows error message alongside existing questions", () => {
        renderPanel(
            <LiveQuestionsPanel
                displayedQuestions={[makeQuestion("Q1")]}
                pinnedQuestions={[]}
                pinnedQuestionIds={[]}
                onTogglePin={noopToggle}
                errorMessage="Catching up..."
            />
        );
        expect(screen.getByTestId("live-questions-error")).toHaveTextContent("Catching up...");
        expect(screen.getByText("Q1")).toBeInTheDocument();
    });

    it("adds fade-in animation when a new question arrives", async () => {
        const { rerender } = renderPanel(
            <LiveQuestionsPanel
                displayedQuestions={[makeQuestion("Old Q", "old-q")]}
                pinnedQuestions={[]}
                pinnedQuestionIds={[]}
                onTogglePin={noopToggle}
                errorMessage={null}
            />
        );

        // Add a newer question at the front.
        await act(async () => {
            rerender(
                <ChakraProvider value={defaultSystem}>
                    <LiveQuestionsPanel
                        displayedQuestions={[
                            { ...makeQuestion("New Q", "new-q"), isNew: true },
                            { ...makeQuestion("Old Q", "old-q"), isNew: false },
                        ]}
                        pinnedQuestions={[]}
                        pinnedQuestionIds={[]}
                        onTogglePin={noopToggle}
                        errorMessage={null}
                    />
                </ChakraProvider>
            );
        });

        // The newest question item should have an animation style applied.
        const newestItem = screen.getByTestId("question-item-new-q");
        const style = newestItem.getAttribute("style") ?? "";
        expect(style).toMatch(/animation/i);
    });

    it("renders question items as accessible toggle buttons", () => {
        const q = makeQuestion("Accessible Q", "acc-q");
        renderPanel(
            <LiveQuestionsPanel
                displayedQuestions={[q]}
                pinnedQuestions={[]}
                pinnedQuestionIds={[]}
                onTogglePin={noopToggle}
                errorMessage={null}
            />
        );
        const button = screen.getByRole("button", { name: "Pin question" });
        expect(button).toHaveAttribute("aria-pressed", "false");
    });

    it("supports keyboard toggling via Enter and Space", () => {
        const onToggle = jest.fn();
        const q = makeQuestion("Keyboard Q", "kbd-q");
        renderPanel(
            <LiveQuestionsPanel
                displayedQuestions={[q]}
                pinnedQuestions={[]}
                pinnedQuestionIds={[]}
                onTogglePin={onToggle}
                errorMessage={null}
            />
        );
        const button = screen.getByRole("button", { name: "Pin question" });
        fireEvent.keyDown(button, { key: "Enter" });
        fireEvent.keyDown(button, { key: " " });
        expect(onToggle).toHaveBeenCalledTimes(2);
        expect(onToggle).toHaveBeenNthCalledWith(1, "kbd-q");
        expect(onToggle).toHaveBeenNthCalledWith(2, "kbd-q");
    });
});
