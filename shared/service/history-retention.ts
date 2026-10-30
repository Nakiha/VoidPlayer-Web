/** Public limits keep legacy historyRows for wire compatibility. It is not
 * enforced and must never determine a query's independent snapshot budget. */
export const BYTE_HISTORY_RETENTION = Object.freeze({
  policy:'logical-byte-budget',
  legacyHistoryRows:'deprecated-not-enforced',
} as const);
