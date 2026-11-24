import { setColorMode, setReferenceDecode } from '../media/policy/color-mode.ts';

export let savedStartupColorMode: 'reference' | 'browser' = 'browser';

/** Restore the same decode preferences before either the shell or a file launch can open media. */
export function restoreStartupDecode() {
  try {
    const saved = localStorage.getItem('voidplayer.reference-decode');
    if (saved) {
      const { depth } = JSON.parse(saved);
      setReferenceDecode({ decoder: 'hardware', depth });
      localStorage.setItem('voidplayer.reference-decode', JSON.stringify({ depth }));
    }
  } catch { /* Keep the built-in decoder settings. */ }
  try { if (localStorage.getItem('voidplayer.color-mode') === 'reference') savedStartupColorMode = 'reference'; }
  catch { /* Storage may be unavailable. */ }
  // Explicit diagnostic URLs retain their original backend-selection semantics.
  if (!new URLSearchParams(location.search).has('colorPipeline')) setColorMode(savedStartupColorMode);
}
