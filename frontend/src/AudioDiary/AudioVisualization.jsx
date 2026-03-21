import React, { useRef, useEffect } from "react";
import { Box } from "@chakra-ui/react";

/**
 * @typedef {object} AudioVisualizationProps
 * @property {AnalyserNode | null} analyser - Web Audio AnalyserNode to read levels from.
 * @property {boolean} isActive - Whether the recorder is currently recording.
 */

/** Number of frequency bars to display. */
const BAR_COUNT = 32;

/**
 * Frequency-spectrum bar visualizer that reads from a Web Audio AnalyserNode.
 *
 * Renders a row of animated vertical bars whose heights reflect the live
 * audio frequency content captured by the microphone.
 *
 * @param {AudioVisualizationProps} props
 * @returns {import("react").JSX.Element}
 */
export default function AudioVisualization({ analyser, isActive }) {
    /** @type {import("react").RefObject<HTMLCanvasElement | null>} */
    const canvasRef = useRef(null);
    /** @type {import("react").MutableRefObject<number | null>} */
    const rafRef = useRef(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) {
            return undefined;
        }

        const ctx = canvas.getContext("2d");
        if (!ctx) {
            return undefined;
        }

        if (!analyser || !isActive) {
            // Draw idle placeholder bars at a low uniform height
            const w = canvas.width;
            const h = canvas.height;
            ctx.clearRect(0, 0, w, h);
            ctx.fillStyle = "#1A202C";
            ctx.fillRect(0, 0, w, h);
            const gap = 2;
            const barWidth = Math.floor((w - gap * (BAR_COUNT - 1)) / BAR_COUNT);
            for (let i = 0; i < BAR_COUNT; i++) {
                const x = i * (barWidth + gap);
                const barH = 3;
                ctx.fillStyle = "#4A5568";
                ctx.beginPath();
                ctx.roundRect(x, h - barH, barWidth, barH, 1);
                ctx.fill();
            }
            return undefined;
        }

        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        /**
         * Draw one animation frame.
         */
        const draw = () => {
            rafRef.current = requestAnimationFrame(draw);

            analyser.getByteFrequencyData(dataArray);

            const w = canvas.width;
            const h = canvas.height;
            const gap = 2;
            const barWidth = Math.floor((w - gap * (BAR_COUNT - 1)) / BAR_COUNT);

            ctx.clearRect(0, 0, w, h);
            ctx.fillStyle = "#1A202C";
            ctx.fillRect(0, 0, w, h);

            for (let i = 0; i < BAR_COUNT; i++) {
                // Sample the frequency array distributed across the buffer
                const index = Math.floor((i / BAR_COUNT) * bufferLength);
                const value = dataArray[index] ?? 0;
                const barH = Math.max(3, Math.round((value / 255) * h));
                const x = i * (barWidth + gap);
                const y = h - barH;

                // Color gradient: green → yellow → red based on bar height
                const ratio = value / 255;
                const hue = Math.round(120 - ratio * 120);
                ctx.fillStyle = `hsl(${hue}, 80%, 55%)`;
                ctx.beginPath();
                ctx.roundRect(x, y, barWidth, barH, 1);
                ctx.fill();
            }
        };

        draw();

        return () => {
            if (rafRef.current !== null) {
                cancelAnimationFrame(rafRef.current);
                rafRef.current = null;
            }
        };
    }, [analyser, isActive]);

    return (
        <Box
            borderRadius="md"
            overflow="hidden"
            bg="#1A202C"
            aria-label="Audio level meter"
        >
            <canvas
                ref={canvasRef}
                width={320}
                height={56}
                style={{ display: "block", width: "100%", height: "56px" }}
            />
        </Box>
    );
}
