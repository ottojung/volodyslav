import React from 'react';
import ReactDOM from 'react-dom/client';
// eslint-disable-next-line import/no-unresolved
import { registerSW } from 'virtual:pwa-register';
import App from './App.jsx';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Camera from './Camera/Camera.jsx';
import { ChakraProvider } from '@chakra-ui/react';

const root = document.getElementById('root');
if (root === null) {
    throw new Error("Could not find root node.");
}

// Register service worker with update prompt
const updateSW = registerSW({
    onNeedRefresh() {
        if (confirm('New content available. Reload?')) {
            updateSW(true);
        }
    },
    onOfflineReady() {
        console.log('App ready to work offline');
    },
});

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ChakraProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<App />} />
          <Route path="/camera" element={<Camera />} />
          <Route path="/camera.html" element={<Camera />} />
          <Route path="*" element={<App />} />
        </Routes>
      </BrowserRouter>
    </ChakraProvider>
  </React.StrictMode>
);
