export const hdrDisplayAvailable = () => typeof matchMedia !== 'undefined' && matchMedia('(dynamic-range: high)').matches;
