import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  Button,
  Box,
  VStack,
  Text,
  Select,
  Spinner,
  Divider,
  Alert,
  AlertIcon,
  AlertTitle,
  AlertDescription,
  Code,
  UnorderedList,
  ListItem,
} from '@chakra-ui/react';
import { logger } from './DescriptionEntry/logger.js';
import { postSync, fetchSyncHostnames } from './Sync/api.js';
import { SyncStepList } from './Sync/SyncStepList.jsx';
import { fetchVersion } from './version_api.js';

/** @typedef {{ name: string, message: string, causes: string[] }} SyncErrorDetail */
/** @typedef {{ message: string, details: SyncErrorDetail[] }} SyncErrorState */
/** @typedef {import('./Sync/SyncStepList.jsx').SyncStepResult} SyncStepResult */

/**
 * @returns {SyncErrorState}
 */
function makeEmptySyncError() {
  return { message: '', details: [] };
}

/**
 * @param {string | undefined} resetToHostname
 * @returns {string}
 */
function makeSyncSuccessMessage(resetToHostname) {
  if (resetToHostname !== undefined) {
    return `Your local data was reset to match ${resetToHostname}-main.`;
  }

  return 'Your local and remote data are now in sync.';
}

/**
 * @returns {SyncStepResult[]}
 */
function makeEmptySyncSteps() {
  return [];
}

/**
 * @returns {string[]}
 */
function makeEmptySyncHostnames() {
  return [];
}

function App() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [isInstallable, setIsInstallable] = useState(false);
  const [syncMode, setSyncMode] = useState('');
  const [syncResetHostname, setSyncResetHostname] = useState('');
  const [syncHostnames, setSyncHostnames] = useState(makeEmptySyncHostnames());
  const [syncHostnamesState, setSyncHostnamesState] = useState('loading');
  const [syncState, setSyncState] = useState('idle');
  const [syncError, setSyncError] = useState(makeEmptySyncError());
  const [syncSuccessMessage, setSyncSuccessMessage] = useState('');
  const [syncSteps, setSyncSteps] = useState(makeEmptySyncSteps());
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
    if (syncMode !== 'reset-to-hostname') {
      return;
    }

    let isMounted = true;

    async function loadSyncHostnames() {
      const nextHostnames = await fetchSyncHostnames();
      if (!isMounted) {
        return;
      }
      setSyncHostnames(nextHostnames);
      setSyncHostnamesState('ready');
    }

    void loadSyncHostnames();

    return () => {
      isMounted = false;
    };
  }, [syncMode]);

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

  /** @param {{ target: { value: string } }} e */
  const handleSyncModeChange = (e) => {
    setSyncMode(e.target.value);
    setSyncState('idle');
    setSyncError(makeEmptySyncError());
    setSyncSuccessMessage('');
    setSyncSteps([]);
  };

  /** @param {{ target: { value: string } }} e */
  const handleSyncHostnameChange = (e) => {
    setSyncResetHostname(e.target.value);
  };

  const handleSyncClick = async () => {
    const trimmedResetHostname = syncResetHostname.trim();
    if (syncMode === 'reset-to-hostname' && trimmedResetHostname === '') {
      return;
    }

    setSyncState('loading');
    setSyncError(makeEmptySyncError());
    setSyncSuccessMessage('');
    setSyncSteps([]);

    const nextResetHostname = syncMode === 'reset-to-hostname'
      ? trimmedResetHostname
      : undefined;
    const result = await postSync(nextResetHostname, (steps) => {
      setSyncSteps(steps);
    });

    if (result.success) {
      setSyncState('success');
      setSyncSuccessMessage(makeSyncSuccessMessage(result.resetToHostname));
      setSyncSteps(result.steps || []);
      setTimeout(() => setSyncState('idle'), 2000);
    } else {
      setSyncState('error');
      setSyncSuccessMessage('');
      setSyncSteps(result.steps || []);
      setSyncError({
        message: result.error || 'Sync failed',
        details: result.details || [],
      });
    }
  };

  return (
    <Box p={6}>
      <VStack spacing={4} align="stretch">
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
            aria-label="Sync mode"
            size="sm"
            value={syncMode}
            onChange={handleSyncModeChange}
            w="200px"
          >
            <option value="">Normal sync</option>
            <option value="reset-to-hostname">Reset to Host</option>
          </Select>
          {syncMode === 'reset-to-hostname' && (
            <Select
              aria-label="Reset hostname"
              size="sm"
              value={syncResetHostname}
              onChange={handleSyncHostnameChange}
              w="260px"
            >
              <option value="" disabled={syncHostnames.length > 0}>
                {syncHostnamesState === 'loading'
                  ? 'Loading hostnames...'
                  : syncHostnames.length === 0
                    ? 'No hostnames available'
                    : 'Select hostname'}
              </option>
              {syncHostnames.map((hostname) => (
                <option key={hostname} value={hostname}>{hostname}</option>
              ))}
            </Select>
          )}
          <Button
            colorScheme={syncState === 'success' ? 'green' : syncState === 'error' ? 'red' : 'orange'}
            variant="outline"
            w="200px"
            onClick={handleSyncClick}
            isDisabled={syncState === 'loading' || (syncMode === 'reset-to-hostname' && syncResetHostname.trim() === '')}
            leftIcon={syncState === 'loading' ? <Spinner size="sm" /> : undefined}
          >
            {syncState === 'loading' ? 'Syncing…' : syncState === 'success' ? 'Synced!' : 'Sync'}
          </Button>
          {(syncState === 'loading' || syncState === 'success' || syncState === 'error') && (
            <SyncStepList steps={syncSteps} isRunning={syncState === 'loading'} />
          )}
          {syncSuccessMessage && (
            <Alert status="success" borderRadius="md" alignItems="flex-start">
              <AlertIcon mt={1} />
              <Box>
                <AlertTitle>Sync complete</AlertTitle>
                <AlertDescription>{syncSuccessMessage}</AlertDescription>
              </Box>
            </Alert>
          )}
          {syncState === 'error' && syncError.message !== '' && (
            <Alert status="error" borderRadius="md" alignItems="flex-start">
              <AlertIcon mt={1} />
              <Box>
                <AlertTitle>Sync failed</AlertTitle>
                <AlertDescription>
                  <VStack spacing={3} align="stretch" mt={2}>
                    <Text whiteSpace="pre-wrap">{syncError.message}</Text>
                    {syncError.details.length > 0 && (
                      <Box>
                        <Text fontWeight="semibold" mb={2}>Details</Text>
                        <UnorderedList spacing={2} ml={4}>
                          {syncError.details.map((detail, index) => (
                            <ListItem key={`${detail.name}-${index}`}>
                              <Text fontWeight="medium">{detail.name}</Text>
                              <Text>{detail.message}</Text>
                              {detail.causes.length > 0 && (
                                <Code display="block" mt={2} whiteSpace="pre-wrap">
                                  {detail.causes.join('\n')}
                                </Code>
                              )}
                            </ListItem>
                          ))}
                        </UnorderedList>
                      </Box>
                    )}
                  </VStack>
                </AlertDescription>
              </Box>
            </Alert>
          )}
        </VStack>

        <Box pt={4}>
          <Divider mb={4} />
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
