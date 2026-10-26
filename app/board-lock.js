// Compatibility seam: the controller, storage, keypad and gestures live in core.
import { getAppLock, configureLock, HOLD_MS } from "../lib/app-lock.js";
export const readLock = () => getAppLock()?.read() || null;
export const isLocked = () => !!getAppLock()?.isLocked();
export function syncLock() { getAppLock()?.sync(); }
export function mountLockButton({ strip, settings }) {
  if (settings) configureLock(settings);
  // The shared door bar already mounted this app's one adult lock control.
  const button = strip?.closest(".msgbar")?.querySelector(".app-lock-control") || null;
  if (button) { strip.append(button); button.classList.add('app-lock-in-strip'); }
  return button;
}
window.__lockTest = { readLock, holdMs: HOLD_MS };
