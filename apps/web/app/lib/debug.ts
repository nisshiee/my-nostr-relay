const debugFlags = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '').get('debug')?.split(',') ?? [];
export const DEBUG = {
  gravity: debugFlags.includes('gravity'),
  layout: debugFlags.includes('layout'),
  scoring: debugFlags.includes('scoring'),
  any: debugFlags.length > 0,
};
