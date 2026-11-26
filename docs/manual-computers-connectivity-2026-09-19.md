# Manual computers and live connectivity — local validation

> Live deployment completed later on 2026-09-19. See
> [the live release record](manual-entry-live-release-2026-09-19.md).
> Statements below about pending deployment describe the earlier validation stage.

## Implemented

- `/admin/assets`: manual computer list/create/edit for exact `admin` and `super_admin` roles. Admin access is limited to primary/delegated entities; relationship IDs are checked against the resulting entity.
- Computer identity, location, user, technician, group in charge, OS, purchase date, supplier, exact decimal cost, and warranty fields use canonical inventory records. Sparse updates preserve untouched values and allow explicit clearing of optional fields.
- Inventory synchronization preserves manually managed metadata and does not fabricate Salt enrollment IDs.
- Device details fetch inventory without waiting for Salt. History and alerts load only when their tabs are selected.
- Directory and detail connectivity refresh every 15 seconds while visible, on focus/visibility return, and on manual refresh. This is polling, not instantaneous server push.
- Authorized, deduplicated Salt targets are checked with bounded requests. Failed/unconfigured/unmanaged checks display Unknown rather than incorrectly reporting Offline or Online. Inventory age does not establish connectivity.
- Manual stock remains a separate workflow for its existing authorized roles, loads independently, and is not reloaded on every connectivity poll.

## Validation performed

- Full frontend suite: 23 test files passed.
- Frontend TypeScript, lint, and environment-file-disabled production build passed.
- Full offline Go test suite passed.
- Focused connectivity and device-detail race tests passed.
- Local built UI checked in a browser: signed-out access is blocked; fixture-backed super-admin navigation and the complete create form render.

## Not yet performed

- No production deployment, service restart, migration, commit, or push was performed.
- Migration `041_admin_computer_management.sql` must be applied through the approved deployment process before publishing the dependent backend.
- Live PostgreSQL integration, authenticated production workflows, latency measurements, and actual endpoint power-on/reconnection timing remain unverified. Browser checks used synthetic API responses, not production credentials or records.
- Preserve the existing live runtime configuration and database provisioning secrets during deployment. Do not recreate PostgreSQL as part of this feature rollout.

## Follow-up: loading, terminal layout and administration

- Directory inventory now uses `?connectivity=deferred` and renders without waiting for Salt. The separate scoped `/api/devices/directory/connectivity` endpoint updates status; periodic checks no longer reload inventory or stock.
- Operational pages load on demand. The built initial JavaScript chunk decreased from 980.60 kB (273.13 kB gzip) to 178.08 kB (56.98 kB gzip). This measures bundle size, not production response latency.
- Patch target mode, target selection and SLS/CMD controls appear above the execution stream, including mobile layouts. Dashboard metrics no longer block target readiness.
- System includes recorded AnyDesk/RustDesk IDs and network information, with missing values explicitly identified. Refresh reads stored inventory; it does not change endpoint network settings or run a live scan. Windows collection currently provides MAC but no network snapshot.
- Manual asset forms/details separate lifecycle, financial/administrative and warranty sections. Supplier contact details are available from the form.
- `/admin/suppliers` is readable by both admin roles; global supplier creation/editing remains super-admin-only.
- `/admin/scripts` allows both admin roles to manage entity-scoped application installation-script records. Records are storage-only and are not executed, scheduled or published to Salt. Supported types/platforms follow the current shell/SLS vocabulary; PowerShell is not included.
- Pending migration 042 adds script storage. Both 041 and 042 must be reviewed/applied before deploying dependent functionality. See `backend/ADMIN_CATALOG_API.md` for permissions and API contracts.

Final follow-up validation: 453 frontend tests passed, one skipped across 26 files; TypeScript, warning-free lint and environment-file-disabled build passed. Full offline Go suite passed before the final frontend-only code-splitting change. Production deployment, migration, restart, database latency measurement and live endpoint validation were not performed.

## Super-admin Manual Entry workspace

- `/admin/manual-entry` is a separate lazy-loaded workspace with navigation and direct-route access restricted to verified `super_admin`. Existing admin-accessible pages retain their permissions.
- Employee addition/search is available at `/admin/manual-entry/employees`. Creation uses the canonical users API with the employee role fixed in the form. Search is server-side across employee names, emails and employee IDs, with pagination.
- The workspace provides entity, department and branch/location creation forms. Computer lifecycle/financial/warranty records, suppliers, stored scripts and manual stock link to their existing workflows; they are not duplicate tables or new inventory systems.
- Employee creation requires an initial password entered directly into the masked form. It is cleared when sent and on account changes/unmount, never returned in confirmations, and excluded from audit metadata. User creation and primary-entity access creation are transactional.
- All employee and master-data creation endpoints require super-admin on the server; frontend hiding is not the authorization boundary. No migration was introduced by this workspace itself.
- Integrated validation: 491 frontend tests passed, one skipped across 29 files; TypeScript, lint, production build and the full offline Go suite passed. No live records were created and nothing was deployed or restarted.