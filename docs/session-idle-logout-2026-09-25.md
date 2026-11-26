# Ten-minute browser inactivity logout

Deployed frontend-only on September 25, 2026 at 12:14 UTC.

The authenticated application signs out after ten minutes without pointer,
keyboard, touch, scrolling or wheel activity. Background API polling does not
extend the deadline. Activity is shared across same-origin ITMS tabs through
the non-secret `itms-last-activity` localStorage timestamp. Reloading preserves
the deadline; a new successful login starts a fresh one. Existing sessions
without a timestamp start the deadline when this frontend first loads.

Timers and focus, visibility and page-show checks use wall-clock time, so a
sleeping tab checks expiry on resumption before accepting new activity. Browser
timer suspension can delay execution while the tab is suspended.

Manual and inactivity logout share session cleanup, clear stored user and
assistant data, and immediately replace the route with `/login`. Revocation is
requested through the existing logout API without blocking the redirect on
network success. Token removal in another tab also redirects. Back/forward
navigation without a token returns to login and cannot restore protected data.

This is a browser inactivity policy, not a server-enforced idle timeout. It does
not change JWT lifetimes, add a universal HTTP 401 handler, or guarantee server
revocation while offline. The login notice reflects the ten-minute policy.

Validation: 781 frontend tests passed, two skipped across 35 files; TypeScript,
scoped lint and production build passed. Coverage includes the exact ten-minute
boundary, activity resets, cross-tab updates/removal, remounts, sleeping tabs,
fresh login, timer cleanup, failed logout requests and stale privileged responses.
Isolated browser checks at 1440px and 390px verified expiry-on-focus, manual
logout, history protection, storage cleanup and no horizontal overflow. Browser
expiry was simulated by aging the timestamp; exact timing uses fake-clock tests.
No production login/logout or business-record changes were performed.

All 43 static files passed HTTP byte verification. The live browser loaded
`assets/index-CxaQHhb3.js` and displayed the ten-minute notice. HTML SHA-256:
`79cd63f462220822cb101ff78b50dd9b2992d13d1a5635ff3d82f786987d4888`.
The frontend deployment preserved backend/PostgreSQL identities and installer
hashes. The synthetic preview was stopped and its test storage cleared.
Fresh frontend backup, source/build manifests and deployment result are private
under `~/.local/state/itms/releases/idle-logout-20260925`. Publication retained
old hashed assets and automatically restores the previous index on verification
failure. Restore frontend only; do not restore the database for a UI rollback.