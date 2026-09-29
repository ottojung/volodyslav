// Style props for Camera component
/** @type {import('@chakra-ui/react').BoxProps} */
export const containerProps = {
  as: 'section',
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  m: 0,
  p: 0,
  display: 'flex',
  flexDirection: 'column',
  bg: 'black',
  color: 'white',
  fontFamily: 'sans-serif',
  overflow: 'hidden',
};

/** @type {import('@chakra-ui/react').BoxProps} */
export const videoContainerProps = {
  position: 'relative',
  flex: 1,
  w: '100%',
  overflow: 'hidden',
};

/** @type {import('@chakra-ui/react').BoxProps} */
export const videoProps = {
  w: '100%',
  h: '100%',
  objectFit: 'cover',
  bg: 'black',
};

/** @type {import('@chakra-ui/react').ImageProps} */
export const imageProps = {
  w: '100%',
  h: '100%',
  objectFit: 'cover',
  bg: 'black',
};

/**
 * The preview bar is a single full-width row that never wraps. Each of the three
 * regions below occupies one equal-width column of that row, so the horizontal
 * relationship between the actions is fixed by the region an action lives in
 * rather than by the flow of the buttons. That is what keeps a discarding action
 * far from the keep and finish actions, and keeps the two keep/finish actions
 * apart from each other, on a 320px phone as well as on a tablet.
 *
 * A wrapping cluster of buttons packed by a small gap does not satisfy this: the
 * distance between neighbouring actions would depend on the viewport width, and a
 * wrap could place a discarding action directly beside a finish action.
 *
 * @type {import('@chakra-ui/react').FlexProps}
 */
export const controlsProps = {
  position: 'absolute',
  bottom: '20px',
  left: 0,
  right: 0,
  flexWrap: 'nowrap',
  justifyContent: 'space-between',
  alignItems: 'center',
  boxSizing: 'border-box',
};

/**
 * Shared shape of a control region. The region takes one equal share of the bar
 * and pins its control to one side of that share. `minWidth: 0` lets the three
 * shares shrink to fit the narrowest supported phone while the control inside
 * keeps its own minimum hit area.
 *
 * @type {import('@chakra-ui/react').BoxProps}
 */
const anchorBaseProps = {
  flex: '1 1 0',
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  px: '0.5em',
};

/** Region holding the action anchored to the leading edge of the bar. */
export const anchorLeftProps = {
  ...anchorBaseProps,
  justifyContent: 'flex-start',
};

/** Region holding the action anchored to the middle of the bar. */
export const anchorCenterProps = {
  ...anchorBaseProps,
  justifyContent: 'center',
};

/** Region holding the action anchored to the trailing edge of the bar. */
export const anchorRightProps = {
  ...anchorBaseProps,
  justifyContent: 'flex-end',
};

/**
 * Every control keeps a hit area of at least 3rem by 3rem, which is 48 by 48
 * CSS px at the default root font size.
 *
 * @type {import('@chakra-ui/react').ButtonProps}
 */
export const buttonProps = {
  bg: 'rgba(255,255,255,0.2)',
  color: 'white',
  borderRadius: '5px',
  minWidth: '3rem',
  minHeight: '3rem',
  px: '1.6em',
  py: '0.8em',
  fontSize: '1rem',
  touchAction: 'manipulation',
};

/**
 * The discarding action is additionally tinted so that it is distinguishable
 * from the keep and finish actions before it is pressed. This changes only the
 * appearance of the control, not what it does.
 *
 * @type {import('@chakra-ui/react').ButtonProps}
 */
export const discardButtonProps = {
  ...buttonProps,
  bg: 'rgba(220,38,38,0.35)',
  border: '1px solid rgba(255,255,255,0.65)',
};
