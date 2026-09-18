'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildDeleteItemArgs,
  renderShellCommand,
  parseArgs,
  EXIT_GENERIC_ERROR,
  EXIT_EXECUTION_RUNNING,
  EXIT_CONDITION_FAILED,
} = require('./archive-lock-release');

const scriptPath = path.join(__dirname, 'archive-lock-release');

const OWNER_EXECUTION_ARN = 'arn:aws:states:us-east-1:123456789012:execution:MonthlyLogArchive:run-a';

test('prints usage and exits 0 with --help', () => {
  const result = runTool(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: archive-lock-release/);
});

test('prints usage and exits 0 with no arguments', () => {
  const result = runTool([]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: archive-lock-release/);
});

test('rejects missing required arguments before touching the network', () => {
  const result = runTool(['--fencing-token', '3', '--ticket', 'INC-1']);
  assert.equal(result.status, EXIT_GENERIC_ERROR);
  assert.match(result.stderr, /--owner-execution-arn is required/);
});

test('rejects a non-numeric fencing token', () => {
  const result = runTool(['--owner-execution-arn', OWNER_EXECUTION_ARN, '--fencing-token', 'abc', '--ticket', 'INC-1']);
  assert.equal(result.status, EXIT_GENERIC_ERROR);
  assert.match(result.stderr, /--fencing-token must be a non-negative integer/);
});

test('buildDeleteItemArgs produces the exact condition expression and ALL_OLD return values', () => {
  const args = buildDeleteItemArgs({ ownerExecutionArn: OWNER_EXECUTION_ARN, fencingToken: 7 }, 'ArchiveCoordination');
  assert.deepEqual(args, [
    'dynamodb', 'delete-item',
    '--table-name', 'ArchiveCoordination',
    '--key', JSON.stringify({ PK: { S: 'LOCK#monthly-archive' }, SK: { S: 'METADATA' } }),
    '--condition-expression', 'ownerExecutionArn = :arn AND fencingToken = :token',
    '--expression-attribute-values', JSON.stringify({ ':arn': { S: OWNER_EXECUTION_ARN }, ':token': { N: '7' } }),
    '--return-values', 'ALL_OLD',
    '--output', 'json',
  ]);
});

test('parseArgs threads --profile and --region into subsequent AWS CLI calls', () => {
  const options = parseArgs([
    '--owner-execution-arn', OWNER_EXECUTION_ARN,
    '--fencing-token', '2',
    '--ticket', 'INC-2',
    '--profile', 'ops',
    '--region', 'us-west-2',
  ]);
  const args = buildDeleteItemArgs(options, 'ArchiveCoordination');
  assert.ok(args.includes('--profile') && args.includes('ops'));
  assert.ok(args.includes('--region') && args.includes('us-west-2'));
});

test('a RUNNING execution is refused before any delete is attempted', async t => {
  const { env, calls } = await fakeAwsFixture(t, { executionStatus: 'RUNNING' });
  const result = runTool([
    '--owner-execution-arn', OWNER_EXECUTION_ARN,
    '--fencing-token', '5',
    '--ticket', 'INC-3',
    '--table', 'ArchiveCoordination',
  ], env);

  assert.equal(result.status, EXIT_EXECUTION_RUNNING);
  assert.match(result.stderr, /still RUNNING/);
  const calledCommands = readCalls(calls);
  assert.ok(calledCommands.every(call => call[0] !== 'dynamodb' || call[1] !== 'delete-item'),
    'delete-item must never be invoked once the execution is found RUNNING');
});

test('owner/fencing-token mismatch is refused, and the failure output never claims success', async t => {
  const { env, calls } = await fakeAwsFixture(t, {
    executionStatus: 'FAILED',
    deleteItemResult: { conditionalCheckFailed: true },
  });
  const result = runTool([
    '--owner-execution-arn', OWNER_EXECUTION_ARN,
    '--fencing-token', '5',
    '--ticket', 'INC-4',
    '--table', 'ArchiveCoordination',
  ], env);

  assert.equal(result.status, EXIT_CONDITION_FAILED);
  assert.match(result.stderr, /was NOT applied/);
  assert.doesNotMatch(result.stdout, /Released archive lock/);
  const calledCommands = readCalls(calls);
  assert.ok(calledCommands.some(call => call[0] === 'dynamodb' && call[1] === 'delete-item'),
    'the delete was attempted (and the AWS-side condition rejected it)');
});

test('succeeds only when the execution is terminal and the delete-item condition matches', async t => {
  const { env } = await fakeAwsFixture(t, {
    executionStatus: 'FAILED',
    deleteItemResult: { attributes: { PK: { S: 'LOCK#monthly-archive' }, SK: { S: 'METADATA' }, ownerExecutionArn: { S: OWNER_EXECUTION_ARN }, fencingToken: { N: '5' } } },
  });
  const result = runTool([
    '--owner-execution-arn', OWNER_EXECUTION_ARN,
    '--fencing-token', '5',
    '--ticket', 'INC-5',
    '--table', 'ArchiveCoordination',
  ], env);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Released archive lock/);
  assert.match(result.stdout, /INC-5/);
  const payload = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
  assert.equal(payload.ticket, 'INC-5');
  assert.equal(payload.fencingToken, 5);
  assert.equal(payload.previousItem.ownerExecutionArn, OWNER_EXECUTION_ARN);
});

test('--dry-run prints the exact command and never invokes the delete', async t => {
  const { env, calls } = await fakeAwsFixture(t, { executionStatus: 'FAILED' });
  const result = runTool([
    '--owner-execution-arn', OWNER_EXECUTION_ARN,
    '--fencing-token', '5',
    '--ticket', 'INC-6',
    '--table', 'ArchiveCoordination',
    '--dry-run',
  ], env);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Dry run/);
  assert.match(result.stdout, /aws dynamodb delete-item/);
  assert.match(result.stdout, /--condition-expression/);
  const calledCommands = readCalls(calls);
  assert.ok(calledCommands.every(call => call[0] !== 'dynamodb' || call[1] !== 'delete-item'),
    'dry-run must never invoke delete-item');
});

test('renderShellCommand quotes values containing special characters for safe copy-paste display', () => {
  const rendered = renderShellCommand(['dynamodb', 'delete-item', '--expression-attribute-values', '{":arn":{"S":"x"}}']);
  assert.match(rendered, /^aws dynamodb delete-item --expression-attribute-values '/);
});

test('--table skips CloudFormation stack lookup entirely', async t => {
  const { env, calls } = await fakeAwsFixture(t, {
    executionStatus: 'FAILED',
    deleteItemResult: { attributes: { ownerExecutionArn: { S: OWNER_EXECUTION_ARN }, fencingToken: { N: '5' } } },
  });
  const result = runTool([
    '--owner-execution-arn', OWNER_EXECUTION_ARN,
    '--fencing-token', '5',
    '--ticket', 'INC-7',
    '--table', 'ExplicitTable',
    '--dry-run',
  ], env);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /ExplicitTable/);
  const calledCommands = readCalls(calls);
  assert.ok(calledCommands.every(call => !(call[0] === 'cloudformation' && call[1] === 'describe-stacks')),
    'an explicit --table must skip the CloudFormation describe-stacks lookup');
});

function runTool(args, env = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      ...env,
    },
  });
}

function readCalls(callsPath) {
  if (!fs.existsSync(callsPath)) return [];
  return fs.readFileSync(callsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

async function fakeAwsFixture(t, { executionStatus, deleteItemResult = {} }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-lock-release-fixture-'));
  const callsPath = path.join(tempDir, 'calls.ndjson');
  const awsPath = path.join(tempDir, 'aws');

  fs.writeFileSync(awsPath, `#!/usr/bin/env node
'use strict';
const fs = require('fs');

const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n');

if (args[0] === 'stepfunctions' && args[1] === 'describe-execution') {
  process.stdout.write(JSON.stringify({ status: ${JSON.stringify(executionStatus)} }));
  process.exit(0);
}

if (args[0] === 'cloudformation' && args[1] === 'describe-stacks') {
  process.stdout.write(JSON.stringify({
    Stacks: [{ Outputs: [{ OutputKey: 'ArchiveCoordinationTableName', OutputValue: 'ArchiveCoordination' }] }],
  }));
  process.exit(0);
}

if (args[0] === 'dynamodb' && args[1] === 'delete-item') {
  const result = ${JSON.stringify(deleteItemResult)};
  if (result.conditionalCheckFailed) {
    process.stderr.write('An error occurred (ConditionalCheckFailedException) when calling the DeleteItem operation');
    process.exit(255);
  }
  process.stdout.write(JSON.stringify({ Attributes: result.attributes || undefined }));
  process.exit(0);
}

process.stderr.write('unsupported aws fixture call: ' + args.join(' '));
process.exit(1);
`, { mode: 0o755 });

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  return {
    env: { PATH: `${tempDir}:${process.env.PATH}` },
    calls: callsPath,
  };
}
