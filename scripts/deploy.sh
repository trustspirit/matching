#!/usr/bin/env bash
# Deploys the database and Edge Functions, then verifies the deployment.
#
# Re-running this script is cheap and idempotent. That is the intended fix for
# the ALLOWED_ORIGIN ordering problem: run it once before the Cloudflare Pages
# site exists (SITE_ORIGIN=http://localhost:5173), then again with the real
# pages.dev domain once it does.
#
# Usage:
#   PROJECT_REF=abcd ADMIN_PASSWORD=... \
#     SITE_ORIGIN=https://<project>.pages.dev \
#     ./scripts/deploy.sh [--dry-run]
set -euo pipefail

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

missing=()
[[ -z "${PROJECT_REF:-}" ]]    && missing+=(PROJECT_REF)
[[ -z "${ADMIN_PASSWORD:-}" ]] && missing+=(ADMIN_PASSWORD)
[[ -z "${SITE_ORIGIN:-}" ]]   && missing+=(SITE_ORIGIN)
if (( ${#missing[@]} > 0 )); then
  echo "missing required environment variables: ${missing[*]}" >&2
  exit 1
fi

FUNCTIONS_URL="https://${PROJECT_REF}.supabase.co/functions/v1"

run() {
  if [[ "$DRY_RUN" == true ]]; then
    printf '+ %s\n' "$*"
  else
    "$@"
  fi
}

echo "==> linking project"
run pnpm exec supabase link --project-ref "$PROJECT_REF"

echo "==> pushing migrations"
run pnpm exec supabase db push

echo "==> setting secrets"
run pnpm exec supabase secrets set \
  "ADMIN_PASSWORD=${ADMIN_PASSWORD}" \
  "ALLOWED_ORIGIN=${SITE_ORIGIN}"

# Optional. Without these the admin screen simply hides the "send by email"
# button; everything else works, so a missing mail account never blocks a
# deploy.
if [[ -n "${BREVO_API_KEY:-}" ]]; then
  echo "==> setting mail secrets"
  run pnpm exec supabase secrets set \
    "BREVO_API_KEY=${BREVO_API_KEY}" \
    "BREVO_SENDER_EMAIL=${BREVO_SENDER_EMAIL:-}" \
    "BREVO_SENDER_NAME=${BREVO_SENDER_NAME:-}" \
    "EVENT_CONTACT=${EVENT_CONTACT:-}"
else
  echo "==> mail secrets skipped (set BREVO_API_KEY to enable code emails)"
fi

# Secrets only take effect on redeploy, so this must follow the step above.
echo "==> deploying functions"
run pnpm exec supabase functions deploy lookup --no-verify-jwt \
  --project-ref "$PROJECT_REF"
run pnpm exec supabase functions deploy admin-import --no-verify-jwt \
  --project-ref "$PROJECT_REF"
run pnpm exec supabase functions deploy admin-data --no-verify-jwt \
  --project-ref "$PROJECT_REF"
run pnpm exec supabase functions deploy send-codes --no-verify-jwt \
  --project-ref "$PROJECT_REF"

if [[ "$DRY_RUN" == true ]]; then
  echo "dry run complete; skipping smoke tests"
  exit 0
fi

echo "==> smoke test 1/6: gateway is not swallowing requests"
body=$(curl -sS -X POST "${FUNCTIONS_URL}/lookup" \
  -H "Content-Type: application/json" \
  -d '{"name":"존재하지않음","code":"XXXXXX"}')
if ! grep -q '"error"' <<<"$body"; then
  echo "FAIL: expected an application error body, got: $body" >&2
  echo "The platform JWT gateway is rejecting requests. Redeploy with" >&2
  echo "--no-verify-jwt." >&2
  exit 1
fi
echo "    ok"

# This check only means anything against a real deployment. Local
# `supabase functions serve` overrides Access-Control-Allow-Origin with `*` and
# drops the Vary header, so running this against localhost always fails even
# when cors.ts is correct -- the same class of local/production divergence as
# the JWT gateway. Do not "fix" a local failure by loosening this assertion.
echo "==> smoke test 2/6: CORS allows the site origin"
first_origin="${SITE_ORIGIN%%,*}"
allow=$(curl -sS -X OPTIONS "${FUNCTIONS_URL}/lookup" \
  -H "Origin: ${first_origin}" \
  -D - -o /dev/null \
  | tr -d '\r' \
  | awk -F': ' 'tolower($1) == "access-control-allow-origin" { print $2 }')
if [[ "$allow" != "$first_origin" ]]; then
  echo "FAIL: expected Allow-Origin '${first_origin}', got '${allow}'" >&2
  exit 1
fi
echo "    ok"

echo "==> smoke test 3/6: the admin password actually took effect"
login=$(curl -sS -X POST "${FUNCTIONS_URL}/admin-data" \
  -H "Authorization: Bearer ${ADMIN_PASSWORD}" \
  -H "Content-Type: application/json" \
  -d '{"action":"login"}')
if ! grep -q '"token"' <<<"$login"; then
  echo "FAIL: login did not return a token, got: $login" >&2
  echo "The secret was not applied, or the functions were not redeployed" >&2
  echo "after it changed." >&2
  exit 1
fi
echo "    ok"

echo "==> smoke test 4/6: admin-data reaches the function, not the gateway"
# Reuses the token from the previous check: admin-data no longer accepts the
# password on anything but `login`.
tok=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' <<<"$login")
adm=$(curl -sS -X POST "${FUNCTIONS_URL}/admin-data" \
  -H "Authorization: Bearer ${tok}" \
  -H "Content-Type: application/json" \
  -d '{"action":"list_matches"}')
if ! grep -q '"matches"' <<<"$adm"; then
  echo "FAIL: expected a matches array, got: $adm" >&2
  echo "If this shows a gateway 401, redeploy admin-data with --no-verify-jwt." >&2
  exit 1
fi
echo "    ok"

echo "==> smoke test 5/6: send-codes answers and records its own URL"
snd=$(curl -sS -X POST "${FUNCTIONS_URL}/send-codes" \
  -H "Authorization: Bearer ${tok}" \
  -H "Content-Type: application/json" \
  -d '{"action":"status"}')
if ! grep -q '"pending"' <<<"$snd"; then
  echo "FAIL: expected a status body, got: $snd" >&2
  echo "If this shows a gateway 401, redeploy send-codes with --no-verify-jwt." >&2
  exit 1
fi
echo "    ok"

if [[ -n "${ANON_KEY:-}" ]]; then
  echo "==> smoke test 6/6: RLS blocks the REST endpoint"
  rest=$(curl -sS "https://${PROJECT_REF}.supabase.co/rest/v1/participants?select=name" \
    -H "apikey: ${ANON_KEY}")
  if grep -q '"name"' <<<"$rest"; then
    echo "FAIL: participant data is readable via REST. Check RLS now." >&2
    exit 1
  fi
  echo "    ok"
else
  echo "==> smoke test 6/6: skipped (set ANON_KEY to enable the RLS check)"
fi

echo
echo "deploy complete"
