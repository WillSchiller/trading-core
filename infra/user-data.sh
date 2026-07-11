#!/bin/bash
set -e

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get upgrade -y

apt-get install -y \
  apt-transport-https \
  ca-certificates \
  curl \
  gnupg \
  lsb-release \
  chrony \
  fail2ban \
  unattended-upgrades \
  awscli \
  jq

systemctl enable chrony
systemctl start chrony

curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

systemctl enable docker
systemctl start docker

usermod -aG docker ubuntu

wget https://github.com/docker/compose/releases/download/v2.24.0/docker-compose-linux-x86_64 -O /usr/local/bin/docker-compose
chmod +x /usr/local/bin/docker-compose

if [ -e /dev/nvme1n1 ]; then
  if ! blkid /dev/nvme1n1; then
    mkfs.ext4 /dev/nvme1n1
  fi

  mkdir -p /data/postgres

  if ! grep -q "/dev/nvme1n1" /etc/fstab; then
    echo "/dev/nvme1n1 /data/postgres ext4 defaults,nofail 0 2" >> /etc/fstab
  fi

  mount -a
  chown -R 999:999 /data/postgres
fi

wget https://s3.amazonaws.com/amazoncloudwatch-agent/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb -O /tmp/amazon-cloudwatch-agent.deb
dpkg -i /tmp/amazon-cloudwatch-agent.deb

cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json <<'EOF'
{
  "agent": {
    "metrics_collection_interval": 60,
    "run_as_user": "cwagent"
  },
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "/var/log/syslog",
            "log_group_name": "/aws/ec2/${project_name}-${environment}",
            "log_stream_name": "{instance_id}/syslog"
          },
          {
            "file_path": "/var/log/docker.log",
            "log_group_name": "/aws/ec2/${project_name}-${environment}",
            "log_stream_name": "{instance_id}/docker"
          }
        ]
      }
    }
  },
  "metrics": {
    "namespace": "CWAgent",
    "metrics_collected": {
      "cpu": {
        "measurement": [
          {"name": "cpu_usage_idle", "rename": "CPU_IDLE", "unit": "Percent"},
          {"name": "cpu_usage_iowait", "rename": "CPU_IOWAIT", "unit": "Percent"}
        ],
        "metrics_collection_interval": 60,
        "totalcpu": false
      },
      "disk": {
        "measurement": [
          {"name": "used_percent", "rename": "DISK_USED", "unit": "Percent"}
        ],
        "metrics_collection_interval": 60,
        "resources": ["*"]
      },
      "diskio": {
        "measurement": [
          {"name": "io_time"},
          {"name": "read_bytes", "unit": "Bytes"},
          {"name": "write_bytes", "unit": "Bytes"}
        ],
        "metrics_collection_interval": 60
      },
      "mem": {
        "measurement": [
          {"name": "mem_used_percent"}
        ],
        "metrics_collection_interval": 60
      },
      "netstat": {
        "measurement": [
          {"name": "tcp_established"},
          {"name": "tcp_time_wait"}
        ],
        "metrics_collection_interval": 60
      }
    }
  }
}
EOF

/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config \
  -m ec2 \
  -s \
  -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json

systemctl enable amazon-cloudwatch-agent
systemctl start amazon-cloudwatch-agent

cat > /etc/fail2ban/jail.local <<'EOF'
[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 5

[sshd]
enabled = true
port = ssh
logpath = /var/log/auth.log
EOF

systemctl enable fail2ban
systemctl start fail2ban

mkdir -p /home/ubuntu/app
chown ubuntu:ubuntu /home/ubuntu/app

echo "User-data script completed successfully" | tee /var/log/user-data-complete.log
