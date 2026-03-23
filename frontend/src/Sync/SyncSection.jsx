import React, { useState, useEffect } from 'react';
import {
  Button,
  Box,
  VStack,
  Text,
  NativeSelect,
  Spinner,
  Alert,
  Code,
  List,
  HStack,
} from '@chakra-ui/react';
import { postSync, fetchSyncHostnames } from './api.js';
import { SyncStepList } from './SyncStepList.jsx';

/** @typedef {{ name: string, message: string, causes: string[] }} SyncErrorDetail */
/** @typedef {{ message: string, details: SyncErrorDetail[] }} SyncErrorState */
/** @typedef {import('./SyncStepList.jsx').SyncStepResult} SyncStepResult */

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
 * Renders the sync controls: mode selector, hostname picker, sync button,
 * step list, and result alerts.
 * @returns {React.JSX.Element}
 */
/**
 * @returns {string[]}
 */
function makeEmptySyncHostnames() {
  return [];
}

/**
 * @returns {SyncStepResult[]}
 */
function makeEmptySyncSteps() {
  return [];
}

export function SyncSection() {
  const [syncMode, setSyncMode] = useState('');
  const [syncResetHostname, setSyncResetHostname] = useState('');
  const [syncHostnames, setSyncHostnames] = useState(makeEmptySyncHostnames());
  const [syncHostnamesState, setSyncHostnamesState] = useState('loading');
  const [syncState, setSyncState] = useState('idle');
  const [syncError, setSyncError] = useState(makeEmptySyncError());
  const [syncSuccessMessage, setSyncSuccessMessage] = useState('');
  const [syncSteps, setSyncSteps] = useState(makeEmptySyncSteps());

  useEffect(() => {
    if (syncMode !== 'reset-to-hostname') {
      return;
    }

    let isMounted = true;

    async function loadSyncHostnames() {
      setSyncHostnamesState('loading');
      setSyncHostnames([]);
      setSyncResetHostname('');
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
    if (syncState !== 'success') {
      return undefined;
    }

    const resetTimer = setTimeout(() => {
      setSyncState('idle');
    }, 2000);

    return () => {
      clearTimeout(resetTimer);
    };
  }, [syncState]);

  /** @param {{ target: { value: string } }} e */
  const handleSyncModeChange = (e) => {
    const nextMode = e.target.value;
    setSyncMode(nextMode);
    if (nextMode !== 'reset-to-hostname') {
      setSyncResetHostname('');
    }
    setSyncState('idle');
    setSyncError(makeEmptySyncError());
    setSyncSuccessMessage('');
    setSyncSteps([]);
  };

  /** @param {string} value */
  const handleSyncHostnameChange = (value) => {
    setSyncResetHostname(value);
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
    <VStack gap={2}>
      <NativeSelect.Root>
        <NativeSelect.Field
          aria-label="Sync mode"
          value={syncMode}
          onChange={handleSyncModeChange}
          w="200px">
          <option value="">Normal sync</option>
          <option value="reset-to-hostname">Reset to Host</option>
        </NativeSelect.Field>
        <NativeSelect.Indicator />
      </NativeSelect.Root>
      {syncMode === 'reset-to-hostname' && (
        <Box w="200px" borderWidth="1px" borderRadius="md" p={2}>
          {syncHostnamesState === 'loading' ? (
            <Text fontSize="sm">Loading hostnames...</Text>
          ) : syncHostnames.length === 0 ? (
            <Text fontSize="sm">No hostnames available</Text>
          ) : (
            <VStack align="stretch" gap={1} role="radiogroup" aria-label="Reset host">
              {syncHostnames.map((hostname) => (
                <Button
                  key={hostname}
                  size="sm"
                  variant={syncResetHostname === hostname ? "solid" : "outline"}
                  colorPalette={syncResetHostname === hostname ? "blue" : "gray"}
                  onClick={() => handleSyncHostnameChange(hostname)}
                  role="radio"
                  aria-checked={syncResetHostname === hostname}
                >
                  <HStack justify="space-between" w="full">
                    <Text>{hostname}</Text>
                    {syncResetHostname === hostname ? <Text aria-hidden="true">●</Text> : null}
                  </HStack>
                </Button>
              ))}
            </VStack>
          )}
        </Box>
      )}
      <Button
        colorPalette={syncState === 'success' ? 'green' : syncState === 'error' ? 'red' : 'orange'}
        variant="outline"
        w="200px"
        onClick={handleSyncClick}
        disabled={syncState === 'loading' || (syncMode === 'reset-to-hostname' && syncResetHostname.trim() === '')}>{syncState === 'loading' ? <Spinner size="sm" /> : undefined}{syncState === 'loading' ? 'Syncing…' : syncState === 'success' ? 'Synced!' : 'Sync'}</Button>
      {(syncState === 'loading' || syncState === 'success' || syncState === 'error') && (
        <SyncStepList steps={syncSteps} isRunning={syncState === 'loading'} />
      )}
      {syncSuccessMessage && (
        <Alert.Root status="success" borderRadius="md" alignItems="flex-start">
          <Alert.Indicator mt={1} />
          <Box>
            <Alert.Title>Sync complete</Alert.Title>
            <Alert.Description>{syncSuccessMessage}</Alert.Description>
          </Box>
        </Alert.Root>
      )}
      {syncState === 'error' && syncError.message !== '' && (
        <Alert.Root status="error" borderRadius="md" alignItems="flex-start">
          <Alert.Indicator mt={1} />
          <Box>
            <Alert.Title>Sync failed</Alert.Title>
            <Alert.Description>
              <VStack gap={3} align="stretch" mt={2}>
                <Text whiteSpace="pre-wrap">{syncError.message}</Text>
                {syncError.details.length > 0 && (
                  <Box>
                    <Text fontWeight="semibold" mb={2}>Details</Text>
                    <List.Root as='ul' gap={2} ml={4}>
                      {syncError.details.map((detail, index) => (
                        <List.Item key={`${detail.name}-${index}`}>
                          <Text fontWeight="medium">{detail.name}</Text>
                          <Text>{detail.message}</Text>
                          {detail.causes.length > 0 && (
                            <Code display="block" mt={2} whiteSpace="pre-wrap">
                              {detail.causes.join('\n')}
                            </Code>
                          )}
                        </List.Item>
                      ))}
                    </List.Root>
                  </Box>
                )}
              </VStack>
            </Alert.Description>
          </Box>
        </Alert.Root>
      )}
    </VStack>
  );
}
