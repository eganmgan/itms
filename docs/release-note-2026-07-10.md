# ITMS Release Note

Date: 2026-07-10

## Summary

This release introduces a dedicated user resignation workflow across backend APIs and frontend user-management screens. The goal is to make status changes explicit, improve audit clarity, and keep reactivation behavior intact.

## What Changed

- Added a new backend endpoint `POST /api/users/:id/resign` for super admin use.
- Added backend audit action `user_resigned` with user-facing summary text.
- Updated user-management UI copy from "Deactivate" to "Resign" for individual and bulk actions.
- Updated user status workflow calls to use the new resign endpoint.
- Preserved compatibility with existing `user_deactivated` audit labels while adding `user_resigned` label support.
- Updated API route documentation to include the new resign endpoint and mark delete-based deactivate as legacy.

## Post-release UI rollout

Following the core resign workflow release, the entire Users module received a cohesive UI redesign pass across directory, access, assets, audit, employee creation, import/export, and install workflows.

- Redesigned directory and management surfaces for stronger hierarchy and usability.
- Polished bulk access controls and feedback banners for clearer state communication.
- Unified access and audit panel visual language.
- Redesigned employee creation, CSV import/export, and install workspace flows.
- Ran the complete Users component test suite successfully after rollout.

## Outcome

- Resignation intent is now explicit in both API shape and UI language.
- Audit history distinguishes resigned accounts with a dedicated action.
- Frontend users module tests for the updated flow pass.
- Users module now has a consistent enterprise visual system across all primary workflows.

## Reference

Key implementation commit: `2d02d16` (feat(users): add resign workflow and endpoint).

Users redesign rollout commits:

- `c8e971d` (feat(users-ui): redesign directory and management surfaces)
- `c51021b` (feat(users-ui): polish bulk access and feedback surfaces)
- `6cbfa59` (feat(users-ui): unify access and audit panel design)
- `b21331b` (feat(users-ui): redesign employee import and install workspaces)