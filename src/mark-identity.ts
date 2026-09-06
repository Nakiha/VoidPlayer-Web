// Derived from the saved ID, never from list order, text or playback position.
const COLORS = ['#c84440', '#b36b16', '#488027', '#168177', '#246ac1', '#5662bb', '#8051b7', '#b23f79'] as const;
const SHAPES = ['pentagon', 'square', 'triangle', 'diamond', 'circle'] as const;
export function markIdentity(id: string) {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619) >>> 0;
  return { color: COLORS[hash % COLORS.length], shape: SHAPES[Math.floor(hash / COLORS.length) % SHAPES.length] };
}
