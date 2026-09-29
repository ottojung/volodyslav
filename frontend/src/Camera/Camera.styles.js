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
 * Minimum edge-to-edge separation, in CSS px at the 16px root font size, that
 * the stylesheet places between the hit areas of two controls in neighbouring
 * regions.
 *
 * The properties that this class carries are:
 * - Two controls in neighbouring regions are at least this far apart at every
 *   viewport width and in both the camera and the preview mode.
 *
 * The proof of those properties is guaranteed by:
 * - `controlsProps` sets `gap` to `MINIMUM_SEPARATION_GAP_REM`, and a flex
 *   `gap` is an exact offset between adjacent items, never a distributable
 *   slack, so no amount of viewport width or free space can reduce it.
 * - `anchorBaseProps` sets `minWidth: 'min-content'`, so a region is never
 *   narrower than the control it holds. A region therefore always contributes at
 *   least its `MINIMUM_ANCHOR_INSET_REM` of padding on the side facing its
 *   neighbour, on top of the gap.
 * - Together: the gap plus one inset from each of the two regions between them
 *   is `2 * MINIMUM_ANCHOR_INSET_REM + MINIMUM_SEPARATION_GAP_REM` rem, which at
 *   the 16px root is the value above.
 * - `frontend/tests/Camera.test.jsx` reads these declarations back off the
 *   rendered elements and re-derives the same value.
 *
 * @type {number}
 */
export const MINIMUM_SEPARATION_PX = 56;

/**
 * Half of `MINIMUM_SEPARATION_PX`, expressed in rem, as the bar's `gap`.
 *
 * The value is bounded above by the narrowest supported viewport: at 320px the
 * bar's three regions already claim their content plus padding, and the two gaps
 * have to fit in what is left.
 *
 * @type {string}
 */
const MINIMUM_SEPARATION_GAP_REM = '2.5rem';

/**
 * The remaining share of `MINIMUM_SEPARATION_PX`, expressed in rem, as each
 * region's inline padding on the side facing a neighbouring region.
 *
 * @type {string}
 */
const MINIMUM_ANCHOR_INSET_REM = '0.5rem';

/**
 * The preview bar is a single full-width row that never wraps. Its three
 * regions are sized from the control each one holds and are kept apart by the
 * `gap` below, so the horizontal distance between the hit areas of two controls
 * cannot be reduced by a narrower viewport, by free space in the bar, or by a
 * control being wider than the slack available. That is what keeps a discarding
 * action far from the keep and finish actions, and keeps the two keep/finish
 * actions apart from each other, on a 320px phone as well as on a tablet.
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
  gap: MINIMUM_SEPARATION_GAP_REM,
  alignItems: 'center',
  boxSizing: 'border-box',
};

/**
 * Shared shape of a control region. A region takes its width from the control it
 * holds: a content-based flex basis together with `minWidth: 'min-content'`
 * means a region can never be narrower than its control, so a control can never
 * be squeezed into, or overflow into, the space of the neighbouring region. The
 * region pins its control to one end of itself.
 *
 * @type {import('@chakra-ui/react').BoxProps}
 */
const anchorBaseProps = {
  minWidth: 'min-content',
  display: 'flex',
  alignItems: 'center',
  px: MINIMUM_ANCHOR_INSET_REM,
};

/**
 * Region holding the action anchored to the leading edge of the bar. It grows to
 * absorb the bar's free space, so the action stays at the left edge, but
 * `minWidth: 'min-content'` stops that growth from being paid for by squeezing
 * the control.
 *
 * @type {import('@chakra-ui/react').BoxProps}
 */
export const anchorLeftProps = {
  ...anchorBaseProps,
  flex: '1 1 auto',
  justifyContent: 'flex-start',
};

/** Region holding the action anchored to the middle of the bar. @type {import('@chakra-ui/react').BoxProps} */
export const anchorCenterProps = {
  ...anchorBaseProps,
  flex: '0 0 auto',
  justifyContent: 'center',
};

/**
 * Region holding the action anchored to the trailing edge of the bar, growing
 * for the same reason as the leading region.
 *
 * @type {import('@chakra-ui/react').BoxProps}
 */
export const anchorRightProps = {
  ...anchorBaseProps,
  flex: '1 1 auto',
  justifyContent: 'flex-end',
};

/**
 * Every control keeps a hit area of at least 3rem by 3rem, which is 48 by 48
 * CSS px at the default root font size. The inline padding is deliberately
 * small: the widest control in the bar is `Take Photo`, and its padding is what
 * decides whether the bar's contents still fit at the narrowest supported
 * viewport width.
 *
 * @type {import('@chakra-ui/react').ButtonProps}
 */
export const buttonProps = {
  bg: 'rgba(255,255,255,0.2)',
  color: 'white',
  borderRadius: '5px',
  minWidth: '3rem',
  minHeight: '3rem',
  px: '0.6em',
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
