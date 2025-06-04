import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Button, Box, VStack, Heading, Text } from '@chakra-ui/react';

function App() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [isInstallable, setIsInstallable] = useState(false);

  useEffect(() => {
    const handleBeforeInstallPrompt = (e) => {
      // Prevent the mini-infobar from appearing on mobile
      e.preventDefault();
      // Store the event so it can be triggered later
      setDeferredPrompt(e);
      setIsInstallable(true);
    };

    const handleAppInstalled = () => {
      console.log('PWA was installed');
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

    // Show the install prompt
    deferredPrompt.prompt();

    // Wait for the user to respond to the prompt
    const { outcome } = await deferredPrompt.userChoice;
    
    if (outcome === 'accepted') {
      console.log('User accepted the install prompt');
    } else {
      console.log('User dismissed the install prompt');
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

        <Box>
          <Link to="/camera">
            <Button colorScheme="teal">Open Camera</Button>
          </Link>
        </Box>
      </VStack>
    </Box>
  );
}

export default App;
