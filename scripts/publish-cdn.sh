#!/usr/bin/env bash
# Upload the UMD build to the platform's bucket (Alibaba Cloud OSS since
# 2026-10-26; R2 before), where the backend serves it as
# https://www.runapps.ai/sdk/<version>.js and /sdk/latest.js.
#
# Needs the bucket credentials in the environment (OSS_ACCESS_KEY_ID,
# OSS_ACCESS_KEY_SECRET, OSS_ENDPOINT, OSS_BUCKET, optional OSS_REGION);
# ~/.config/runapps/oss.env is sourced when present. Run after
# `npm run build` and the npm release:
#
#   npm run release:cdn            # uploads <version>.js and latest.js
#   npm run release:cdn -- --pin   # uploads <version>.js only
#   npm run release:cdn -- --check # lists what the bucket holds, uploads nothing
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f "$HOME/.config/runapps/oss.env" ] && . "$HOME/.config/runapps/oss.env"
: "${OSS_ACCESS_KEY_ID:?}" "${OSS_ACCESS_KEY_SECRET:?}" "${OSS_ENDPOINT:?}" "${OSS_BUCKET:?}"

# OSS speaks the S3 API, but only with virtual-hosted addressing, and it
# rejects the CLI's default aws-chunked checksums.
export AWS_ACCESS_KEY_ID="$OSS_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$OSS_ACCESS_KEY_SECRET"
export AWS_DEFAULT_REGION="${OSS_REGION:-oss-cn-hongkong}"
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
cfg=$(mktemp)
trap 'rm -f "$cfg"' EXIT
printf '[default]\ns3 =\n    addressing_style = virtual\n' > "$cfg"
export AWS_CONFIG_FILE="$cfg"

if [ "${1:-}" = "--check" ]; then
  aws s3 ls "s3://$OSS_BUCKET/sdk/" --endpoint-url "$OSS_ENDPOINT" | tail -5
  exit 0
fi

version=$(node -p "require('./package.json').version")
file=dist/agent.umd.js
[ -s "$file" ] || { echo "no $file — run npm run build first" >&2; exit 1; }
grep -q "@runappsai/agent $version" "$file" || echo "warning: $file does not mention $version; is the build current?" >&2

put() {
  aws s3 cp "$file" "s3://$OSS_BUCKET/sdk/$1" --endpoint-url "$OSS_ENDPOINT" \
    --content-type "application/javascript; charset=utf-8" --only-show-errors
  echo "uploaded sdk/$1 ($(wc -c < "$file") bytes)"
}
put "agent-$version.js"
[ "${1:-}" = "--pin" ] || put agent-latest.js
