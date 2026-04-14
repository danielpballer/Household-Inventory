import { render } from 'preact';
import { App } from './app.jsx';
import './app.css';

// Register service worker for offline support
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}

render(<App />, document.getElementById('app'));
