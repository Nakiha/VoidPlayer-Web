// Theme tokens apply before first paint; the player and decoders stay lazy.
import './themes/silver-glass.css';
import './themes/dark.css';
import './themes/accents.css';
if (!globalThis.isSecureContext || location.pathname === '/connection') {
  const { showConnectionGuide } = await import('./connection-guide.ts');
  await showConnectionGuide({ automatic: location.pathname !== '/connection' });
} else {
  await import('./main.ts');
}
