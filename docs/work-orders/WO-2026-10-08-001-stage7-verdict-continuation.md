<!-- Continuation of Stage 7 round 1 (not a new round): same snapshot, byte-identical to the WO branch (251 tracked files). Codex gpt-6-astra, reasoning high, 2026-10-08.
Deviation from rule (e): the one-line probe hung >3 min without a reply and the run was dispatched before it answered; the model had been accepted twice earlier that day.
Follow-up by Claude Code (local, real sockets): mutating the checker's reason 'no_keys' -> 'no_key' leaves line 353 passing and fails the no_keys assertion at line 354 on its own (expected "no_keys", received "no_key", both consumers). Evidence paths below are Codex's local scratch files and are not kept. -->

VERDICT: PROBLEM

(a) **Deployed entry-point test:** Baseline passes (1 passed, 35 skipped, exit 0), and its per-consumer `no_keys` assertion executes.

With the skip-a-consumer mutation, it fails (exit 1), but **at the preceding topic-list assertion, line 353**, before reaching the `no_keys` assertion at line 354:

```text
expect(received).toEqual(expected) // deep equality

- Expected  - 1
+ Received  + 0

  Array [
    "arn:aws:sns:us-east-1:123456789012:entry-point-test",
-   "arn:aws:sns:us-east-1:123456789012:entry-point-test",
  ]
```

Command, run from `infra`, both before and after mutation, with the preload environment described below:

```sh
/opt/homebrew/opt/node@22/bin/node node_modules/jest/bin/jest.js \
  --runInBand --no-cache --runTestsByPath test/api-key-rotation.test.ts \
  --testNamePattern='the deployed function is the checker'
```

(b) **Handler tests:** Both pass without mutation (2 passed, 3 skipped, exit 0). Both fail with mutation (2 failed, exit 1), from assertions—not transport errors, timeouts, or hook failures.

“every registered consumer is evaluated and reported…” fails at line 101:

```text
expect(received).toEqual(expected) // deep equality

- Expected  - 1
+ Received  + 0

  Array [
    "particle-cloud-webhook",
-   "serial-forwarder",
  ]
```

“a publish failure still attempts every event exactly once…” fails at line 151:

```text
expect(received).toHaveLength(expected)

Expected length: 3
Received length: 1
```

Command, run from `lambda`, both before and after mutation:

```sh
/opt/homebrew/opt/node@22/bin/node node_modules/jest/bin/jest.js \
  --runInBand --no-cache \
  --runTestsByPath src/tests/rotation-checker/handler.test.ts \
  --testNamePattern='every registered consumer is evaluated and reported|a publish failure still attempts every event exactly once'
```

**Preload used:** `/private/tmp/wo-2026-10-08-001-w4akh_r_/transport.cjs`, loaded through these environment settings:

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH
TMPDIR=/private/tmp/wo-2026-10-08-001-w4akh_r_/tmp
NODE_OPTIONS=--require=/private/tmp/wo-2026-10-08-001-w4akh_r_/transport.cjs
```

It replaces `listen(0, '127.0.0.1')` with an in-memory server registration and synthetic address; implements address/close callbacks; and replaces HTTP request transport with Node streams carrying the serialized request bytes into the existing fake server’s request listener. The listener’s status, headers, and response bytes return as a readable stream. Header names are lowercased, request socket-timeout configuration is a no-op, and abort destroys the stream. Real socket connections/listens and HTTPS requests are blocked. It logs only method, path, and response status.

The real SDK serializers, deserializers, and fake endpoint handlers ran unchanged, including SNS HTTP-500 XML error deserialization. No network, AWS calls, or installation occurred.

Initial default-Node launches failed before test execution with `ERR_UNKNOWN_BUILTIN_MODULE: ... node:util/types` and `SyntaxError: Unexpected token '||='`; the reported runs explicitly used installed Node **22.23.1**.

**Mutation:** Only the authorized replacement at `rotation-core.ts:110`:

```diff
-input.consumers.flatMap(
+input.consumers.slice(0, -1).flatMap(
```

No test assertions or fixes were authored.

**Restoration:** All 249 tracked files match their pre-run SHA-256 hashes; the complete tracked diff and status match the originals byte-for-byte. The preload and its temporary directory were removed. The unchanged diff remains **+42/−23**, and `git status --short` shows only:

```text
 M infra/test/api-key-rotation.test.ts
 M infra/test/infra.test.ts
 M lambda/src/tests/rotation-checker/handler.test.ts
```