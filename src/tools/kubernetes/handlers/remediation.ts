// [WRITE] handlers — typed, whitelisted actions only (never a generic patch tool: that
// would be arbitrary kubectl in disguise). Every handler: zod-validated input →
// server-side namespace guardrail → optional K8s server-side dry run (full validation,
// zero change) → compact old→new result for the approval card.
//
// One module per kind of action (2026-10-21): remediation/workload.ts (restart, image, scale,
// resources, pod delete), rollback.ts (rollout undo), flux.ts (reconcile), orphan.ts (the
// backed-up delete), and shared.ts for the workload read/patch and the GitOps preview. This
// file is the barrel write.ts and the tests import from.
export { findContainer, type GitOpsChange } from "./remediation/shared.js";
export * from "./remediation/workload.js";
export * from "./remediation/rollback.js";
export * from "./remediation/flux.js";
export * from "./remediation/orphan.js";
