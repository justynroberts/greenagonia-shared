# CLAUDE.md — Greenagonia

Greenagonia is PagerDuty's fictional demo company. This parent directory groups
two related but independent projects with different user models.

## Layout

| Directory | Purpose | User model |
|---|---|---|
| `single-user/` | Control plane: Terraform + Go CLI that stands up a full Greenagonia environment in a real PagerDuty account and drives incident scenarios through it. Git repo (`justynroberts/greenagonia`). | Single user — your admin API token, your laptop. State in `~/.greenagonia/<env>.json`. |
| `shared-usage/shared-site/` | Storefront: static e-commerce demo site whose checkout fails on demand and posts alerts to PagerDuty Events API v2 from the browser. No build step; serve with `python3 -m http.server 8080`. | Multi-user — each browser holds its own routing key (localStorage). Shareable via `?pdkey=<key>` URL. |
| `shared-terraform/` | (placeholder) Terraform for the shared/multi-user deployment. | — |

## The contract between them

The two projects share exactly two things — keep these in sync:

1. **Use-case payloads.** The site's default failure emits an exact replica of
   the `bad-payment-deploy` scenario, step 1 ("Card processor timeouts"), env
   `demo`, as built by `single-user/cli/main.go`. The copy lives in
   `shared-usage/shared-site/chaos.js` (`pdEvent` field). If the CLI scenario
   changes, update the site copy.
2. **Routing key.** The site should be given the *event orchestration* routing
   key from `~/.greenagonia/<env>.json` (`routing_key`) — the orchestration
   routes on `payload.custom_details.service`, landing alerts on the right
   technical service. Dedup keys match the CLI's
   (`greenagonia/<env>/<scenario>/<service>/<step>`), so
   `./bin/greenagonia scenarios resolve` closes incidents the site created.

## Quick reference

```bash
# environment up (single-user/)
cd single-user && ./quickstart.sh

# storefront (shared-usage/shared-site/)
cd shared-usage/shared-site && python3 -m http.server 8080
# open http://localhost:8080/?pdkey=<routing_key from ~/.greenagonia/demo.json>
```

Site specifics (ops console, hidden triggers, failure scenarios): see
`shared-usage/shared-site/README.md`.
