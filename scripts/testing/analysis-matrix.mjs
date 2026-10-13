/** Partition the full matrix into disjoint CI cells without reducing coverage. */
export function selectAnalysisMatrixRows(rows, args = []) {
  const choices = args.filter(arg => arg.startsWith('--matrix-part='));
  if (choices.length > 1) throw new Error('Choose one analysis matrix partition');
  const part = choices[0]?.slice('--matrix-part='.length);
  if (part !== undefined && !['mp4', 'flv-legacy', 'flv-enhanced'].includes(part)) throw new Error('Unknown analysis matrix partition');
  if (part && args.includes('--flv-only')) throw new Error('Choose one analysis matrix filter');
  return rows.filter(row => part === 'mp4' ? row.container === 'mp4'
    : part ? row.container === 'flv' && row.framing === part.slice(4)
    : !args.includes('--flv-only') || row.container === 'flv');
}
