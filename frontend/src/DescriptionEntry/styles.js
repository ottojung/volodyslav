/**
 * Styling constants and configurations for DescriptionEntry component
 */

// Common spacing and sizing
export const SPACING = {
    xs: 1,
    sm: 2,
    md: 3,
    lg: 4,
    xl: 6,
    xxl: 8,
};

export const SIZES = {
    containerMaxW: "100%",
    cardMaxW: "md",
    inputHeight: 6,
    buttonPadding: 8,
};

/** @type {'center'} */
const ALIGN_CENTER = 'center';

// Color scheme
export const COLORS = {
    primary: "blue.500",
    primaryScheme: "blue",
    text: {
        primary: "gray.800",
        secondary: "gray.600",
        muted: "gray.500",
        light: "gray.700",
    },
    background: {
        main: "white",
        card: "gray.50",
        input: "gray.50",
        inputFocus: "white",
    },
    border: {
        default: "gray.200",
        focus: "blue.500",
    },
};

// Reusable style objects
export const CARD_STYLES = {
    main: {
        shadow: "lg",
        borderRadius: "2xl",
        bg: COLORS.background.main,
        mx: 2,
        maxW: SIZES.cardMaxW,
        alignSelf: "center",
        w: "full",
    },
    secondary: {
        shadow: "md",
        borderRadius: "xl",
        bg: COLORS.background.card,
        mx: 2,
        maxW: SIZES.cardMaxW,
        alignSelf: "center",
        w: "full",
    },
    entry: {
        p: SPACING.md,
        bg: COLORS.background.main,
        borderRadius: "lg",
        shadow: "sm",
    },
};

export const INPUT_STYLES = {
    size: "lg",
    border: "2px",
    borderColor: COLORS.border.default,
    focusBorderColor: "blue.400",
    bg: COLORS.background.input,
    fontSize: "lg",
    py: SIZES.inputHeight,
    _placeholder: {
        color: COLORS.text.muted,
        fontSize: "lg",
    },
    _focus: {
        bg: COLORS.background.inputFocus,
        shadow: "md",
        borderColor: COLORS.border.focus,
    },
};

export const BUTTON_STYLES = {
    primary: {
        colorScheme: COLORS.primaryScheme,
        size: "md",
        px: SIZES.buttonPadding,
        borderRadius: "xl",
    },
    secondary: {
        variant: "ghost",
        size: "md",
        color: COLORS.text.secondary,
    },
};

export const TEXT_STYLES = {
    heading: {
        size: "xl",
        color: COLORS.text.primary,
        fontWeight: "400",
        mb: SPACING.md,
    },
    subtitle: {
        color: COLORS.text.secondary,
        fontSize: "lg",
    },
    cardHeading: {
        color: COLORS.text.primary,
        fontWeight: "medium",
    },
    sectionTitle: {
        fontSize: "sm",
        fontWeight: "semibold",
        color: COLORS.text.secondary,
        textAlign: ALIGN_CENTER,
    },
    helper: {
        fontSize: "sm",
        color: COLORS.text.muted,
    },
    entryText: {
        fontSize: "sm",
        color: COLORS.text.light,
    },
    entryMeta: {
        fontSize: "xs",
        color: COLORS.text.muted,
    },
};

export const BADGE_STYLES = {
    colorScheme: COLORS.primaryScheme,
    variant: "subtle",
    fontSize: "xs",
};
