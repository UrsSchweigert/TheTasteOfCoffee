# 0013 The cursor signing key is read from Parameter Store at cold start

- Status: proposed
- Date: 2026-11-25
- Decided by: agent (backend-engineer), task M1-T5

## Context

The contract promises cursors that the server signs with an HMAC and rejects if it did not issue them (`Cursor` in contracts/openapi.yaml). The key must not be in the repo (CLAUDE.md, invariant 8). docs/05 names Parameter Store SecureString for secrets. CloudFormation cannot put a SecureString into a Lambda environment variable (`ssm-secure` dynamic references are not supported there), and a plain environment variable would show the key to anyone who can read the function's configuration.

## Decision

- The API Lambda gets the environment variable `CURSOR_KEY_PARAMETER`, the name of a SecureString under `/cupmark/` (for example `/cupmark/<stage>/cursor-key`). Its value is standard base64 of at least 32 random bytes.
- On the first list request after a cold start the function calls `ssm:GetParameter` with `WithDecryption`, checks that the parameter is a `SecureString` holding a key of at least 32 bytes, and keeps the key in memory. It never logs it.
- Without a usable key the list routes answer 500 and neither accept nor issue a cursor (fail closed); the failure is remembered for 60 seconds, after which a list request asks Parameter Store again (one call a minute at most while the key is missing). All other routes keep working.
- The cursor is `base64url(HMAC-SHA256(key, "cupmark-cursor-v1", list, caller, inner))` followed by the repository's own cursor, so it is bound to the list, the caller and the key.

## Alternatives

- **Plain environment variable:** visible in the function configuration and in the template; not a secret any more.
- **AWS Parameters and Secrets Lambda Extension:** no SDK call in the code, but a layer to pin and keep up to date, and its local HTTP endpoint needs a token from the environment.
- **A key derived from something already present:** no such secret exists, and deriving it from the table name or account would make it guessable.

## Consequences

- The backend depends on `@aws-sdk/client-ssm` (Apache-2.0, provided by the Lambda runtime and kept out of the bundle).
- Infra (M1-T2) must create the parameter, or document that the owner creates it, and grant the API role `ssm:GetParameter` on exactly that parameter ARN. The AWS-managed key `alias/aws/ssm` needs no extra grant and no fixed fee (invariant 5). Creating the value is a human step: the key must never pass through the repo or CI logs.
- Rotating the key (replace the value, then let functions restart) invalidates outstanding cursors; clients then get 400 and restart the list. No overlap period is supported.
