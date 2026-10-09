/** Native :focus-visible also turns on when a playback shortcut follows a mouse
 * click. Only keyboard navigation should opt into the shared focus material;
 * keep DOM focus intact for subsequent navigation and accessible activation. */
export function installFocusFeedback(signal: AbortSignal) {
  const root = document.documentElement;
  let pointerRevision = 0;
  const clear = () => { ++pointerRevision; delete root.dataset.keyboardNavigation; };
  document.addEventListener('pointerdown', clear, { capture: true, signal });
  document.addEventListener('keydown', event => {
    // Option+Tab is macOS WebKit's native navigation through all controls.
    if (event.isComposing || event.metaKey || event.ctrlKey || (event.altKey && event.key !== 'Tab')) return;
    if (['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
      const focused = document.activeElement;
      const revision = pointerRevision;
      setTimeout(() => {
        // Custom menus move focus while preventing native navigation. Transport
        // arrow shortcuts prevent it without moving focus and should stay inert.
        if (!signal.aborted && revision === pointerRevision && (!event.defaultPrevented || document.activeElement !== focused)) {
          root.dataset.keyboardNavigation = '';
        }
      }, 0);
    }
  }, { capture: true, signal });
  signal.addEventListener('abort', clear, { once: true });
}
