// A build-time choice, never inferred from a missing service or a URL parameter.
// Optional env keeps host-independent Node callers on the full application path.
export const localOnly = import.meta.env?.MODE === 'sites';
