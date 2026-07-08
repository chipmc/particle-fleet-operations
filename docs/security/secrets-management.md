# Secrets Management

Secrets must never be committed to this repository or copied into project documentation, issues, pull requests, logs, screenshots, or AI chat sessions.

## Never Commit Plaintext Secrets

Do not commit plaintext credentials, API tokens, webhook secrets, AWS keys, Particle tokens, Ubidots tokens, private keys, passwords, session tokens, or any other secret material.

Do not place secrets directly in:

- CDK source
- Lambda source
- tests
- documentation
- README examples
- comments
- scripts
- shell history examples

Use placeholders in examples, such as:

- `<PARTICLE_ACCESS_TOKEN>`
- `<WEBHOOK_SECRET>`
- `<UBIDOTS_TOKEN>`

Redact tokens in examples and logs. Never include complete real values.

## Local And Development Use

Use environment variables for local and development deployment inputs. Do not hardcode secret values in source files or checked-in configuration.

Examples should show variable names or placeholders only:

```bash
export PARTICLE_ACCESS_TOKEN=<PARTICLE_ACCESS_TOKEN>
export PARTICLE_WEBHOOK_SECRET=<WEBHOOK_SECRET>
```

## Production Secrets

Prefer AWS Secrets Manager or AWS Systems Manager Parameter Store for production secrets.

Lambda environment variables may be used only as an interim step. When Lambda environment variables are used, their values must be sourced from local environment variables or secret stores, never hardcoded in CDK source, Lambda source, tests, documentation, comments, scripts, or examples.

## AI, Issues, Pull Requests, And Logs

Do not paste real secrets into ChatGPT, Claude, Copilot, GitHub issues, pull requests, logs, screenshots, documentation, or any other shared system.

AI agents and project contributors must not infer, invent, preserve, repeat, or reformat secrets from local files, terminal output, screenshots, previous messages, logs, or repository history.

## GitHub Secret Scanning Alerts

Treat every GitHub secret scanning alert as credential compromise unless proven otherwise by Chip.

Do not dismiss a secret scanning alert as a false positive without review.

### Local Operator Secret Cache

For local development and emergency rotation:

~/.particle-log-monitoring/secrets.env

Managed by:

~/Documents/Maker/Particle/ops/ParticleTokenRotation.sh

Not committed.
Not synced.
Local-only.

## If A Secret Is Committed

If a secret is committed or otherwise exposed:

1. Revoke the exposed credential immediately.
2. Replace or rotate the credential.
3. Remove the secret from source, documentation, tests, examples, and logs.
4. Redeploy with the new secret.
5. Purge Git history if the secret was exposed publicly.
6. Notify the security team with a remediation summary.

Continue implementation only after the exposure is reported and the immediate containment steps are understood.