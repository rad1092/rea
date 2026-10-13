// Authored for this integration. This file must only be read, never executed.
export const fixtureMetadata = { path: '/quote', currency: 'USD' };
export function quote(quantity) {
  return { total: quantity * 9, currency: 'USD', taxable: true };
}
export function route(request) {
  if (request.path === '/quote') return quote(request.quantity);
  return { error: 'not-found' };
}
