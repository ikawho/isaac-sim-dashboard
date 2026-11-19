#!/usr/bin/env bash
# Isaac Sim Dashboard - deploy and tear down from AWS CloudShell (or any shell with AWS CLI + SAM CLI)
#
#   ADMIN_EMAIL=you@company.com ACCEPT_EULA=Y ./isaac.sh up   # first deployment
#   ./isaac.sh up                                             # update (previous values are reused)
#   ./isaac.sh down                                           # delete EVERYTHING (including files!)
#   ./isaac.sh status
#
# Optional variables: STACK_NAME, AWS_REGION, INSTANCE_TYPE, FALLBACK_INSTANCE_TYPES, MAX_SESSION_HOURS, ISAAC_IMAGE
set -euo pipefail
cd "$(dirname "$0")"

STACK="${STACK_NAME:-isaac-sim-dashboard}"
REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || echo eu-central-1)}"
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*" >&2; }
die()  { printf '\033[1;31mXX\033[0m  %s\n' "$*" >&2; exit 1; }

[[ "$STACK" =~ ^[a-z][a-z0-9-]{2,40}$ ]] || die "STACK_NAME may only contain lowercase letters, digits and '-' (3-41 characters)."
[[ "$STACK" == *aws* || "$STACK" == *amazon* || "$STACK" == *cognito* ]] && die "STACK_NAME must not contain 'aws', 'amazon' or 'cognito'."

stack_exists() { aws cloudformation describe-stacks --stack-name "$STACK" >/dev/null 2>&1; }
output()       { aws cloudformation describe-stacks --stack-name "$STACK" \
                   --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
prev_param()   { aws cloudformation describe-stacks --stack-name "$STACK" \
                   --query "Stacks[0].Parameters[?ParameterKey=='$1'].ParameterValue" --output text 2>/dev/null || true; }

up() {
  command -v sam >/dev/null || die "SAM CLI is missing (it is preinstalled in CloudShell)."
  local email="${ADMIN_EMAIL:-}" eula="${ACCEPT_EULA:-}"
  if stack_exists; then
    [[ -z "$email" ]] && email="$(prev_param AdminEmail)"
    [[ -z "$eula"  ]] && eula="$(prev_param AcceptNvidiaEula)"
  fi
  [[ -n "$email" && "$email" != "None" ]] || die "First deployment: ADMIN_EMAIL=you@company.com ACCEPT_EULA=Y ./isaac.sh up"
  [[ "$eula" == "Y" ]] || die "Please read the NVIDIA Omniverse License Agreement and accept it with ACCEPT_EULA=Y."

  local params=("AdminEmail=$email" "AcceptNvidiaEula=Y")
  [[ -n "${INSTANCE_TYPE:-}"     ]] && params+=("InstanceType=$INSTANCE_TYPE")
  [[ -n "${FALLBACK_INSTANCE_TYPES+x}" ]] && params+=("FallbackInstanceTypes=$FALLBACK_INSTANCE_TYPES")
  [[ -n "${MAX_SESSION_HOURS:-}" ]] && params+=("MaxSessionHours=$MAX_SESSION_HOURS")
  [[ -n "${ISAAC_IMAGE:-}"       ]] && params+=("IsaacSimImage=$ISAAC_IMAGE")

  say "Deploying stack '$STACK' to $REGION (the first time takes about 5-10 minutes, CloudFront is slow) ..."
  sam deploy \
    --template-file template.yaml \
    --stack-name "$STACK" \
    --region "$REGION" \
    --resolve-s3 \
    --capabilities CAPABILITY_IAM \
    --no-confirm-changeset \
    --no-fail-on-empty-changeset \
    --parameter-overrides "${params[@]}"

  local site files api domain client dist url
  site=$(output WebsiteBucketName); api=$(output ApiUrl); domain=$(output CognitoDomain)
  client=$(output UserPoolClientId); dist=$(output DistributionId); url=$(output DashboardUrl)

  say "Uploading frontend to s3://$site ..."
  local build; build=$(mktemp -d)
  cp -r frontend/. "$build/"
  cat > "$build/config.js" <<EOF
window.APP_CONFIG = {
  apiUrl: "$api",
  cognitoDomain: "$domain",
  clientId: "$client",
  region: "$REGION"
};
EOF
  aws s3 sync "$build/" "s3://$site/" --delete --only-show-errors
  rm -rf "$build"
  aws cloudfront create-invalidation --distribution-id "$dist" --paths "/*" >/dev/null

  check_quota

  echo
  say "Done. Dashboard: $url"
  say "The first admin ($email) receives a temporary password by email."
}

check_quota() {
  # L-DB2E81BA = "Running On-Demand G and VT instances" (vCPUs)
  local q
  q=$(aws service-quotas get-service-quota --service-code ec2 --quota-code L-DB2E81BA \
        --query 'Quota.Value' --output text 2>/dev/null || echo "?")
  if [[ "$q" != "?" ]] && (( ${q%.*} < 8 )); then
    warn "Your vCPU quota for G instances in $REGION is $q. g6e.2xlarge needs 8 vCPUs per user."
    warn "Request an increase: aws service-quotas request-service-quota-increase --service-code ec2 --quota-code L-DB2E81BA --desired-value 32"
  fi
}

down() {
  stack_exists || { warn "Stack '$STACK' does not exist."; return 0; }
  if [[ "${1:-}" != "-y" ]]; then
    read -r -p "Delete EVERYTHING in '$STACK' ($REGION) - including all users, machines and files? [yes/N] " a
    [[ "$a" == "yes" ]] || die "Aborted."
  fi
  local site files
  site=$(output WebsiteBucketName); files=$(output FilesBucketName)

  say "Terminating all Isaac Sim instances ..."
  local ids
  ids=$(aws ec2 describe-instances \
          --filters "Name=tag:Project,Values=$STACK" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
          --query 'Reservations[].Instances[].InstanceId' --output text)
  if [[ -n "$ids" ]]; then
    aws ec2 terminate-instances --instance-ids $ids >/dev/null
    aws ec2 wait instance-terminated --instance-ids $ids
  fi

  say "Deleting the users' security groups ..."
  for sg in $(aws ec2 describe-security-groups --filters "Name=tag:Project,Values=$STACK" \
                --query 'SecurityGroups[].GroupId' --output text); do
    for _ in 1 2 3 4 5 6; do
      aws ec2 delete-security-group --group-id "$sg" 2>/dev/null && break
      sleep 10
    done
  done

  say "Emptying S3 buckets ..."
  for b in "$site" "$files"; do
    [[ -n "$b" && "$b" != "None" ]] && aws s3 rm "s3://$b" --recursive --only-show-errors || true
  done

  say "Deleting stack '$STACK' ..."
  # SAM deletes the uploaded code once per function; all functions share one package,
  # so the repeated "Could not find and delete the S3 object" lines are harmless.
  sam delete --stack-name "$STACK" --region "$REGION" --no-prompts 2>&1 \
    | grep -v "Could not find and delete the S3 object" || true
  stack_exists && die "Stack '$STACK' still exists - check the CloudFormation console."
  say "Everything removed."
}

status() {
  stack_exists || { warn "Stack '$STACK' does not exist."; return 0; }
  aws cloudformation describe-stacks --stack-name "$STACK" \
    --query 'Stacks[0].[StackStatus, Outputs[?OutputKey==`DashboardUrl`].OutputValue | [0]]' --output text
  aws ec2 describe-instances --filters "Name=tag:Project,Values=$STACK" \
    "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[].Instances[].[Tags[?Key==`OwnerEmail`].Value|[0], InstanceType, State.Name, PublicIpAddress]' \
    --output table
}

case "${1:-}" in
  up)     up ;;
  down)   down "${2:-}" ;;
  status) status ;;
  *) echo "Usage: $0 up | down [-y] | status"; exit 1 ;;
esac
