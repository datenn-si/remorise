import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { applyStoredTheme } from './lib/preferences';
import './index.css';

applyStoredTheme();

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Offline support is best-effort; the app works without it.
    });
  });
}

const root = document.getElementById('root');
if (!root) throw new Error('root element is missing');

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
