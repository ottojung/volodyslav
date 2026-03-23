import React from 'react';
import { VStack, HStack, Text, Spinner, Badge } from '@chakra-ui/react';

/**
 * @typedef {{ name: string, status: "success" | "error" }} SyncStepResult
 */

/** @type {{ name: string, label: string }[]} */
const SYNC_STEPS = [
  { name: 'generators', label: 'Generators' },
  { name: 'assets', label: 'Assets' },
];

/** @type {{ [key: string]: string }} */
const STEP_BG_COLOR = {
  success: 'green.50',
  error: 'red.50',
  pending: 'gray.50',
};

/** @type {{ [key: string]: string }} */
const STEP_TEXT_COLOR = {
  success: 'green.700',
  error: 'red.700',
  pending: 'gray.500',
};

/**
 * Displays the progress of individual sync steps.
 * @param {{ steps: SyncStepResult[], isRunning: boolean }} props
 */
function SyncStepList({ steps, isRunning }) {
  const completedByName = Object.fromEntries(steps.map((s) => [s.name, s.status]));

  return (
    <VStack gap={1} align="stretch" w="200px">
      {SYNC_STEPS.map((step, index) => {
        const status = completedByName[step.name];
        const isPending = !status;
        const isCurrentStep = isRunning && isPending && steps.length === index;
        const colorKey = status ?? 'pending';

        return (
          <HStack key={step.name} gap={2} px={2} py={1} borderRadius="md" bg={STEP_BG_COLOR[colorKey]}>
            {status === 'success' && <Text fontSize="xs" color="green.500">✓</Text>}
            {status === 'error' && <Text fontSize="xs" color="red.500">✗</Text>}
            {isPending && !isCurrentStep && <Text fontSize="xs" color="gray.400">○</Text>}
            {isPending && isCurrentStep && <Spinner size="xs" color="orange.400" />}
            <Text fontSize="sm" color={STEP_TEXT_COLOR[colorKey]}>
              {step.label}
            </Text>
            {status && (
              <Badge ml="auto" colorScheme={status === 'success' ? 'green' : 'red'} fontSize="xs">
                {status === 'success' ? 'done' : 'failed'}
              </Badge>
            )}
          </HStack>
        );
      })}
    </VStack>
  );
}

export { SyncStepList };
