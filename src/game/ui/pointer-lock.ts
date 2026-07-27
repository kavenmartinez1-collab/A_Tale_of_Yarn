/**
 * pointer-lock.ts — tells "we let go of the mouse" apart from "the player
 * pressed Escape".
 *
 * The browser consumes the first Escape while pointer-locked in order to
 * release the lock, and the keydown never reaches the page. That is why
 * pausing used to be Esc-then-Esc: the first press only exited the lock, the
 * second one opened the menu. The fix is to treat an unrequested loss of the
 * pointer lock AS the pause press — but the game also drops the lock itself,
 * whenever a panel opens or the player dies, and those must not re-open a
 * panel on top of the one that just opened.
 *
 * So every deliberate release goes through `releasePointerLock()`, which raises
 * a flag that the `pointerlockchange` handler consumes. A release with no flag
 * set was the player's — or an alt-tab, which should pause too.
 */

let ours = false;

/** Drop the pointer lock on purpose. */
export function releasePointerLock(): void {
  ours = true;
  document.exitPointerLock();
}

/**
 * Was the release now being reported one we asked for? Consumes the flag, so
 * call it exactly once per `pointerlockchange`.
 */
export function consumeOwnRelease(): boolean {
  const v = ours;
  ours = false;
  return v;
}
