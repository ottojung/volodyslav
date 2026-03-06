import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Button, Box, VStack, Heading, Text, Select, Spinner, Divider } from '@chakra-ui/react';
import { logger } from './DescriptionEntry/logger.js';
import { postSync } from './Sync/api.js';

function App() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [isInstallable, setIsInstallable] = useState(false);
  const [syncResetToTheirs, setSyncResetToTheirs] = useState(false);
  const [syncState, setSyncState] = useState('idle');
  const [syncError, setSyncError] = useState('');

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

  const handleSyncClick = async () => {
    setSyncState('loading');
    setSyncError('');

    const result = await postSync(syncResetToTheirs || undefined);

    if (result.success) {
      setSyncState('success');
      setTimeout(() => setSyncState('idle'), 2000);
    } else {
      setSyncState('error');
      setSyncError(result.error || 'Sync failed');
    }
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
          <Link to="/search">
            <Button colorScheme="purple" variant="outline" w="200px">Search Entries</Button>
          </Link>
          <Link to="/config">
            <Button colorScheme="gray" variant="outline" w="200px">Manage Config</Button>
          </Link>
        </VStack>

        <Divider />

        <VStack spacing={2}>
          <Select
            size="sm"
            value={syncResetToTheirs ? 'reset-to-theirs' : ''}
            onChange={(e) => { setSyncResetToTheirs(e.target.value === 'reset-to-theirs'); setSyncState('idle'); setSyncError(''); }}
            w="200px"
          >
            <option value="">Normal sync</option>
            <option value="reset-to-theirs">Reset to Theirs</option>
          </Select>
          <Button
            colorScheme={syncState === 'success' ? 'green' : syncState === 'error' ? 'red' : 'orange'}
            variant="outline"
            w="200px"
            onClick={handleSyncClick}
            isDisabled={syncState === 'loading'}
            leftIcon={syncState === 'loading' ? <Spinner size="sm" /> : undefined}
          >
            {syncState === 'loading' ? 'Syncing…' : syncState === 'success' ? 'Synced!' : 'Sync'}
          </Button>
          {syncState === 'error' && syncError !== '' && (
            <Text fontSize="sm" color="red.600" textAlign="center">{syncError}</Text>
          )}
        </VStack>
      </VStack>
    </Box>
  );
}

export default App;
