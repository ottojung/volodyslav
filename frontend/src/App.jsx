import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  Button,
  Box,
  VStack,
  Text,
  Separator,
} from '@chakra-ui/react';
import { logger } from './DescriptionEntry/logger.js';
import { SyncSection } from './Sync/SyncSection.jsx';
import { fetchVersion } from './version_api.js';

function App() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [isInstallable, setIsInstallable] = useState(false);
  const [version, setVersion] = useState('');
  const [versionState, setVersionState] = useState('loading');

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

  useEffect(() => {
    let isMounted = true;

    async function loadVersion() {
      const nextVersion = await fetchVersion();

      if (!isMounted) {
        return;
      }

      if (nextVersion === null) {
        setVersionState('error');
        return;
      }

      setVersion(nextVersion);
      setVersionState('ready');
    }

    void loadVersion();

    return () => {
      isMounted = false;
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
      <VStack gap={4} align="stretch">
        {isInstallable && (
          <Box p={4} bg="blue.50" borderRadius="md" border="1px" borderColor="blue.200">
            <Text mb={2} fontSize="sm" color="blue.800">
              Install this app on your device for a better experience!
            </Text>
            <Button
              colorPalette="blue"
              size="sm"
              onClick={handleInstallClick}
            >
              Install App
            </Button>
          </Box>
        )}

        <VStack gap={3}>
          <Link to="/camera">
            <Button colorPalette="teal" w="200px">Open Camera</Button>
          </Link>
          <Link to="/describe">
            <Button colorPalette="blue" variant="outline" w="200px">Log an Event</Button>
          </Link>
          <Link to="/search">
            <Button colorPalette="purple" variant="outline" w="200px">Search Entries</Button>
          </Link>
          <Link to="/record-diary">
            <Button colorPalette="orange" variant="outline" w="200px">Record Diary</Button>
          </Link>
          <Link to="/config">
            <Button colorPalette="gray" variant="outline" w="200px">Manage Config</Button>
          </Link>
        </VStack>

        <Separator />

        <SyncSection />

        <Separator />

        <Box pt={4}>
          <Box
            alignSelf="center"
            bg="gray.50"
            border="1px solid"
            borderColor="gray.200"
            borderRadius="full"
            px={4}
            py={2}
          >
            <Text fontSize="xs" color="gray.600" textAlign="center">
              {versionState === 'ready'
                ? `Volodyslav ${version}`
                : versionState === 'error'
                  ? 'Volodyslav version unavailable'
                  : 'Loading Volodyslav version…'}
            </Text>
          </Box>
        </Box>
      </VStack>
    </Box>
  );
}

export default App;
