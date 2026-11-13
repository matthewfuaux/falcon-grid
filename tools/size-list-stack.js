// Size check entry for a list install: core + react + cells + list (see .size-limit.json).
// The list is counted once, from its dist; react's import of the package is ignored in .size-limit.json.
export * as core from '../packages/core/dist/index.js';
export * as react from '../packages/react/dist/index.js';
export * as cells from '../packages/cells/dist/index.js';
export * as list from '../packages/list/dist/index.js';
