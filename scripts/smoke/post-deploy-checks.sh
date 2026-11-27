#!/usr/bin/env bash
# Owner checklist after a deploy to dev (M1-T7, with the checks asked for by the M1-T4b,
# M1-T4c and M1-T4d reviews). These calls need a signed-in user's access token (Sign in
# with Apple), which CI cannot get, so the owner runs this by hand. infra/README.md,
# "After the first dev deploy", says how to get a token.
#
#   export CUPMARK_ACCESS_TOKEN   # set at run time (read -rs), never stored or committed
#   scripts/smoke/post-deploy-checks.sh dev [--lookups-only]
#   scripts/smoke/post-deploy-checks.sh dev --nightly-only [--dry-run-job]   # no token needed
#   scripts/smoke/post-deploy-checks.sh dev --dry-run-job                    # same, with the dry run
#
# --nightly-only runs only the read-only checks of the nightly aggregates job (function,
# schedules, role policies, alarms when the stage flag is on) and no API call; --dry-run-job
# adds the one invocation with {"dry_run": true} (M3-T13, M3-T15) and implies --nightly-only.
# Both are done by scripts/smoke/nightly-checks.sh, which can also be run on its own and
# for prod. The API checks below do not run in this mode.
#
# dev only: any other stage, prod included, is refused. The API URL is always the output
# ApiUrl of cupmark-dev-core (aws cloudformation describe-stacks with your own
# credentials), so the script cannot be pointed at another API. The token is sent only
# to that API, from a private header file (never on a command line), and never printed.
#
# Checks:
#  1. GET /health: 200 {"status":"ok"}.
#  2. An unknown barcode (UNKNOWN_BARCODE): GET /barcodes/{b} 404, then
#     GET /barcodes/{b}/open_food_facts 404.
#  3. A known barcode with a front image (KNOWN_BARCODE, default 3017620422003, the
#     product Open Food Facts uses in its own API documentation; the backend does not
#     check the category): the OpenFoodFactsProduct shape (name, brand, image_id only),
#     with image_id present; then GET /catalogue_images/{image_id}: 200, image/jpeg,
#     X-Content-Type-Options nosniff, JPEG bytes.
#  4. A label photo (skipped with --lookups-only): POST /beans with no picks, POST
#     /beans/{id}/label_photos, the presigned POST of a tiny generated JPEG to S3, then
#     POST /label_photos/{id}/complete: 204.
#
# What it writes, in dev only. Checks 1 to 3 change nothing the app's user sees: at most
# one Open Food Facts cache item per barcode (a miss expires after its TTL; a hit and its
# catalogue/ image copy stay), and the caller's daily lookup counter. A cached barcode is
# answered from the cache, so a second run fetches nothing. Check 4 writes one unverified
# bean with no barcode (it appears in the operator's review queue; reject it there), one
# raw upload under uploads/ (expires after a day) and one stripped photo under labels/.
#
# Exit 0: every check passed. Exit 1: a check failed. Exit 2: usage error.
set -euo pipefail

REGION="eu-central-1"
STACK="cupmark-dev-core"
OUTPUT_KEY="ApiUrl"
KNOWN_BARCODE="${KNOWN_BARCODE:-3017620422003}"
UNKNOWN_BARCODE="${UNKNOWN_BARCODE:-9510000000005}"
ULID='^[0-9A-HJKMNP-TV-Z]{26}$'
export AWS_PAGER=""

usage() {
  echo "Usage: CUPMARK_ACCESS_TOKEN=... $0 dev [--lookups-only]" >&2
  echo "       $0 dev [--nightly-only] [--dry-run-job]" >&2
  exit 2
}
[[ $# -ge 1 && $# -le 3 ]] || usage
if [[ "$1" != "dev" ]]; then
  echo "Refusing stage '$1': these checks write test data and run against dev only." >&2
  exit 2
fi
LOOKUPS_ONLY=0
if [[ $# -ge 2 ]]; then
  case "$2" in
    --lookups-only) [[ $# -eq 2 ]] || usage; LOOKUPS_ONLY=1 ;;
    --dry-run-job) [[ $# -eq 2 ]] || usage; exec "$(dirname "${BASH_SOURCE[0]}")/nightly-checks.sh" dev --dry-run-job ;;
    --nightly-only)
      [[ $# -eq 2 || "$3" == "--dry-run-job" ]] || usage
      # No token, no API: only the owner's AWS CLI credentials.
      exec "$(dirname "${BASH_SOURCE[0]}")/nightly-checks.sh" dev ${3:+"$3"}
      ;;
    *) usage ;;
  esac
fi

TOKEN="${CUPMARK_ACCESS_TOKEN:-}"
if [[ ! "$TOKEN" =~ ^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]]; then
  echo "CUPMARK_ACCESS_TOKEN is not set, or is not a JWT (the Cognito access token of a dev user)." >&2
  exit 2
fi
unset CUPMARK_ACCESS_TOKEN

# GS1 check digit of an EAN-13, as the backend checks it.
valid_ean13() {
  local code="$1" sum=0 i
  [[ "$code" =~ ^[0-9]{13}$ ]] || return 1
  for ((i = 0; i < 12; i++)); do
    sum=$((sum + ${code:i:1} * (i % 2 == 0 ? 1 : 3)))
  done
  [[ $(((10 - sum % 10) % 10)) -eq ${code:12:1} ]]
}
for code in "$KNOWN_BARCODE" "$UNKNOWN_BARCODE"; do
  valid_ean13 "$code" || { echo "Not an EAN-13 with a valid check digit: $code" >&2; exit 2; }
done

URL="$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='$OUTPUT_KEY'].OutputValue | [0]" --output text)"
if [[ ! "$URL" =~ ^https://[a-z0-9]{10}\.execute-api\.eu-central-1\.amazonaws\.com$ ]]; then
  echo "The output $OUTPUT_KEY of $STACK is not an HTTP API URL in $REGION: '$URL'." >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
(umask 077 && printf 'Authorization: Bearer %s\n' "$TOKEN" >"$tmp/auth")
unset TOKEN

failures=0
pass() { echo "PASS  $1"; }
fail() {
  echo "FAIL  $1" >&2
  failures=$((failures + 1))
}

STATUS=""
# call METHOD PATH [auth|none] [json body]: the answer in $STATUS, $tmp/body, $tmp/headers.
call() {
  local method="$1" path="$2" auth="${3:-auth}" json="${4:-}"
  local args=(-sS --max-time 20 -X "$method" -o "$tmp/body" -D "$tmp/headers" -w '%{http_code}')
  [[ "$auth" == "auth" ]] && args+=(-H "@$tmp/auth")
  if [[ -n "$json" ]]; then
    printf '%s' "$json" >"$tmp/request"
    args+=(-H 'Content-Type: application/json' --data-binary "@$tmp/request")
  fi
  : >"$tmp/body"
  : >"$tmp/headers"
  STATUS="$(curl "${args[@]}" "$URL$path" || true)"
}
# The last value of a response header, lower-cased.
header() {
  tr -d '\r' <"$tmp/headers" | awk -F': *' -v name="$1" 'tolower($1) == name { value = tolower($2) } END { print value }'
}

echo "Post-deploy checks against $STACK ($URL)."
[[ $LOOKUPS_ONLY -eq 1 ]] && echo "Lookups only: no bean and no label photo are created."

# 1. Health.
call GET /health none
if [[ "$STATUS" == "200" && "$(jq -c . "$tmp/body" 2>/dev/null)" == '{"status":"ok"}' ]]; then
  pass "GET /health: 200 {\"status\":\"ok\"}"
else
  fail "GET /health: expected 200 {\"status\":\"ok\"}, got $STATUS"
fi

# Explains a 503 from the Open Food Facts route (docs/05, Barcode lookup).
off_hint() {
  if [[ "$1" == "503" ]]; then
    echo "      503: OFF_CONTACT is missing or invalid in the function's environment, Open Food Facts could not be reached," >&2
    echo "      or its answer did not have the shape the backend expects (status, product.product_name, product.brands)." >&2
    echo "      Nothing was cached; check the API function's log line for the error name." >&2
  elif [[ "$1" == "401" ]]; then
    echo "      401: the token is expired (60 minutes) or not from the dev app client." >&2
  fi
}

# 2. Unknown barcode.
call GET "/barcodes/$UNKNOWN_BARCODE"
if [[ "$STATUS" == "404" ]]; then pass "GET /barcodes/$UNKNOWN_BARCODE: 404"; else fail "GET /barcodes/$UNKNOWN_BARCODE: expected 404, got $STATUS"; off_hint "$STATUS"; fi
call GET "/barcodes/$UNKNOWN_BARCODE/open_food_facts"
if [[ "$STATUS" == "404" ]]; then
  pass "GET /barcodes/$UNKNOWN_BARCODE/open_food_facts: 404"
elif [[ "$STATUS" == "200" ]]; then
  fail "GET /barcodes/$UNKNOWN_BARCODE/open_food_facts: Open Food Facts knows this barcode; set UNKNOWN_BARCODE to another one"
else
  fail "GET /barcodes/$UNKNOWN_BARCODE/open_food_facts: expected 404, got $STATUS"
  off_hint "$STATUS"
fi

# 3. Known barcode with a front image. The contract's OpenFoodFactsProduct: only name
#    (1..150), brand (1..100) and image_id, at least a name or a brand here.
PRODUCT_SHAPE='type == "object"
  and ((keys - ["brand", "image_id", "name"]) == [])
  and (has("name") or has("brand"))
  and ((has("name") | not) or (.name | type == "string" and length >= 1 and length <= 150))
  and ((has("brand") | not) or (.brand | type == "string" and length >= 1 and length <= 100))
  and ((has("image_id") | not) or (.image_id | type == "string" and test($ulid)))'
IMAGE_ID=""
check_product() { # label jq-path
  if jq -e --arg ulid "$ULID" "$2 | $PRODUCT_SHAPE" "$tmp/body" >/dev/null 2>&1; then
    pass "$1: the OpenFoodFactsProduct shape"
    IMAGE_ID="$(jq -r "$2 | .image_id // empty" "$tmp/body")"
  else
    fail "$1: not the OpenFoodFactsProduct shape (only name, brand and image_id are allowed)"
  fi
}
call GET "/barcodes/$KNOWN_BARCODE"
if [[ "$STATUS" == "200" ]]; then
  # A bean already points to it, so the lookup route would answer 409: check the bean's copy.
  echo "      GET /barcodes/$KNOWN_BARCODE: 200, a bean exists; checking its open_food_facts"
  check_product "GET /barcodes/$KNOWN_BARCODE" '.open_food_facts'
elif [[ "$STATUS" == "404" ]]; then
  call GET "/barcodes/$KNOWN_BARCODE/open_food_facts"
  if [[ "$STATUS" == "200" ]]; then
    check_product "GET /barcodes/$KNOWN_BARCODE/open_food_facts" '.'
  else
    fail "GET /barcodes/$KNOWN_BARCODE/open_food_facts: expected 200, got $STATUS"
    off_hint "$STATUS"
  fi
else
  fail "GET /barcodes/$KNOWN_BARCODE: expected 404 or 200, got $STATUS"
  off_hint "$STATUS"
fi
if [[ -n "$IMAGE_ID" ]]; then
  pass "known barcode: image_id present"
  call GET "/catalogue_images/$IMAGE_ID"
  magic="$(head -c 3 "$tmp/body" | od -An -tx1 | tr -d ' \n')"
  if [[ "$STATUS" == "200" && "$(header content-type)" == "image/jpeg" && "$(header x-content-type-options)" == "nosniff" && "$magic" == "ffd8ff" ]]; then
    pass "GET /catalogue_images/{image_id}: 200 image/jpeg, nosniff, JPEG bytes"
  else
    fail "GET /catalogue_images/{image_id}: expected 200 image/jpeg with nosniff and JPEG bytes; got $STATUS, '$(header content-type)', '$(header x-content-type-options)'"
  fi
else
  fail "known barcode: no image_id. A cached hit is never overwritten, so if PHOTO_BUCKET was missing or wrong when it was first fetched, it stays without an image; check the function's PHOTO_BUCKET and try another KNOWN_BARCODE"
fi

# The S3 form field names of LabelPhotoUploadFields (contracts/openapi.yaml).
s3_field() {
  case "$1" in
    key) echo key ;;
    bucket) echo bucket ;;
    content_type) echo Content-Type ;;
    policy) echo Policy ;;
    x_amz_algorithm) echo X-Amz-Algorithm ;;
    x_amz_credential) echo X-Amz-Credential ;;
    x_amz_date) echo X-Amz-Date ;;
    x_amz_security_token) echo X-Amz-Security-Token ;;
    x_amz_signature) echo X-Amz-Signature ;;
    *) return 1 ;;
  esac
}

# A tiny baseline JPEG, generated here: SOI, one quantisation table, an 8-bit 16x8 frame
# with three components, one Huffman table, a scan with three bytes of data, EOI. The
# server checks the structure and strips metadata; it does not decode the pixels.
tiny_jpeg() {
  local bytes=(ff d8 ff db 00 43 00) i
  for ((i = 0; i < 64; i++)); do bytes+=("$(printf '%02x' $((i % 50 + 1)))"); done
  bytes+=(ff c0 00 11 08 00 08 00 10 03 01 11 00 02 11 00 03 11 00)
  bytes+=(ff c4 00 15 00 02 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 01)
  bytes+=(ff da 00 0c 03 01 00 02 00 03 00 00 3f 00 12 34 56 ff d9)
  local b
  for b in "${bytes[@]}"; do printf '%b' "\\x$b"; done
}

# 4. Label photo.
if [[ $LOOKUPS_ONLY -eq 0 ]]; then
  call POST /beans auth '{"vocabulary_version":1,"attributes":{}}'
  BEAN_ID="$(jq -r --arg ulid "$ULID" 'select(.verified == false) | .bean_id | select(type == "string" and test($ulid))' "$tmp/body" 2>/dev/null || true)"
  if [[ "$STATUS" == "201" && -n "$BEAN_ID" ]]; then
    pass "POST /beans: 201, an unverified bean"
    call POST "/beans/$BEAN_ID/label_photos"
    PHOTO_ID="$(jq -r --arg ulid "$ULID" '.photo_id | select(type == "string" and test($ulid))' "$tmp/body" 2>/dev/null || true)"
    UPLOAD_URL="$(jq -r '.upload.url // empty' "$tmp/body" 2>/dev/null || true)"
    if [[ "$STATUS" == "201" && -n "$PHOTO_ID" && "$UPLOAD_URL" =~ ^https://cupmark-dev-photos-[0-9]{12}\.s3\.eu-central-1\.amazonaws\.com/$ ]] \
      && jq -e --arg key "uploads/$PHOTO_ID.jpg" '.upload.fields.key == $key and .upload.fields.content_type == "image/jpeg"' "$tmp/body" >/dev/null; then
      pass "POST /beans/{bean_id}/label_photos: 201, a presigned POST for uploads/<photo_id>.jpg"
      form=()
      bad_field=""
      while IFS=$'\t' read -r name value; do
        if s3="$(s3_field "$name")"; then form+=(--form-string "$s3=$value"); else bad_field="$name"; fi
      done < <(jq -r '.upload.fields | to_entries[] | "\(.key)\t\(.value)"' "$tmp/body")
      tiny_jpeg >"$tmp/label.jpg"
      if [[ -n "$bad_field" ]]; then
        fail "presigned POST: unknown form field $bad_field"
      else
        # No Authorization header: the presigned policy authorises the upload.
        s3_status="$(curl -sS --max-time 30 -o "$tmp/s3-body" -w '%{http_code}' ${form[@]+"${form[@]}"} -F "file=@$tmp/label.jpg;type=image/jpeg" "$UPLOAD_URL" || true)"
        if [[ "$s3_status" == "204" ]]; then
          pass "S3 presigned POST of a $(wc -c <"$tmp/label.jpg" | tr -d ' ')-byte JPEG: 204"
          call POST "/label_photos/$PHOTO_ID/complete"
          if [[ "$STATUS" == "204" ]]; then
            pass "POST /label_photos/{photo_id}/complete: 204"
          else
            fail "POST /label_photos/{photo_id}/complete: expected 204, got $STATUS (500 would point to presigner and SDK version skew)"
          fi
        else
          fail "S3 presigned POST: expected 204, got $s3_status"
        fi
      fi
    else
      fail "POST /beans/{bean_id}/label_photos: expected 201 with a presigned POST for the dev photo bucket, got $STATUS (500 would point to presigner and SDK version skew)"
    fi
  else
    fail "POST /beans: expected 201 with an unverified bean, got $STATUS"
  fi
fi

if [[ $failures -gt 0 ]]; then
  echo "$failures check(s) failed." >&2
  exit 1
fi
echo "All post-deploy checks passed."
