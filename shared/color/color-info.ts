/** Source color metadata; null fields mean the selected metadata source did not specify them. */
export type ColorInfo = {
  primaries: string | null;
  transfer: string | null;
  matrix: string | null;
  fullRange: boolean | null;
};
