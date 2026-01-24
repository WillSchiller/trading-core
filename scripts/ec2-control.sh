#!/bin/bash
set -e

INSTANCE_NAME="dislocation-trader-production"
AWS_REGION="${AWS_REGION:-ap-southeast-1}"

get_instance_id() {
  aws ec2 describe-instances \
    --region "$AWS_REGION" \
    --filters "Name=tag:Name,Values=$INSTANCE_NAME" \
    --query 'Reservations[0].Instances[0].InstanceId' \
    --output text
}

get_instance_info() {
  aws ec2 describe-instances \
    --region "$AWS_REGION" \
    --instance-ids "$1" \
    --query 'Reservations[0].Instances[0].[State.Name,PublicIpAddress]' \
    --output text
}

case "${1:-status}" in
  start)
    INSTANCE_ID=$(get_instance_id)
    echo "Starting $INSTANCE_NAME ($INSTANCE_ID)..."
    aws ec2 start-instances --region "$AWS_REGION" --instance-ids "$INSTANCE_ID" > /dev/null
    echo "Waiting for instance to start..."
    aws ec2 wait instance-running --region "$AWS_REGION" --instance-ids "$INSTANCE_ID"
    INFO=$(get_instance_info "$INSTANCE_ID")
    IP=$(echo "$INFO" | awk '{print $2}')
    echo "Instance running at: $IP"
    echo "Grafana: http://$IP:3000"
    ;;

  stop)
    INSTANCE_ID=$(get_instance_id)
    echo "Stopping $INSTANCE_NAME ($INSTANCE_ID)..."
    aws ec2 stop-instances --region "$AWS_REGION" --instance-ids "$INSTANCE_ID" > /dev/null
    echo "Waiting for instance to stop..."
    aws ec2 wait instance-stopped --region "$AWS_REGION" --instance-ids "$INSTANCE_ID"
    echo "Instance stopped"
    ;;

  status)
    INSTANCE_ID=$(get_instance_id)
    INFO=$(get_instance_info "$INSTANCE_ID")
    STATUS=$(echo "$INFO" | awk '{print $1}')
    IP=$(echo "$INFO" | awk '{print $2}')
    echo "Instance: $INSTANCE_NAME ($INSTANCE_ID)"
    echo "Status: $STATUS"
    if [ "$STATUS" = "running" ] && [ "$IP" != "None" ]; then
      echo "IP: $IP"
      echo "Grafana: http://$IP:3000"
    fi
    ;;

  ssh)
    INSTANCE_ID=$(get_instance_id)
    IP=$(get_instance_info "$INSTANCE_ID" | awk '{print $2}')
    if [ "$IP" = "None" ] || [ -z "$IP" ]; then
      echo "Instance is not running"
      exit 1
    fi
    ssh ubuntu@"$IP"
    ;;

  logs)
    INSTANCE_ID=$(get_instance_id)
    IP=$(get_instance_info "$INSTANCE_ID" | awk '{print $2}')
    if [ "$IP" = "None" ] || [ -z "$IP" ]; then
      echo "Instance is not running"
      exit 1
    fi
    ssh ubuntu@"$IP" "cd /home/ubuntu/app && docker-compose -f docker/docker-compose.prod.yml logs -f --tail=100"
    ;;

  *)
    echo "Usage: $0 {start|stop|status|ssh|logs}"
    exit 1
    ;;
esac
