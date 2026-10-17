// Stable behavior groups, independent of script paths and CI job names.
export const analysisResponsibilities = {
  navigation: { layer: 'browser-interaction', purpose: 'Range editing, zoom anchoring, seek separation and reference hierarchy', stages: ['navigation'], fixtures: ['incremental', 'references'] },
  layout: { layer: 'browser-interaction', purpose: 'Chart mounting, row geometry, scrolling and first-paint stability', stages: ['layout'], fixtures: ['streams'] },
  overlay: { layer: 'browser-interaction', purpose: 'Overlay controls, hover details, opacity and track isolation', stages: ['layout'], fixtures: ['streams'] },
  matrix: { layer: 'media-integration', purpose: 'Real codec/input/decode-policy matrix, pixel identity and cache/range contracts', stages: ['matrix'], fixtures: [] },
  diagrams: { layer: 'media-integration', purpose: 'Visible-GOP execution, concurrency, chart gestures, multi-track isolation and limitations', stages: ['streams', 'concurrency', 'charts', 'multitrack', 'limitations'], fixtures: ['streams', 'incremental', 'queues', 'depths'] },
  index: { layer: 'media-integration', purpose: 'Partial FLV index continuation, pause/resume and cancellation without false EOF', stages: ['index'], fixtures: ['incremental', 'index-flv'] },
};

export function parseAnalysisOptions(args) {
  const [engine = 'webkit', ...flags] = args;
  if (!['webkit', 'chromium'].includes(engine)) throw new Error(`Unknown analysis browser: ${engine}`);
  const modes = { '--navigation-only': 'navigation', '--layout-only': 'layout', '--overlay-only': 'overlay', '--matrix-only': 'matrix', '--diagrams-only': 'diagrams', '--incremental-only': 'index' };
  const chosen = flags.filter(flag => modes[flag]);
  if (chosen.length > 1) throw new Error('Choose only one analysis case mode');
  const value = prefix => {
    const matches = flags.filter(flag => flag.startsWith(prefix));
    if (matches.length > 1 || matches.some(flag => flag.length === prefix.length)) throw new Error(`Choose one value for ${prefix}`);
    return matches[0]?.slice(prefix.length);
  };
  const matrixPart = value('--matrix-part='), matrixFixture = value('--matrix-fixture=');
  for (const flag of flags) if (!modes[flag] && !['--checkpoint-only', '--playback-profile', '--desktop-performance', '--flv-only'].includes(flag) && !flag.startsWith('--matrix-part=') && !flag.startsWith('--matrix-fixture=')) throw new Error(`Unknown analysis option: ${flag}`);
  const scenarios = chosen.length ? [modes[chosen[0]]] : ['matrix', 'diagrams', 'index'];
  if (matrixPart && !['mp4', 'flv-legacy', 'flv-enhanced', 'fmp4', 'ts'].includes(matrixPart)) throw new Error('Unknown analysis matrix partition');
  if (matrixPart && (scenarios.length !== 1 || scenarios[0] !== 'matrix')) throw new Error('Matrix partition requires matrix mode');
  if (matrixPart && flags.includes('--flv-only')) throw new Error('Choose one analysis matrix filter');
  const desktopPerformance = flags.includes('--desktop-performance');
  if (desktopPerformance && (engine !== 'chromium' || scenarios.length !== 1 || scenarios[0] !== 'matrix' || matrixPart !== 'ts')) throw new Error('Desktop performance is an explicit Chromium TS matrix check');
  return { engine, scenarios, matrixPart, matrixFixture, desktopPerformance, checkpointOnly: flags.includes('--checkpoint-only'), playbackProfile: flags.includes('--playback-profile'), flags };
}
