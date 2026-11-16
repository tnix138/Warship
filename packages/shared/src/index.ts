/**
 * `@warship/shared` — the single source of truth for anything both ends must agree on.
 *
 * Import rules:
 *  - must stay isomorphic (browser + Node, no `node:*`, no DOM),
 *  - constants and types only in this milestone — no runtime logic yet,
 *  - never import `@warship/server` or `@warship/client` from here.
 */

export * from './constants.js';
export * from './protocol.js';
export * from './upgrades.js';
export * from './combat.js';
export * from './formulas.js';
