if(new URL(location.href).searchParams.has('cambi'))await import('./cambi-view.ts');else await import('./quality-pair-view.ts');
export {};
