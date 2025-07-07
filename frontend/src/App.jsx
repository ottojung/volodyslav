import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Button, Box, VStack, Heading, Text } from '@chakra-ui/react';
import { logger } from './DescriptionEntry/logger.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
function App() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [isInstallable, setIsInstallable] = useState(false);

  useEffect(() => {
    // @ts-expect-error - beforeinstallprompt is a browser API not in TS types
    const handleBeforeInstallPrompt = (e) => {
      // Prevent the mini-infobar from appearing on mobile
      e.preventDefault();
      // Store the event so it can be triggered later
      setDeferredPrompt(e);
      setIsInstallable(true);
    };

    const handleAppInstalled = () => {
      logger.info('PWA was installed');
      setIsInstallable(false);
      setDeferredPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  const handleInstallClick = async () => {
    if (!deferredPrompt) {
      return;
    }

    try {
      // @ts-expect-error - PWA install API not in TS types
      await deferredPrompt.prompt();

      // @ts-expect-error - PWA install API not in TS types
      const result = await deferredPrompt.userChoice;
      const outcome = result?.outcome;
      
      if (outcome === 'accepted') {
        logger.info('User accepted the install prompt');
      } else {
        logger.info('User dismissed the install prompt');
      }
    } catch (error) {
      logger.error('Install prompt error:', error);
    }

    // Clear the deferredPrompt so it can only be used once
    setDeferredPrompt(null);
    setIsInstallable(false);
  };

  return (
    <Box p={6}>
      <VStack spacing={4} align="stretch">
        <Heading>Hello, world!</Heading>
        
        {isInstallable && (
          <Box p={4} bg="blue.50" borderRadius="md" border="1px" borderColor="blue.200">
            <Text mb={2} fontSize="sm" color="blue.800">
              Install this app on your device for a better experience!
            </Text>
            <Button 
              colorScheme="blue" 
              size="sm" 
              onClick={handleInstallClick}
            >
              Install App
            </Button>
          </Box>
        )}

        <VStack spacing={3}>
          <Link to="/camera">
            <Button colorScheme="teal" w="200px">Open Camera</Button>
          </Link>
          <Link to="/describe">
            <Button colorScheme="blue" variant="outline" w="200px">Log an Event</Button>
          </Link>
        </VStack>
      </VStack>
    </Box>
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export default App;
