#!/usr/bin/env sh
set -eu

SOURCE_ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/particle-commit-test.XXXXXX")"
REAL_GIT="$(command -v git)"
PASS_COUNT=0

cleanup() {
  rm -rf "${TEST_ROOT}"
}
trap cleanup EXIT HUP INT TERM

fail_test() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_contains() {
  file="$1"
  pattern="$2"
  grep -Eq -- "${pattern}" "${file}" || fail_test "Expected ${file} to contain: ${pattern}"
}

assert_not_contains() {
  file="$1"
  pattern="$2"
  if grep -Eq -- "${pattern}" "${file}"; then
    fail_test "Expected ${file} not to contain: ${pattern}"
  fi
}

assert_equals() {
  actual="$1"
  expected="$2"
  [ "${actual}" = "${expected}" ] || fail_test "Expected '${expected}', got '${actual}'"
}

assert_match_count() {
  file="$1"
  pattern="$2"
  expected="$3"
  actual="$(grep -Ec -- "${pattern}" "${file}" || true)"
  [ "${actual}" = "${expected}" ] || fail_test "Expected ${expected} matches for '${pattern}' in ${file}, got ${actual}"
}

assert_before() {
  file="$1"
  first_pattern="$2"
  second_pattern="$3"
  first_line="$(grep -n -m 1 -E -- "${first_pattern}" "${file}" | cut -d: -f1)"
  second_line="$(grep -n -m 1 -E -- "${second_pattern}" "${file}" | cut -d: -f1)"
  [ -n "${first_line}" ] && [ -n "${second_line}" ] && [ "${first_line}" -lt "${second_line}" ] ||
    fail_test "Expected '${first_pattern}' before '${second_pattern}' in ${file}"
}

new_repo() {
  name="$1"
  repo="${TEST_ROOT}/${name}"
  mkdir -p "${repo}/tools" "${repo}/lambda" "${repo}/scripts" "${repo}/infra" "${repo}/docs" "${repo}/fake-bin"
  cp "${SOURCE_ROOT}/tools/commit" "${repo}/tools/commit"
  chmod +x "${repo}/tools/commit"
  printf '%s\n' "'use strict';" > "${repo}/tools/telemetry"
  printf '%s\n' "'use strict';" > "${repo}/tools/telemetry.test.js"
  printf '%s\n' '# Fixture' > "${repo}/README.md"

  "${REAL_GIT}" -C "${repo}" init -q -b main
  "${REAL_GIT}" -C "${repo}" config user.name 'Commit Helper Test'
  "${REAL_GIT}" -C "${repo}" config user.email 'commit-helper@example.invalid'
  "${REAL_GIT}" -C "${repo}" remote add origin 'git@github.com:chipmc/particle-fleet-operations.git'

  cat > "${repo}/fake-bin/node" <<'EOF'
#!/usr/bin/env sh
printf 'node %s\n' "$*" >> "${TEST_COMMAND_LOG}"
printf '%s\n' 'CAPTURED_NODE_VALIDATION_OUTPUT'
case "node $*" in
  *'--test'*) printf '%s\n' 'tests 100' ;;
esac
case "node $*" in
  *"${MOCK_FAIL_MATCH:-__never__}"*) exit 23 ;;
esac
exit 0
EOF
  cat > "${repo}/fake-bin/npm" <<'EOF'
#!/usr/bin/env sh
printf 'npm cwd=%s %s\n' "$PWD" "$*" >> "${TEST_COMMAND_LOG}"
printf '%s\n' 'CAPTURED_NPM_VALIDATION_OUTPUT'
case "npm $*" in
  *"${MOCK_FAIL_MATCH:-__never__}"*) exit 24 ;;
esac
exit 0
EOF
  cat > "${repo}/fake-bin/git" <<'EOF'
#!/usr/bin/env sh
if [ "${1:-}" = push ]; then
  printf '%s\n' 'PUSH_CALLED' >> "${TEST_COMMAND_LOG}"
  exit 25
fi
if [ "${1:-}" = branch ] && [ "${2:-}" = --show-current ]; then
  printf '%s\n' 'UNSUPPORTED_BRANCH_SHOW_CURRENT_CALLED' >> "${TEST_COMMAND_LOG}"
  exit 26
fi
exec "${REAL_GIT}" "$@"
EOF
  chmod +x "${repo}/fake-bin/node" "${repo}/fake-bin/npm" "${repo}/fake-bin/git"
  "${REAL_GIT}" -C "${repo}" add --all
  "${REAL_GIT}" -C "${repo}" commit -q -m 'fixture baseline'
  "${REAL_GIT}" -C "${repo}" update-ref refs/remotes/origin/main HEAD
  repo="$(CDPATH= cd -- "${repo}" && pwd -P)"
  printf '%s\n' "${repo}"
}

run_helper() {
  repo="$1"
  input="$2"
  shift 2
  fixture_name="$(basename "${repo}")"
  output="${TEST_ROOT}/${fixture_name}.output.log"
  command_log="${TEST_ROOT}/${fixture_name}.commands.log"
  : > "${command_log}"
  set +e
  printf '%b' "${input}" | (
    cd "${HELPER_CWD:-${repo}}"
    PATH="${repo}/fake-bin:${PATH}" \
      REAL_GIT="${REAL_GIT}" \
      TEST_COMMAND_LOG="${command_log}" \
      MOCK_FAIL_MATCH="${MOCK_FAIL_MATCH:-}" \
      "${repo}/tools/commit" "$@"
  ) > "${output}" 2>&1
  status=$?
  set -e
  printf '%s\n' "${status}"
}

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf 'PASS: %s\n' "$1"
}

repo="$(new_repo missing-message)"
status="$(run_helper "${repo}" '')"
[ "${status}" -ne 0 ] || fail_test 'missing commit message should fail'
assert_contains "${TEST_ROOT}/missing-message.output.log" 'non-empty commit message is required'
pass 'missing commit message'

repo="$(new_repo clean-worktree)"
status="$(run_helper "${repo}" '' 'Clean tree')"
[ "${status}" -ne 0 ] || fail_test 'clean worktree should fail'
assert_contains "${TEST_ROOT}/clean-worktree.output.log" 'There are no changes to commit'
pass 'clean worktree'

repo="$(new_repo detached-head)"
"${REAL_GIT}" -C "${repo}" checkout -q --detach HEAD
printf '%s\n' 'change' > "${repo}/docs/example.md"
status="$(run_helper "${repo}" '' 'Detached change')"
[ "${status}" -ne 0 ] || fail_test 'detached HEAD should fail'
assert_contains "${TEST_ROOT}/detached-head.output.log" '^Branch: HEAD$'
assert_contains "${TEST_ROOT}/detached-head.output.log" 'Detached HEAD is not supported'
pass 'detached HEAD refusal'

repo="$(new_repo tools-selection)"
printf '%s\n' 'change' > "${repo}/tools/example.txt"
mkdir -p "${repo}/nested/work"
HELPER_CWD="${repo}/nested/work" status="$(run_helper "${repo}" 'cancel\n' 'Tools change')"
unset HELPER_CWD
assert_equals "${status}" 0
assert_contains "${TEST_ROOT}/tools-selection.output.log" '^Repository: tools-selection$'
assert_contains "${TEST_ROOT}/tools-selection.output.log" '^Branch: main$'
assert_contains "${TEST_ROOT}/tools-selection.output.log" '^✓ CLI syntax$'
assert_contains "${TEST_ROOT}/tools-selection.output.log" '^✓ CLI tests \(100 passed\)$'
assert_contains "${TEST_ROOT}/tools-selection.output.log" '^✓ Whitespace$'
assert_contains "${TEST_ROOT}/tools-selection.output.log" '^  tools/example\.txt$'
assert_contains "${TEST_ROOT}/tools-selection.output.log" '^1 file changed$'
assert_contains "${TEST_ROOT}/tools-selection.output.log" '^1 insertion$'
assert_match_count "${TEST_ROOT}/tools-selection.output.log" 'tools/example\.txt' 1
assert_contains "${TEST_ROOT}/tools-selection.output.log" 'all      Stage every file listed above'
assert_contains "${TEST_ROOT}/tools-selection.output.log" 'files    Choose files by number'
assert_contains "${TEST_ROOT}/tools-selection.output.log" 'changes  Review and choose individual changes'
assert_before "${TEST_ROOT}/tools-selection.output.log" '^  tools/example\.txt$' '^How would you like to prepare this commit\?$'
assert_not_contains "${TEST_ROOT}/tools-selection.output.log" 'CAPTURED_NODE_VALIDATION_OUTPUT'
assert_not_contains "${TEST_ROOT}/tools-selection.output.log" '^Changes$|^Files available to commit$'
assert_contains "${TEST_ROOT}/tools-selection.commands.log" '^node --check tools/telemetry$'
assert_contains "${TEST_ROOT}/tools-selection.commands.log" '^node --test tools/telemetry\.test\.js$'
assert_not_contains "${TEST_ROOT}/tools-selection.commands.log" '^npm '
assert_not_contains "${TEST_ROOT}/tools-selection.commands.log" 'UNSUPPORTED_BRANCH_SHOW_CURRENT_CALLED'
pass 'tools validation selection and subdirectory root resolution'

repo="$(new_repo lambda-selection)"
printf '%s\n' 'change' > "${repo}/lambda/example.ts"
status="$(run_helper "${repo}" 'cancel\n' 'Lambda change')"
assert_equals "${status}" 0
assert_contains "${TEST_ROOT}/lambda-selection.commands.log" "npm cwd=${repo}/lambda run build"
assert_contains "${TEST_ROOT}/lambda-selection.commands.log" "npm cwd=${repo}/lambda test"
assert_not_contains "${TEST_ROOT}/lambda-selection.commands.log" '^node '
pass 'Lambda validation selection'

repo="$(new_repo full-selection)"
printf '%s\n' 'change' > "${repo}/docs/example.md"
status="$(run_helper "${repo}" 'cancel\n' --full 'Full validation')"
assert_equals "${status}" 0
assert_contains "${TEST_ROOT}/full-selection.commands.log" '^node --check tools/telemetry$'
assert_contains "${TEST_ROOT}/full-selection.commands.log" "npm cwd=${repo}/lambda run build"
assert_contains "${TEST_ROOT}/full-selection.commands.log" "npm cwd=${repo}/lambda test"
assert_contains "${TEST_ROOT}/full-selection.commands.log" "npm cwd=${repo}/scripts test"
assert_contains "${TEST_ROOT}/full-selection.commands.log" "npm cwd=${repo}/infra run build"
assert_contains "${TEST_ROOT}/full-selection.commands.log" "npm cwd=${repo}/infra test"
pass '--full validation selection'

repo="$(new_repo validation-failure)"
printf '%s\n' 'change' > "${repo}/tools/example.txt"
before_count="$("${REAL_GIT}" -C "${repo}" rev-list --count HEAD)"
MOCK_FAIL_MATCH='--check' status="$(run_helper "${repo}" 'all\ny\ny\n' 'Should not commit')"
unset MOCK_FAIL_MATCH
[ "${status}" -ne 0 ] || fail_test 'failed validation should stop the helper'
assert_equals "$("${REAL_GIT}" -C "${repo}" rev-list --count HEAD)" "${before_count}"
assert_equals "$("${REAL_GIT}" -C "${repo}" diff --cached --name-only)" ''
assert_contains "${TEST_ROOT}/validation-failure.output.log" 'validation failed'
assert_contains "${TEST_ROOT}/validation-failure.output.log" 'CAPTURED_NODE_VALIDATION_OUTPUT'
assert_contains "${TEST_ROOT}/validation-failure.output.log" 'Validation failed: CLI syntax'
pass 'failed validation prevents staging and commit'

repo="$(new_repo staged-whitespace)"
printf 'trailing whitespace   \n' > "${repo}/docs/bad.md"
"${REAL_GIT}" -C "${repo}" add docs/bad.md
before_count="$("${REAL_GIT}" -C "${repo}" rev-list --count HEAD)"
status="$(run_helper "${repo}" '' 'Bad whitespace')"
[ "${status}" -ne 0 ] || fail_test 'staged whitespace failure should stop the helper'
assert_equals "$("${REAL_GIT}" -C "${repo}" rev-list --count HEAD)" "${before_count}"
assert_contains "${TEST_ROOT}/staged-whitespace.output.log" 'Whitespace issues detected'
assert_contains "${TEST_ROOT}/staged-whitespace.output.log" 'docs/bad\.md:1: trailing whitespace'
assert_contains "${TEST_ROOT}/staged-whitespace.output.log" 'No commit was created'
assert_contains "${TEST_ROOT}/staged-whitespace.output.log" 'Please correct the whitespace issues above'
pass 'staged diff check prevents commit'

repo="$(new_repo file-selection)"
printf '%s\n' 'selected' > "${repo}/docs/selected.md"
printf '%s\n' 'leave unstaged' > "${repo}/tools/unselected.txt"
status="$(run_helper "${repo}" 'files\n1\ny\n' 'Commit selected file')"
assert_equals "${status}" 0
assert_contains "${TEST_ROOT}/file-selection.output.log" '^1\. docs/selected\.md$'
assert_contains "${TEST_ROOT}/file-selection.output.log" '^2\. tools/unselected\.txt$'
assert_contains "${TEST_ROOT}/file-selection.output.log" 'Enter numbers separated by spaces'
assert_contains "${TEST_ROOT}/file-selection.output.log" '^Commit created successfully\.$'
assert_equals "$(${REAL_GIT} -C "${repo}" show --pretty=format: --name-only HEAD | sed '/^$/d')" 'docs/selected.md'
assert_contains "${TEST_ROOT}/file-selection.output.log" '^git push origin main$'
[ -f "${repo}/tools/unselected.txt" ] || fail_test 'unselected file should remain in the worktree'
pass 'file selection stages only requested files'

repo="$(new_repo no-push)"
printf '%s\n' 'change' > "${repo}/docs/example.md"
status="$(run_helper "${repo}" 'all\ny\ny\n' 'Create safe commit')"
assert_equals "${status}" 0
assert_equals "$("${REAL_GIT}" -C "${repo}" log -1 --format=%s)" 'Create safe commit'
assert_not_contains "${TEST_ROOT}/no-push.commands.log" 'PUSH_CALLED'
assert_contains "${TEST_ROOT}/no-push.output.log" '^Recent commits$'
assert_contains "${TEST_ROOT}/no-push.output.log" '^1\. fixture baseline$'
assert_contains "${TEST_ROOT}/no-push.output.log" '^Up to date with origin$'
assert_contains "${TEST_ROOT}/no-push.output.log" '^Ahead of origin by 1 commit$'
assert_contains "${TEST_ROOT}/no-push.output.log" '^Commit created successfully\.$'
assert_not_contains "${TEST_ROOT}/no-push.output.log" 'CAPTURED_NODE_VALIDATION_OUTPUT|CAPTURED_NPM_VALIDATION_OUTPUT'
assert_not_contains "${TEST_ROOT}/no-push.output.log" '^Changes$|^Files available to commit$|^Staged review$'
assert_contains "${TEST_ROOT}/no-push.output.log" '^git push origin main$'
pass 'successful commit never pushes'

printf '\n%s tests passed.\n' "${PASS_COUNT}"