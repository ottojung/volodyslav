import React, { useRef, useEffect } from "react";
import { Box } from "@chakra-ui/react";

/**
 * @typedef {object} AudioVisualizationProps
 * @property {AnalyserNode | null} analyser - Web Audio AnalyserNode to read levels from.
 * @property {boolean} isActive - Whether the recorder is currently recording.
 */

/**
 * Simple audio level meter that reads from a Web Audio AnalyserNode.
 *
 * @param {AudioVisualizationProps} props
 * @returns {React.JSX.Element}
 */
export default function AudioVisualization({ analyser, isActive }) {
    /** @type {React.RefObject<HTMLCanvasElement | null>} */
    const canvasRef = useRef(null);
    /** @type {React.MutableRefObject<number | null>} */
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
            // Draw empty bar
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = "#E2E8F0";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            return undefined;
        }

        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        const draw = () => {
            rafRef.current = requestAnimationFrame(draw);

            analyser.getByteFrequencyData(dataArray);

            // Calculate RMS level
            let sum = 0;
            for (let i = 0; i < bufferLength; i++) {
                const sample = dataArray[i] ?? 0;
                sum += (sample / 255) ** 2;
            }
            const rms = Math.sqrt(sum / bufferLength);
            const level = Math.min(1, rms * 4);

            const w = canvas.width;
            const h = canvas.height;

            ctx.clearRect(0, 0, w, h);

            // Background
            ctx.fillStyle = "#E2E8F0";
            ctx.fillRect(0, 0, w, h);

            // Level bar
            const barWidth = Math.round(w * level);
            const gradient = ctx.createLinearGradient(0, 0, w, 0);
            gradient.addColorStop(0, "#48BB78");
            gradient.addColorStop(0.6, "#ECC94B");
            gradient.addColorStop(1, "#FC8181");
            ctx.fillStyle = gradient;
            ctx.fillRect(0, 0, barWidth, h);
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
            border="1px solid"
            borderColor="gray.200"
            aria-label="Audio level meter"
        >
            <canvas
                ref={canvasRef}
                width={300}
                height={24}
                style={{ display: "block", width: "100%", height: "24px" }}
            />
        </Box>
    );
}
