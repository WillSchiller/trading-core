#!/bin/bash
set -e

AWS_REGION="${AWS_REGION:-ap-southeast-1}"
S3_BUCKET="${S3_BUCKET:-blockhelixasia}"
INSTANCE_NAME="${INSTANCE_NAME:-dislocation-trader-production}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Grafana Dashboard Sync ==="
echo "Region: $AWS_REGION"
echo "S3 Bucket: $S3_BUCKET"
echo "Instance: $INSTANCE_NAME"
echo ""

INSTANCE_ID=$(aws ec2 describe-instances \
  --region "$AWS_REGION" \
  --filters "Name=tag:Name,Values=$INSTANCE_NAME" \
  "Name=instance-state-name,Values=running" \
  --query 'Reservations[0].Instances[0].InstanceId' \
  --output text)

if [ "$INSTANCE_ID" = "None" ] || [ -z "$INSTANCE_ID" ]; then
  echo "ERROR: No running instance found with name $INSTANCE_NAME"
  exit 1
fi

INSTANCE_IP=$(aws ec2 describe-instances \
  --region "$AWS_REGION" \
  --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' \
  --output text)

echo "Found instance: $INSTANCE_ID at $INSTANCE_IP"
echo ""

echo "=== Uploading dashboards to S3 ==="
aws s3 sync "$PROJECT_DIR/grafana/" "s3://$S3_BUCKET/deploy/grafana/" --delete --region "$AWS_REGION"
echo "Upload complete."
echo ""

echo "=== Syncing to EC2 via SSM ==="
COMMAND_ID=$(aws ssm send-command \
  --region "$AWS_REGION" \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --parameters "commands=[
    \"cd /home/ubuntu/app\",
    \"mkdir -p grafana/provisioning grafana/dashboards\",
    \"aws s3 sync s3://$S3_BUCKET/deploy/grafana/ grafana/ --delete --exact-timestamps\",
    \"ls -la grafana/dashboards/\",
    \"docker restart dislocation-grafana 2>/dev/null || echo 'Grafana container not running'\",
    \"echo 'Sync complete'\"
  ]" \
  --query 'Command.CommandId' \
  --output text)

echo "SSM Command ID: $COMMAND_ID"
echo "Waiting for command to complete..."

for i in {1..30}; do
  STATUS=$(aws ssm get-command-invocation \
    --region "$AWS_REGION" \
    --command-id "$COMMAND_ID" \
    --instance-id "$INSTANCE_ID" \
    --query 'Status' \
    --output text 2>/dev/null || echo "Pending")

  if [ "$STATUS" = "Success" ]; then
    echo ""
    echo "=== Command Output ==="
    aws ssm get-command-invocation \
      --region "$AWS_REGION" \
      --command-id "$COMMAND_ID" \
      --instance-id "$INSTANCE_ID" \
      --query 'StandardOutputContent' \
      --output text
    break
  elif [ "$STATUS" = "Failed" ] || [ "$STATUS" = "Cancelled" ] || [ "$STATUS" = "TimedOut" ]; then
    echo ""
    echo "=== Command Failed ==="
    aws ssm get-command-invocation \
      --region "$AWS_REGION" \
      --command-id "$COMMAND_ID" \
      --instance-id "$INSTANCE_ID" \
      --query '[StandardOutputContent, StandardErrorContent]' \
      --output text
    exit 1
  fi

  printf "."
  sleep 2
done

echo ""
echo "=== Verifying Grafana ==="
sleep 5
if curl -sf --max-time 10 "http://$INSTANCE_IP:3000/api/health" > /dev/null 2>&1; then
  echo "Grafana is healthy!"
  echo ""
  echo "Access Grafana at: http://$INSTANCE_IP:3000"
else
  echo "Grafana health check failed (may still be starting)"
  echo "Try: http://$INSTANCE_IP:3000"
fi

echo ""
echo "=== Dashboard Sync Complete ==="
