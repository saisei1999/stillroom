# Implementation guidance

Build the product described in docs, starting with the vertical slice in milestones. Preserve user data and existing changes. The preview is disposable sample UI, not a storage implementation. Keep dependencies modest and prefer accessible primitives; adopt shadcn/ui when interaction components are needed, Motion only when motion earns its cost. Review licenses for copied components; Animate UI/React Bits are optional, never requirements.

Use strict TypeScript. Keep domain logic, storage and provider adapters independent of React; no secrets in browser bundles. Treat network results and imported files as untrusted. Schema migrations must be explicit and tested against fixtures. Never replace a library on import without validation and a clear confirmation. Avoid misleading offline or backup claims.

For each milestone run `npm test` and `npm run build`; add meaningful tests for data integrity and user workflows. Verify responsive layouts, keyboard access, focus, contrast, screen-reader labels and reduced motion. Update docs and known limitations as behavior changes.

Preferred implementation model: GPT-6.1 Terra Light if the user's Codex interface actually offers it; otherwise choose an available coding model and state the choice. Do not claim this setting was applied unless verified.
