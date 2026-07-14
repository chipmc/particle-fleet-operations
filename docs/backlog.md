# Backlog

## Current

- Keep Phase 4 Ledger refresh deployment-ready with product-level eligibility for soak product `41915`.
- Use `./tools/telemetry` as the primary operator entry point for device inventory, current state, timeline, and watch workflows.
- Validate `watch` against firmware development and soak sessions, especially serial bursts, lifecycle `status` events, and Ledger snapshot updates.
- Keep V1 watch client-side only: Timeline API polling plus `DeviceCurrentState`, no streaming infrastructure.

## Next

- Deploy Phase 4 Ledger refresh configuration when ready:
  - `PARTICLE_LEDGER_REFRESH_ENABLED=true`
  - `PARTICLE_LEDGER_REFRESH_DEVICE_IDS=`
  - `PARTICLE_LEDGER_REFRESH_PRODUCT_IDS=41915`
  - `PARTICLE_LEDGER_REFRESH_EVENT_NAMES=Ubidots-Sensor-Hook-v1`
  - `PARTICLE_LEDGER_REFRESH_MIN_INTERVAL_SECONDS=60`
- Run post-deploy validation for product-level Ledger refresh using soak devices.
- Exercise `./tools/telemetry watch P2-NewCode-Dev --since 2m` during firmware build/flash cycles.
- Add optional shared terminal color highlighting for `watch` and `timeline`, respecting non-TTY output and `NO_COLOR`.
- Review whether Timeline API needs a first-class server cursor or pagination token after real watch usage.

## Phase 5

- Introduce a dedicated read-only query authentication model instead of reusing the webhook secret.
- Build an operator dashboard or richer UI on top of the current Timeline, Fleet, and CurrentState APIs.
- Add durable query pagination/cursors if operator workflows outgrow client-side polling windows.
- Expand fleet-level soak reporting around lifecycle events, runtime Ledger freshness, serial health, and firmware cohorts.
- Consider alerting/notification workflows after the read model and operator surfaces settle.

## Completed

- Extracted Lambda ingestion from inline CDK into modular TypeScript.
- Added canonical event normalization and DynamoDB timeline/query read paths.
- Added `DeviceCurrentState` projection and Fleet query endpoints.
- Implemented product-qualified `device-status` Particle Ledger refresh.
- Added Ledger refresh gating, cooldown, in-flight de-duplication, product ID caching, and structured logging.
- Added product-level Ledger refresh eligibility through `PARTICLE_LEDGER_REFRESH_PRODUCT_IDS`.
- Built the `./tools/telemetry` operator CLI for `devices`, `device`, and `timeline`.
- Unified enriched device inventory and selector resolution across CLI commands.
- Added `./tools/telemetry watch` as a client-side near-live tail.
- Added watch/timeline category terminology: `SERIAL`, `TELEMETRY`, `OCCUPANCY`, `LIFECYCLE`, `RUNTIME`, `DATA`, `EVENT`, `ERROR`.
- Documented telemetry CLI usage and watch workflows in `docs/tools.md`.
