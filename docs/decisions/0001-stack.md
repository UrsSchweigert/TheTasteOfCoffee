# 0001 Serverless AWS stack and iOS-only client

- Status: accepted
- Date: 2026-11-24
- Decided by: owner

## Context

The app must cost as little as possible to run, keep data secure and persistent, and launch on iOS.

## Decision

- Client: native iOS (SwiftUI, SwiftData, VisionKit, StoreKit 2). No Android or web client in version 1.
- Backend: Cognito (Lite plan, Sign in with Apple only), API Gateway HTTP API, Lambda (arm64, TypeScript), one DynamoDB table (on-demand, point-in-time recovery), S3, EventBridge Scheduler, in eu-central-1.
- Infrastructure as code with AWS CDK, deployed from GitHub Actions through OIDC.
- No resource with a fixed monthly fee.

## Alternatives

- Relational database (RDS or Aurora): easier ad hoc queries, but a fixed monthly cost and a VPC.
- Third-party backend or subscription services: faster to start, but data leaves the owner's AWS account and adds SDKs.
- Verifying Apple identity tokens in a custom authorizer instead of Cognito: free at any scale, but security code to own. Revisit past 10,000 monthly active users.

## Consequences

- Idle cost is close to zero; see `docs/06-cost-estimate.md`.
- Queries must be designed up front as key lookups and precomputed aggregates.
- Ad hoc analysis goes through the weekly S3 export and Athena.
