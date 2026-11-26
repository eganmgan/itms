# React + TypeScript + Vite

## Patch Workspace Redesign (Local, 2026-10-01)

- Patch uses one primary tab row for Salt, SSH, Automation, Report, Logs and
  Audit. Existing routes and browser navigation remain supported.
- Compact metrics precede the console. Target and operation controls sit beside
  output on wide screens and above it on mobile. Department multi-selection
  uses checkboxes; execution still requires explicit review and confirmation.
- SSH endpoints use a searchable table. Automation creation actions sit above
  the saved list; policy fields share an aligned form with one save action.
- Validation: 45 focused tests, typecheck, scoped lint, production build and
  synthetic desktop/mobile checks. No live commands, policy changes or
  production deployment were performed.
- Follow-up: removed the Devices directory Hostname column. Patch department
  choices now include the account-scoped department directory, with device-derived
  names as a fallback and explicit loading, error and empty states.

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.
