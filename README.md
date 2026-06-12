# Greenagonia — shared demo environment

Terraform and static storefront for the **shared** Greenagonia PagerDuty demo.
Multiple admins each get an isolated full-stack demo inside one PagerDuty account,
driven by a hosted e-commerce site whose checkout fails on demand.

> The single-user CLI environment (Terraform + Go, 7 scenarios) lives in the companion
> repo [justynroberts/greenagonia](https://github.com/justynroberts/greenagonia).

## Layout

```
shared-terraform/         Terraform: per-admin + shared PagerDuty resources
shared-usage/shared-site/ Static storefront: chaos engine, ops console
ADMIN-GUIDE.md            Setup and demo walkthrough for new admins
```

## Quick start

```bash
cd shared-terraform
./setup.sh setup     # wizard: token, region, time zone, Slack, first admin
./setup.sh deploy    # terraform plan → confirm → apply; prints per-admin links
```

## What gets created

**Per admin** (keyed by 2–4 capital initials, e.g. `JR`):

- 1 PagerDuty user (their real email — they get the pages)
- 1 team (`JR-SRE-TEAM`) with 5 personas as responders
- 8 technical services + 2 business services, all prefixed `JR-`
- 3 schedules (primary Mon–Fri 09–17, secondary + tertiary persona rotations)
- 1 escalation policy
- 1 event orchestration + routing key
- (optional) per-admin Slack incidents channel + PagerDuty Slack connection

**Shared, created once:**

- 5 generic personas — Sarah SRE, Dan Developer, Matt Manager, Pablo Platform, Sam Security
- Greenagonia public team (all personas + all admins)
- 5 platform services — `api-gateway`, `data-platform`, `identity-service`, `infrastructure`, `platform-engineering`
- 1 shared platform event orchestration
- 4 automation actions bound to every technical service
- 4 incident workflows (opt-in: Major Incident, Security Incident, Status Page, Rollback)
- `greenagonia-incidents` Slack channel + PagerDuty Slack connection

## Secrets and state

`setup.sh` stores all secrets in `secrets.auto.tfvars.json` (chmod 600) and
configuration in `config.auto.tfvars.json`. **Both are gitignored.** State is
local (`terraform.tfstate`, also gitignored). See `terraform.tfvars.example`
for the full variable shape.

## See also

- [shared-terraform/README.md](shared-terraform/README.md) — Terraform reference, all resources, gotchas
- [shared-usage/shared-site/README.md](shared-usage/shared-site/README.md) — storefront: ops console, change events, URL params
- [ADMIN-GUIDE.md](ADMIN-GUIDE.md) — end-to-end setup and demo walkthrough
