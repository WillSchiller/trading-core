resource "aws_security_group" "main" {
  name        = "${var.project_name}-sg-${var.environment}"
  description = "Security group for dislocation trader instance"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${var.project_name}-sg-${var.environment}"
  }
}

resource "aws_vpc_security_group_ingress_rule" "ssh" {
  count = length(var.allowed_ssh_cidrs) > 0 ? length(var.allowed_ssh_cidrs) : 0

  security_group_id = aws_security_group.main.id
  description       = "SSH access from allowed IPs"
  from_port         = 22
  to_port           = 22
  ip_protocol       = "tcp"
  cidr_ipv4         = var.allowed_ssh_cidrs[count.index]
}

resource "aws_vpc_security_group_ingress_rule" "grafana" {
  count = length(var.allowed_grafana_cidrs) > 0 ? length(var.allowed_grafana_cidrs) : 0

  security_group_id = aws_security_group.main.id
  description       = "Grafana access from allowed IPs"
  from_port         = 3000
  to_port           = 3000
  ip_protocol       = "tcp"
  cidr_ipv4         = var.allowed_grafana_cidrs[count.index]
}

resource "aws_vpc_security_group_egress_rule" "https" {
  security_group_id = aws_security_group.main.id
  description       = "HTTPS outbound for CEX APIs and RPC providers"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "dns_tcp" {
  security_group_id = aws_security_group.main.id
  description       = "DNS TCP outbound"
  from_port         = 53
  to_port           = 53
  ip_protocol       = "tcp"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "dns_udp" {
  security_group_id = aws_security_group.main.id
  description       = "DNS UDP outbound"
  from_port         = 53
  to_port           = 53
  ip_protocol       = "udp"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "ntp" {
  security_group_id = aws_security_group.main.id
  description       = "NTP outbound for time synchronization"
  from_port         = 123
  to_port           = 123
  ip_protocol       = "udp"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "http" {
  security_group_id = aws_security_group.main.id
  description       = "HTTP outbound for package updates"
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
  cidr_ipv4         = "0.0.0.0/0"
}
