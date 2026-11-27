#!/usr/bin/env bash
# Owner checks of the nightly aggregates job after a deploy (M3-T13, ADR 0035). Run by the
# owner with their own AWS CLI credentials (CloudShell or a configured profile); there are
# no keys in the repository and no token is needed. scripts/smoke/post-deploy-checks.sh
# calls this script for its --nightly-only and --dry-run-job flags.
#
#   scripts/smoke/nightly-checks.sh <dev|prod> [--dry-run-job]
#
# Read-only checks (AWS CLI calls on an allow-list inside aws_json; anything else stops
# the script). All names are built from the stage, so they are always cupmark-<stage>-*;
# a name that is not is refused before any call (invariant 9).
#  1. Function cupmark-<stage>-nightly-aggregates: timeout 300 s, memory 512 MB, arm64,
#     no VPC; its async invoke config has MaximumRetryAttempts 0.
#  2. Schedule cupmark-<stage>-nightly-aggregates in group cupmark-<stage>-jobs: cron
#     expression, time zone, state (the stage's nightlyScheduleEnabled in infra/src/config.ts:
#     dev ENABLED, prod DISABLED), the empty event {}, one Scheduler retry. And the weekly
#     export schedule cupmark-<stage>-weekly-export.
#  3. Role policies read with iam get-role-policy and compared with the expected
#     statements: the function role (Logs, ScanTable with dynamodb:Scan only, WriteAggregates
#     with the three write actions under a LeadingKeys condition of BEAN#* and RANK#*), no
#     dynamodb:* and no wildcard resource except the log streams; the scheduler role may
#     only invoke this one function. simulate-principal-policy is not used.
#  4. Only when the stage's failureAlarms.enabled (infra/src/config.ts) is true: the errors
#     and missing-run alarms exist and are not in ALARM (OK and INSUFFICIENT_DATA are
#     reported), and the topic cupmark-<stage>-alerts exists. Subscriber endpoints are
#     never listed or read, and no account id or ARN is printed.
#
# --dry-run-job (off by default; M3-T15) additionally invokes the function once with the
# fixed payload {"dry_run": true}. That is the only call that is not a read, and the job
# writes nothing in a dry run by design (the check fails if the log line says otherwise).
# It prints the function's log line values and the Lambda REPORT figures, and compares them
# with the ADR 0035 bounds: duration 60 s, share of the timeout 0.5, Max Memory Used 60%
# of the function's memory. It fails on a function error or on a log line without the
# fixed keys. The REPLAY_MEASURE line of backend/test/replay (npm run test:replay) uses the
# same key names, so the two can be compared by eye.
#
# Exit 0: every check passed. Exit 1: a check failed. Exit 2: usage error.
set -euo pipefail

REGION="eu-central-1"
EXPECTED_TIMEOUT=300
EXPECTED_MEMORY=512
EXPECTED_CRON='cron(0 2 * * ? *)'
EXPECTED_EXPORT_CRON='cron(0 3 ? * SUN *)'
EXPORT_TARGET='arn:aws:scheduler:::aws-sdk:dynamodb:exportTableToPointInTime'
LIMIT_DURATION_MS=60000
LIMIT_SHARE=0.5
LIMIT_MEMORY_SHARE=0.6
export AWS_PAGER=""

usage() {
  echo "Usage: $0 <dev|prod> [--dry-run-job]" >&2
  exit 2
}
[[ $# -ge 1 && $# -le 2 ]] || usage
STAGE="$1"
[[ "$STAGE" == "dev" || "$STAGE" == "prod" ]] || usage
DRY_RUN=0
if [[ $# -eq 2 ]]; then
  [[ "$2" == "--dry-run-job" ]] || usage
  DRY_RUN=1
fi

P="cupmark-$STAGE"
FN="$P-nightly-aggregates"
SCHEDULE="$P-nightly-aggregates"
EXPORT_SCHEDULE="$P-weekly-export"
GROUP="$P-jobs"
SCHED_ROLE="$P-nightly-scheduler"
TOPIC="$P-alerts"
ERRORS_ALARM="$P-nightly-aggregates-errors"
MISSING_ALARM="$P-nightly-aggregates-missing-run"
TABLE="$P-main"

# The stage's flags come from the one place that sets them.
CONFIG="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/infra/src/config.ts"
line="$(grep -E "^[[:space:]]*$STAGE: \{ failureAlarms: \{ enabled: (true|false) \}, nightlyScheduleEnabled: (true|false) \}" "$CONFIG" 2>/dev/null || true)"
if [[ -z "$line" ]]; then
  echo "Cannot read the $STAGE flags (failureAlarms, nightlyScheduleEnabled) from infra/src/config.ts." >&2
  exit 2
fi
ALARMS_ON="$(sed -E 's/.*failureAlarms: \{ enabled: (true|false) \}.*/\1/' <<<"$line")"
SCHEDULE_ON="$(sed -E 's/.*nightlyScheduleEnabled: (true|false) \}.*/\1/' <<<"$line")"
if [[ "$SCHEDULE_ON" == "true" ]]; then EXPECTED_STATE="ENABLED"; else EXPECTED_STATE="DISABLED"; fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

failures=0
pass() { echo "PASS  $1"; }
fail() {
  echo "FAIL  $1" >&2
  failures=$((failures + 1))
}
info() { echo "      $1"; }

# Every resource name the script passes to AWS starts with cupmark-.
only_cupmark() {
  local name
  for name in "$@"; do
    [[ "$name" =~ ^cupmark-(dev|prod)-[a-z0-9-]+$ ]] || { echo "Refusing to touch '$name': not a cupmark- resource." >&2; exit 2; }
  done
}
only_cupmark "$FN" "$SCHEDULE" "$EXPORT_SCHEDULE" "$GROUP" "$SCHED_ROLE" "$TOPIC" "$ERRORS_ALARM" "$MISSING_ALARM" "$TABLE"

# The only door to AWS: the allow-listed calls, always in eu-central-1, JSON out.
aws_json() {
  case "$1 $2" in
    "lambda get-function-configuration" | "lambda get-function-event-invoke-config" | "lambda invoke" | \
      "scheduler get-schedule" | "iam list-role-policies" | "iam list-attached-role-policies" | "iam get-role-policy" | \
      "cloudwatch describe-alarms" | "sns get-topic-attributes") ;;
    *) echo "aws $1 $2 is not on the allow-list of this read-only script." >&2; exit 2 ;;
  esac
  aws "$1" "$2" --region "$REGION" --output json "${@:3}"
}

echo "Nightly job checks for $P (failureAlarms.enabled=$ALARMS_ON, nightlyScheduleEnabled=$SCHEDULE_ON)."

# 1. The function.
FUNCTION_OK=0
ROLE_NAME=""
MEMORY="$EXPECTED_MEMORY"
if aws_json lambda get-function-configuration --function-name "$FN" >"$tmp/fn.json" 2>"$tmp/err"; then
  FUNCTION_OK=1
  if jq -e --argjson t "$EXPECTED_TIMEOUT" --argjson m "$EXPECTED_MEMORY" \
    '.Timeout == $t and .MemorySize == $m and .Architectures == ["arm64"] and ((.VpcConfig.VpcId // "") == "")' "$tmp/fn.json" >/dev/null; then
    pass "function $FN: timeout ${EXPECTED_TIMEOUT} s, ${EXPECTED_MEMORY} MB, arm64, no VPC"
  else
    fail "function $FN: expected timeout $EXPECTED_TIMEOUT, memory $EXPECTED_MEMORY, arm64 and no VPC; got timeout $(jq -r '.Timeout' "$tmp/fn.json"), memory $(jq -r '.MemorySize' "$tmp/fn.json"), $(jq -c '.Architectures' "$tmp/fn.json"), VPC '$(jq -r '.VpcConfig.VpcId // ""' "$tmp/fn.json")'"
  fi
  MEMORY="$(jq -r '.MemorySize' "$tmp/fn.json")"
  # The role's name only (the ARN holds the account id and is not printed).
  ROLE_NAME="$(jq -r '.Role // "" | split("/") | last' "$tmp/fn.json")"
else
  fail "function $FN: not found or not readable"
fi

if aws_json lambda get-function-event-invoke-config --function-name "$FN" >"$tmp/eic.json" 2>"$tmp/err"; then
  if jq -e '.MaximumRetryAttempts == 0' "$tmp/eic.json" >/dev/null; then
    pass "function $FN: asynchronous MaximumRetryAttempts 0"
  else
    fail "function $FN: expected asynchronous MaximumRetryAttempts 0, got $(jq -c '.MaximumRetryAttempts' "$tmp/eic.json")"
  fi
else
  fail "function $FN: no asynchronous invoke config (Lambda would retry a failed run twice by itself)"
fi

# 2. The schedules.
check_schedule() { # name expected-expression expected-state
  local name="$1" expression="$2" state="$3"
  if aws_json scheduler get-schedule --group-name "$GROUP" --name "$name" >"$tmp/sched.json" 2>"$tmp/err"; then
    if jq -e --arg e "$expression" --arg s "$state" '.ScheduleExpression == $e and .State == $s and .ScheduleExpressionTimezone == "UTC" and .GroupName == "'"$GROUP"'"' "$tmp/sched.json" >/dev/null; then
      pass "schedule $GROUP/$name: $expression UTC, $state"
    else
      fail "schedule $GROUP/$name: expected $expression UTC $state; got $(jq -r '.ScheduleExpression' "$tmp/sched.json") $(jq -r '.ScheduleExpressionTimezone' "$tmp/sched.json") $(jq -r '.State' "$tmp/sched.json")"
    fi
  else
    fail "schedule $GROUP/$name: not found or not readable"
    return 1
  fi
}
if check_schedule "$SCHEDULE" "$EXPECTED_CRON" "$EXPECTED_STATE"; then
  if jq -e --arg fn "$FN" '.Target.Input == "{}" and ((.Target.Arn // "") | endswith(":function:" + $fn)) and .Target.RetryPolicy.MaximumRetryAttempts == 1' "$tmp/sched.json" >/dev/null; then
    pass "schedule $SCHEDULE: starts $FN with the empty event {} and one Scheduler retry"
  else
    fail "schedule $SCHEDULE: expected the target $FN, input {} (never a dry run) and MaximumRetryAttempts 1"
  fi
fi
if check_schedule "$EXPORT_SCHEDULE" "$EXPECTED_EXPORT_CRON" "ENABLED"; then
  if jq -e --arg t "$EXPORT_TARGET" '.Target.Arn == $t' "$tmp/sched.json" >/dev/null; then
    pass "schedule $EXPORT_SCHEDULE: calls dynamodb exportTableToPointInTime"
  else
    fail "schedule $EXPORT_SCHEDULE: unexpected target"
  fi
fi

# 3. Role policies.
role_policies() { # role-name: the single inline policy document in $tmp/policy.json
  local role="$1" names attached
  if ! aws_json iam list-role-policies --role-name "$role" >"$tmp/names.json" 2>"$tmp/err"; then
    fail "role $role: not found or not readable"
    return 1
  fi
  names="$(jq -r '.PolicyNames | length' "$tmp/names.json")"
  if aws_json iam list-attached-role-policies --role-name "$role" >"$tmp/attached.json" 2>"$tmp/err"; then
    attached="$(jq -r '.AttachedPolicies | length' "$tmp/attached.json")"
  else
    attached="unreadable"
  fi
  if [[ "$names" != "1" || "$attached" != "0" ]] || ! jq -e --arg n "$role" '.PolicyNames == [$n]' "$tmp/names.json" >/dev/null; then
    fail "role $role: expected exactly one inline policy named $role and no managed policy; got $names inline, $attached managed"
    return 1
  fi
  if ! aws_json iam get-role-policy --role-name "$role" --policy-name "$role" --query PolicyDocument >"$tmp/policy.json" 2>"$tmp/err"; then
    fail "role $role: policy not readable"
    return 1
  fi
}
# Statements as {sid, effect, actions, resources, condition} with actions and resources as sorted lists.
NORMALISE='[.Statement | if type == "array" then .[] else . end | {sid: (.Sid // ""), effect: .Effect, actions: ([.Action] | flatten | sort), resources: ([.Resource] | flatten | sort), condition: (.Condition // null)}]'

if [[ -n "$ROLE_NAME" ]] && role_policies "$ROLE_NAME"; then
  if [[ "$ROLE_NAME" != "$FN" ]]; then
    fail "function role: expected the role $FN, the function uses '$ROLE_NAME'"
  elif jq -e --arg table "arn:aws:dynamodb:$REGION:" --arg tablename ":table/$TABLE" --arg logs ":log-group:/aws/lambda/$FN:*" "$NORMALISE"' as $s
    | ($s | map(.sid) | sort) == ["Logs", "ScanTable", "WriteAggregates"]
    and ($s | all(.effect == "Allow"))
    and ($s | all(.actions | all(. != "*" and (endswith(":*") | not) and (test("\\*") | not))))
    and ($s | map(select(.sid != "Logs")) | all(.resources | length == 1 and (.[0] | startswith($table) and endswith($tablename))))
    and ($s | all(.resources | all(. != "*")))
    and ($s | map(select(.sid == "Logs")) | all(.actions == ["logs:CreateLogStream", "logs:PutLogEvents"] and (.resources | length == 1 and (.[0] | endswith($logs)))))
    and ($s | map(select(.sid == "ScanTable")) | all(.actions == ["dynamodb:Scan"] and .condition == null))
    and ($s | map(select(.sid == "WriteAggregates")) | all(.actions == ["dynamodb:BatchWriteItem", "dynamodb:DeleteItem", "dynamodb:PutItem"]
      and (.condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"] | [.] | flatten | sort) == ["BEAN#*", "RANK#*"]
      and (.condition | keys) == ["ForAllValues:StringLike"]))' "$tmp/policy.json" >/dev/null; then
    pass "role $ROLE_NAME: Logs, Scan of the table, writes on BEAN#* and RANK#* only (LeadingKeys), no dynamodb:*, no wildcard resource"
  else
    fail "role $ROLE_NAME: the policy is not the scoped one (expected statements Logs, ScanTable, WriteAggregates with a LeadingKeys condition on the writes, no wildcard action or resource)"
    jq -r "$NORMALISE"' | .[] | "      \(.sid): \(.actions | join(",")) on \(.resources | length) resource(s), condition \(if .condition == null then "none" else (.condition | keys | join(",")) end)"' "$tmp/policy.json" >&2 || true
  fi
elif [[ "$FUNCTION_OK" -eq 1 && -z "$ROLE_NAME" ]]; then
  fail "function $FN: no role in its configuration"
fi
if role_policies "$SCHED_ROLE"; then
  if jq -e --arg fn "$FN" "$NORMALISE"' as $s | ($s | length) == 1 and $s[0].sid == "InvokeNightlyFunction" and $s[0].effect == "Allow"
    and $s[0].actions == ["lambda:InvokeFunction"] and ($s[0].resources | length == 1 and (.[0] | endswith(":function:" + $fn))) and $s[0].condition == null' "$tmp/policy.json" >/dev/null; then
    pass "role $SCHED_ROLE: may only invoke $FN"
  else
    fail "role $SCHED_ROLE: expected one statement, lambda:InvokeFunction on $FN only"
  fi
fi

# 4. Alarms and topic, only while the stage's flag is on.
if [[ "$ALARMS_ON" == "true" ]]; then
  alarm_names=("$ERRORS_ALARM")
  [[ "$SCHEDULE_ON" == "true" ]] && alarm_names+=("$MISSING_ALARM")
  if aws_json cloudwatch describe-alarms --alarm-names "${alarm_names[@]}" --alarm-types MetricAlarm >"$tmp/alarms.json" 2>"$tmp/err"; then
    topic_arn=""
    for name in "${alarm_names[@]}"; do
      state="$(jq -r --arg n "$name" '[.MetricAlarms[] | select(.AlarmName == $n)] | if length == 1 then .[0].StateValue else "MISSING" end' "$tmp/alarms.json")"
      case "$state" in
        OK | INSUFFICIENT_DATA) pass "alarm $name: $state" ;;
        ALARM)
          fail "alarm $name: ALARM"
          [[ "$name" == "$MISSING_ALARM" ]] && info "right after a deploy this alarm stays in ALARM until the first scheduled run has happened (docs: infra/README.md)"
          ;;
        MISSING) fail "alarm $name: does not exist" ;;
        *) fail "alarm $name: unexpected state '$state'" ;;
      esac
      arn="$(jq -r --arg n "$name" '[.MetricAlarms[] | select(.AlarmName == $n) | .AlarmActions[]?] | if length == 1 then .[0] else "" end' "$tmp/alarms.json")"
      if [[ -z "$arn" ]]; then
        [[ "$state" == "MISSING" ]] || fail "alarm $name: expected exactly one alarm action, the topic $TOPIC"
      elif [[ "$arn" =~ ^arn:aws:sns:$REGION:[0-9]{12}:$TOPIC$ ]]; then
        topic_arn="$arn"
      else
        fail "alarm $name: its action is not the topic $TOPIC"
      fi
    done
    if [[ -n "$topic_arn" ]]; then
      # Only the count of confirmed subscriptions is projected: no endpoint, no policy.
      if confirmed="$(aws_json sns get-topic-attributes --topic-arn "$topic_arn" --query 'Attributes.SubscriptionsConfirmed' 2>"$tmp/err" | jq -r '.')"; then
        pass "topic $TOPIC: exists"
        if [[ "$confirmed" =~ ^[0-9]+$ && "$confirmed" -gt 0 ]]; then
          info "confirmed subscriptions: $confirmed (endpoints are not read)"
        else
          info "no confirmed subscription yet: subscribe your own address by hand (aws sns subscribe --protocol email) and confirm the mail"
        fi
      else
        fail "topic $TOPIC: not found or not readable"
      fi
    else
      fail "topic $TOPIC: not found through the alarm actions"
    fi
  else
    fail "alarms $ERRORS_ALARM and $MISSING_ALARM: not readable"
  fi
else
  echo "SKIP  alarms and topic: failureAlarms.enabled is false for $STAGE (ADR 0035, Addendum 2)"
fi

# --dry-run-job: the one non-read call, with the fixed payload.
if [[ $DRY_RUN -eq 1 ]]; then
  echo "Dry run of $FN: one invocation with {\"dry_run\": true}; the job writes nothing in a dry run."
  if [[ $FUNCTION_OK -ne 1 ]]; then
    fail "dry run: skipped, the function does not exist"
  elif ! aws_json lambda invoke --function-name "$FN" --invocation-type RequestResponse --log-type Tail \
    --cli-binary-format raw-in-base64-out --cli-read-timeout 330 --payload '{"dry_run": true}' "$tmp/response.json" >"$tmp/invoke.json" 2>"$tmp/err"; then
    fail "dry run: the invocation failed (no function error is reported; check permissions)"
  elif jq -e '(.FunctionError // "") != ""' "$tmp/invoke.json" >/dev/null; then
    fail "dry run: the function returned an error ($(jq -r '.FunctionError' "$tmp/invoke.json"), $(jq -r '.errorType // "no type" | select(test("^[A-Za-z.]{1,64}$")) // "unnamed"' "$tmp/response.json" 2>/dev/null || echo unnamed)); read its log stream in CloudWatch"
  else
    jq -r '.LogResult // ""' "$tmp/invoke.json" | base64 -d >"$tmp/log.txt" 2>/dev/null || : >"$tmp/log.txt"
    json_line="$(grep -F '"operation":"nightly-aggregates"' "$tmp/log.txt" | tail -n 1 | sed -E 's/^[^{]*//' || true)"
    report_line="$(grep -E '^REPORT ' "$tmp/log.txt" | tail -n 1 || true)"
    max_mb="$(sed -nE 's/.*Max Memory Used: ([0-9]+) MB.*/\1/p' <<<"$report_line")"
    KEYS='["operation","status","dry_run","duration_ms","share_of_timeout","items_scanned","users_seen","brews_seen","brews_counted","brews_orphaned","reasons","beans_with_aggregates","beans_ranked","items_written","items_deleted"]'
    if [[ -z "$json_line" ]] || ! jq -e --argjson keys "$KEYS" '. as $o | type == "object" and ($keys | all(. as $k | $o | has($k)))' <<<"$json_line" >/dev/null 2>&1; then
      fail "dry run: the log tail has no run log line with the fixed keys (operation, status, dry_run, duration_ms, share_of_timeout, items_scanned, users_seen, brews_*, reasons, items_written, items_deleted)"
    elif ! jq -e '.operation == "nightly-aggregates" and .status == "OK" and .dry_run == true' <<<"$json_line" >/dev/null; then
      fail "dry run: the run log line says status $(jq -r '.status' <<<"$json_line"), dry_run $(jq -r '.dry_run' <<<"$json_line")"
    elif ! jq -e '.items_written == 0 and .items_deleted == 0' <<<"$json_line" >/dev/null; then
      fail "dry run: the log line reports writes (items_written $(jq -r '.items_written' <<<"$json_line"), items_deleted $(jq -r '.items_deleted' <<<"$json_line")); a dry run must write nothing. Stop and tell the maintainers"
    else
      pass "dry run: log line with every fixed key, dry_run true, nothing written"
      duration="$(jq -r '.duration_ms' <<<"$json_line")"
      share="$(jq -r '.share_of_timeout' <<<"$json_line")"
      echo "      counts: $(jq -r '"items_scanned=\(.items_scanned) users_seen=\(.users_seen) brews_seen=\(.brews_seen) brews_counted=\(.brews_counted) brews_orphaned=\(.brews_orphaned) beans_with_aggregates=\(.beans_with_aggregates) beans_ranked=\(.beans_ranked)"' <<<"$json_line")"
      echo "      reasons: $(jq -r '.reasons | to_entries | map("\(.key)=\(.value)") | join(" ")' <<<"$json_line")"
      if [[ -n "$max_mb" ]]; then
        mem_share="$(awk -v u="$max_mb" -v m="$MEMORY" 'BEGIN { printf "%.3f", u / m }')"
      else
        mem_share="n/a"
      fi
      # The same key names and order as REPLAY_MEASURE of the replay test, where they exist.
      echo "NIGHTLY_MEASURE target=$STAGE run=dry-run items_scanned=$(jq -r '.items_scanned' <<<"$json_line") brews_seen=$(jq -r '.brews_seen' <<<"$json_line") brews_counted=$(jq -r '.brews_counted' <<<"$json_line") duration_ms=$duration timeout_ms=$((EXPECTED_TIMEOUT * 1000)) share_of_timeout=$share max_memory_used_mb=${max_mb:-n/a} memory_mb=$MEMORY memory_share=$mem_share items_written=0 items_deleted=0"
      if awk -v d="$duration" -v l="$LIMIT_DURATION_MS" 'BEGIN { exit !(d <= l) }'; then
        pass "duration ${duration} ms is within the 60 s budget"
      else
        fail "duration ${duration} ms is above the 60 s budget (ADR 0035: the scale trigger; a new ADR splits the scan)"
      fi
      if awk -v s="$share" -v l="$LIMIT_SHARE" 'BEGIN { exit !(s <= l) }'; then
        pass "share_of_timeout $share is within half of the timeout"
      else
        fail "share_of_timeout $share is above half of the timeout (ADR 0035: the scale trigger)"
      fi
      if [[ -z "$max_mb" ]]; then
        fail "dry run: no 'Max Memory Used' in the REPORT line of the log tail"
      elif awk -v u="$max_mb" -v m="$MEMORY" -v l="$LIMIT_MEMORY_SHARE" 'BEGIN { exit !(u <= m * l) }'; then
        pass "Max Memory Used ${max_mb} MB is within 60% of ${MEMORY} MB"
      else
        fail "Max Memory Used ${max_mb} MB is above 60% of ${MEMORY} MB (ADR 0035: the scale trigger)"
      fi
    fi
  fi
fi

if [[ $failures -gt 0 ]]; then
  echo "$failures check(s) failed." >&2
  exit 1
fi
echo "All nightly job checks passed."
