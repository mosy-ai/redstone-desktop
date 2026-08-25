/**
 * "Is the app on its way out?" — asked by the window's close handler, which
 * hides rather than destroys unless the answer is yes.
 *
 * Its own module because both `index.ts` (which sets it) and the window layer
 * (which reads it) need it, and neither should import the other.
 */
let quitting = false;

export function beginQuitting(): void {
  quitting = true;
}

export function isQuitting(): boolean {
  return quitting;
}
