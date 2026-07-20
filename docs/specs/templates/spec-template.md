# Specification Template

Use this template for feature, system, API, data, operations, and compliance specs.
Remove sections that are not applicable.

## 1. Title And Metadata

- Spec title
- Spec type
- Status (draft/review/approved)
- Owner(s)
- Reviewers
- Last updated date

## 2. Problem Statement

- Current pain/problem
- Why this matters now
- Desired outcome

## 3. Goals And Non-Goals

- Goals
- Non-goals

## 4. Scope

- In scope
- Out of scope

## 5. Context And Dependencies

- Existing systems/processes
- Upstream/downstream dependencies
- External constraints

## 6. Requirements

List requirements as `REQ-###`.
Each requirement must be testable.

Fields per requirement:

- ID
- Statement
- Rationale
- Priority (must/should/could)
- Validation method

## 7. User/System Flows

- Primary flow(s)
- Alternate/error flows

## 8. Data/Interface Contracts

- Inputs/outputs
- Schemas or payload contracts
- Backward compatibility constraints

## 9. Observability And Operations

- Logging/metrics/tracing expectations
- Alerting thresholds
- Operational runbooks

## 10. Security, Privacy, And Compliance

- Data classification
- Access model
- Compliance constraints

## 11. Acceptance Criteria

Use executable-style criteria where possible.
Example format:

- Given [state], when [action], then [observable result]

## 12. Risks And Mitigations

- Risk list
- Mitigation strategy
- Rollback approach

## 13. Rollout Plan

- Milestones
- Flags/gates
- Migration or backfill

## 14. Open Questions

- Blocking questions
- Non-blocking follow-ups
