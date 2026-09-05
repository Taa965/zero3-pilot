# AWS Quick Deploy resource graph

AWS Quick Deploy is an official convenience template, not a Zero3 Pilot protocol dependency. The same application must run unchanged on non-AWS Linux hosts.

## Proposed CloudFormation graph

```text
AWS::EC2::SecurityGroup
  |-- inbound 443 from operator-configured CIDRs (default 0.0.0.0/0 only when explicitly public)
  |-- inbound 22 disabled by default; SSM is preferred
  |-- outbound HTTPS/DNS as required
  v
AWS::EC2::Instance
  |-- AWS::IAM::InstanceProfile -> minimal SSM/CloudWatch policy
  |-- encrypted root EBS
  |-- cloud-init installs Zero3 Pilot + reverse proxy
  |-- no long-lived AWS access key written to Zero3 Pilot config
  v
AWS::EC2::EIP (optional but recommended for direct-host mode)
  |
  +--> AWS::Route53::RecordSet (optional, only when HostedZoneId is supplied)

Optional managed-TLS mode:
AWS::ElasticLoadBalancingV2::LoadBalancer
  -> AWS::ElasticLoadBalancingV2::TargetGroup
  -> EC2 instance loopback/reverse-proxy ingress path
AWS::CertificateManager::Certificate
  -> HTTPS listener
```

## Parameters

CloudFormation parameters are deployment inputs only:

- `InstanceType`;
- `VpcId` / `SubnetId` or a documented default-VPC path;
- `AllowedHttpsCidrs`;
- optional `HostedZoneId` + `Hostname`;
- release version/image digest;
- optional `EnableManagedTls`;
- optional operator SSH key name only when SSH access is explicitly enabled.

Pairing codes, node credentials, H5 control tokens, executor credentials, ChatGPT/Codex auth state, and provider API keys are not CloudFormation parameters.

## Secret bootstrap

The template may create empty secure locations or generate server-side bootstrap material during first boot, but it must never require the user to paste a long-lived AWS access key into Zero3 Pilot.

Preferred AWS administration path:

- CloudFormation execution uses the caller's normal AWS identity outside Zero3 Pilot;
- instance administration uses SSM Session Manager via instance role;
- application secrets live as root/service-readable local files or, in a later optional integration, are fetched from a provider secret manager by instance role;
- Zero3 Pilot receives only its own application credentials/files.

## Network/TLS modes

### Direct host (lowest cost)

EIP -> Caddy/nginx -> `127.0.0.1:8787`. Public hostname is required for public ACME TLS.

### Managed TLS

ALB + ACM -> host reverse proxy/application. More expensive but removes certificate lifecycle from the VM.

The CloudFormation implementation must choose one clearly; it must not silently downgrade public HTTPS to HTTP when certificate or DNS setup fails.

## Health and update contract

- instance/bootstrap waits for `GET /health` to return `status=ok`;
- deployment output includes the HTTPS base URL only after TLS is valid;
- upgrades stage an immutable release/image and preserve `/var/lib/zero3-pilot` plus secret files;
- failed health verification restores the prior release;
- CloudFormation replacement policies must preserve application data or fail closed with an explicit migration warning.

## Required template tests before merge

- `cfn-lint` / CloudFormation validation;
- no public SSH by default;
- no wildcard IAM permissions beyond a reviewed unavoidable AWS-managed policy;
- encrypted EBS enabled;
- no AWS access-key parameters;
- no application secret values in stack outputs;
- HTTPS does not silently degrade;
- user-data is idempotent;
- application health check validates the intended release identity.

No CloudFormation file is added in Wave 0 because the generic self-host packaging and pairing backend are not yet frozen. This document is the resource/authority contract the later template must satisfy.