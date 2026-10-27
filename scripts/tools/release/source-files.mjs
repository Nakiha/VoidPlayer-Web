const rootFiles = new Set(['package.json', 'package-lock.json', 'index.html', 'quality.html', 'vite.config.ts', 'tsconfig.json', 'tsconfig.shared.json', '.bun-version', '.gitignore', 'LICENSE', 'README.md', 'AGENTS.md', 'voidplayer.config.example.json', 'public/theme-init.js', 'public/startup-guard.js']);
/** Explicit rebuild inputs; Git's excludes are applied by the caller first. */
export function selectReleaseSources(files) {
  return [...new Set(files)].filter(file => rootFiles.has(file)
    || /^(src|shared|server|admin|scripts|test|docs|examples|locales|public\/licenses|\.github)\//.test(file)
    || /^deploy\/(README\.md|standalone\.md|operations\.md|admin\.md|licenses\/[^/]+)$/.test(file));
}
