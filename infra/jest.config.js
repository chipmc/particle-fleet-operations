module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest'
  },
  // `tsc` (via `npm run build`) compiles in place, right next to the .ts sources (no
  // outDir is configured -- this matches the CDK CLI's own default, which is why
  // cdk.json's app entrypoint explicitly runs `ts-node --prefer-ts-exts` to make sure it
  // reads the live .ts source rather than a stale, previously-built .js file sitting
  // beside it). Jest's default moduleFileExtensions order resolves .js before .ts, so
  // without this override it has the identical exposure `--prefer-ts-exts` protects `cdk
  // synth`/`cdk deploy` from: a leftover compiled lib/infra-stack.js from an earlier
  // build can silently shadow a newer .ts edit, so `npm test` alone (no rebuild first)
  // validates stale code while reporting green. Confirmed by reproducing it directly:
  // editing infra-stack.ts without rebuilding left a mutation-tested regression
  // undetected until this override was added.
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  setupFilesAfterEnv: ['aws-cdk-lib/testhelpers/jest-autoclean'],
};
