import React from "react";

/**
 * Simple icon components using forwardRef to avoid warnings
 * @param {React.ComponentPropsWithoutRef<"span">} props
 * @param {React.Ref<HTMLSpanElement>} ref
 * @returns {JSX.Element}
 */
export const ChevronDownIcon = React.forwardRef((props, ref) => (
    <span ref={ref} {...props}>
        ▼
    </span>
));
ChevronDownIcon.displayName = "ChevronDownIcon";

/**
 * @param {React.ComponentPropsWithoutRef<"span">} props
 * @param {React.Ref<HTMLSpanElement>} ref
 * @returns {JSX.Element}
 */
export const ChevronUpIcon = React.forwardRef((props, ref) => (
    <span ref={ref} {...props}>
        ▲
    </span>
));
ChevronUpIcon.displayName = "ChevronUpIcon";

/**
 * @param {React.ComponentPropsWithoutRef<"span">} props
 * @param {React.Ref<HTMLSpanElement>} ref
 * @returns {JSX.Element}
 */
export const InfoIcon = React.forwardRef((props, ref) => (
    <span ref={ref} {...props}>
        ℹ️
    </span>
));
InfoIcon.displayName = "InfoIcon";
