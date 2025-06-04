import React from 'react';
import ReactDOM from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Camera from './Camera/Camera';
import { ChakraProvider } from '@chakra-ui/react';

const root = document.getElementById('root');
if (root === null) {
    throw new Error("Could not find root node.");
}

registerSW();

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
