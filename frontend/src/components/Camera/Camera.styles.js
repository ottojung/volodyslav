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

/** @type {import('@chakra-ui/react').FlexProps} */
export const controlsProps = {
  position: 'absolute',
  bottom: '20px',
  left: '50%',
  transform: 'translateX(-50%)',
  gap: '0.5em',
  px: '0.5em',
  flexWrap: 'wrap',
  boxSizing: 'border-box',
};

/** @type {import('@chakra-ui/react').ButtonProps} */
export const buttonProps = {
  bg: 'rgba(255,255,255,0.2)',
  color: 'white',
  borderRadius: '5px',
  px: '1.6em',
  py: '0.8em',
  fontSize: '1rem',
};