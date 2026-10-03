/** The server counts UTF-16 code units, while truncation must keep user graphemes intact. */
export function workspaceCopyName(name: string, format: (name: string) => string): string {
  const budget = 200 - format('').length;
  let prefix = '';
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(name.trim())) {
    if (prefix.length + segment.length > budget) break;
    prefix += segment;
  }
  return format(prefix.trimEnd()).trim();
}
