import foreground from '/icon-foreground.svg?raw';

// Use the exported G2 paths so the assembled mark matches the app icon.
export const aboutMark = foreground.replace('<svg ', '<svg class="about-mark" aria-hidden="true" focusable="false" ')
  .replaceAll('<g id="', '<g data-tile="').replaceAll('id="layer-', 'id="about-layer-').replaceAll('url(#layer-', 'url(#about-layer-');

export const aboutFrameGraph = `<svg class="about-frame-graph" viewBox="0 0 284 96" aria-hidden="true" focusable="false">
  <g class="about-frame-links" fill="none" stroke="currentColor" stroke-width="1.3">
    <path d="M8 71 46 49 84 71 122 49 160 71 198 49 236 71 274 49 M8 71H274"/>
    <path d="M8 71 27 32 46 49 65 32 84 71 103 32 122 49 141 32 160 71 179 32 198 49 217 32 236 71 255 32 274 49"/>
  </g>
  <g class="about-frame-nodes">
    <circle fill="#edb346" cx="8" cy="71" r="3.5"/>
    <g fill="#6389df">${[84,160,236].map(x => `<circle cx="${x}" cy="71" r="3.5"/>`).join('')}</g>
    <g fill="#9784d7">${[46,122,198,274].map(x => `<circle cx="${x}" cy="49" r="3"/>`).join('')}
      ${[27,65,103,141,179,217,255].map(x => `<circle cx="${x}" cy="32" r="2.6"/>`).join('')}</g>
  </g>
</svg>`;
