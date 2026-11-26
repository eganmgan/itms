# ITMS Server Installation and Change Approval SOP

## Document Control

- **Purpose:** Define the approvals and controls required before provisioning or installing ITMS on a server.
- **Owner:** ITMS Service Owner (assign an internal role or person).
- **Applies to:** New, replacement, staging, production, and additional ITMS servers.
- **Status:** Approval workflow template. Map the roles below to the organization's current approval matrix before use.

## 1. Purpose and Scope

Use this SOP to request, assess, approve, implement, verify, and close work involving an ITMS server. This includes:

- Server or cloud resource procurement and provisioning.
- Operating system, network, firewall, DNS, and TLS changes.
- ITMS frontend, backend, PostgreSQL, Docker, and nginx installation.
- Optional integrations such as Salt, Wazuh, and OpenSCAP.
- Production cutover, data migration, shared-database, or high-availability changes.

This SOP does not itself authorize a purchase, production change, data transfer, or access grant. Each requires approval from the applicable role under company policy.

## 2. Approval Principles

1. Obtain written approval in the organization's change/request system before procurement, provisioning, installation, or production access.
2. Record the target environment, exact scope, planned release commit, implementation window, validation plan, and rollback plan.
3. Treat a fresh installation as a separate system with a new database unless an approved architecture explicitly says otherwise. Two independent installations do not provide high availability.
4. Moving or copying live ITMS data is a separate, explicitly approved activity. The GitHub repository contains application files, not the live database.
5. Never put passwords, tokens, private keys, `.env` files, database dumps, or personal data in GitHub, approval tickets, or generated runbooks. Reference the approved secrets vault instead.
6. Use least privilege, approved administrator accounts, MFA where available, and time-bound access.
7. Silence is not approval. A scope, host, data, or implementation-window change requires reassessment and renewed approval.

## 3. Roles and Required Reviews

Map these role names to the organization's formal authority matrix. One person may hold more than one role only where policy permits; the requester must not approve their own request.

| Role | Review / approval responsibility |
|---|---|
| Requester | Business need, requested scope, target, impact, and completion evidence. |
| Business or service owner | Confirms need, users, service impact, acceptance criteria, and operational ownership. |
| ITMS technical owner | Confirms supported design, release, resource needs, dependencies, and test plan. |
| Infrastructure / cloud owner | Approves compute, storage, OS, network placement, firewall, DNS, and backup capability. |
| Information Security | Reviews exposure, access, patching, TLS, secrets handling, logging, and security controls. |
| Data owner / DBA | Required for database access, shared databases, backup/restore, migration, retention, or data classification changes. |
| Network / DNS owner | Required for routing, firewall rules, load balancers, public endpoints, or DNS/TLS changes. |
| Change Manager / CAB | Approves production change window, risk, communications, go/no-go, and rollback criteria. |
| Procurement / Finance | Required when new hardware, cloud capacity, licenses, or ongoing costs are incurred. |

The ITMS Service Owner records the final decision and confirms that all required approvals are present.

## 4. Approval Workflow

### Step 1: Submit the request

Create a ticket in the approved request/change system. Complete the request form in Section 8. Attach diagrams and non-sensitive evidence only. Do not attach credentials, production data, or database backups.

### Step 2: Triage and classify

The ITMS Service Owner checks that the request is complete and classifies it as:

- **Fresh installation:** New, separate ITMS instance and database.
- **Replacement or migration:** Existing service, configuration, or data will move.
- **Additional independent instance:** Separate system for another team, location, or environment.
- **High availability / load-balanced design:** Multiple application nodes or shared services.

If the request combines installation with production data migration or high availability, create explicit work items and obtain the additional reviews required for each.

### Step 3: Complete technical and security review

The relevant owners review:

- Host ownership, environment, OS/version, capacity, storage, backup, and recovery.
- Network paths and only the ports required by the approved design. PostgreSQL and Salt APIs must not be exposed publicly.
- DNS, TLS certificate ownership/renewal, ingress, and load-balancer requirements.
- Authentication, administrator access, MFA, secret storage, logging, monitoring, patching, and vulnerability management.
- ITMS components, integrations, data classification, retention, and any external dependencies.
- User impact, service downtime, testing, communications, recovery objectives, and rollback.
- Data migration method and approval, if any. A fresh installation must not silently import production data.

Resolve review findings before requesting final production approval.

### Step 4: Obtain written approvals

Collect the decisions required by the organization's approval matrix. At minimum, the service owner and infrastructure owner approve a new host; Security reviews production exposure; and the Change Manager/CAB approves a production change window. Add Data Owner/DBA, Network/DNS, and Procurement/Finance approvals when their scope applies.

Record each approver, decision, date/time, conditions, and ticket reference. Approval is valid only for the documented hosts, release, scope, and window.

### Step 5: Prepare the change

Before the approved window:

- Confirm host access, capacity, OS baseline, time synchronization, DNS/TLS, firewall, monitoring, and backup destination.
- Confirm the exact repository and immutable commit/release to deploy. The repository is private; arrange authorized, least-privilege read access for the server without using a personal token in scripts.
- Review the applicable installation runbook and validate every host-specific value.
- Create and verify a restorable backup before changing an existing service or migrating data.
- Confirm rollback steps, decision owner, communications, and acceptance tests.
- Confirm secrets are available through the approved secrets manager and are not present in the repository or ticket.
- Hold a go/no-go check with the change owner and required approvers.

Do not begin if approval is missing, the target differs from the ticket, backups are unverified, or the rollback path is unclear.

### Step 6: Install only the approved scope

Follow the current repository installation documentation and approved runbook. Install only the approved components and integrations. Keep host-specific `.env` and secret files on the server with restrictive permissions; never commit them.

For a fresh, independent installation, use a separate database and separately managed secrets. A shared database, data migration, load balancer, or active/standby design requires the additional architecture and data approvals described above.

### Step 7: Validate and obtain acceptance

Record command output or sanitized evidence for:

- Docker/Compose services and PostgreSQL health.
- Backend health and frontend delivery through nginx.
- TLS, firewall exposure, DNS, logs, monitoring, and backup job status.
- Approved user/role access and the business owner's acceptance criteria.
- Integration health, only for integrations included in the approval.

Use the repository's verification scripts where applicable, including `scripts/verify-itms-stack.sh` and `scripts/smoke-test-itms-nginx.sh`. Run data-mutating API smoke tests only in a test environment or under explicit production approval with an agreed cleanup plan.

If checks fail, stop the rollout, notify the change owner, and use the approved rollback or recovery plan. Do not restore the database as a routine application rollback.

### Step 8: Close the change

Attach sanitized verification evidence to the ticket. Record the deployed commit, host inventory, configuration/vault references, monitoring owner, backup/restore evidence, open issues, and business acceptance. Update the service inventory and close the change only after the owner confirms success or an approved rollback.

## 5. Production Data and Recovery

- A new-server installation does not include live records by default.
- Database export, transfer, import, or replication requires written approval from the Data Owner/DBA and Security, an approved encrypted transfer path, access restrictions, integrity checks, and a retention/deletion plan.
- Keep backups outside GitHub and outside generated runbooks. Restrict access and verify restoration before relying on a backup.
- Do not use production personal data in development or staging unless the data owner and Security approve the use and required protections.
- Document whether the new system is independent, a migration target, or part of an HA design; these are different operating models.

## 6. Rollback and Emergency Changes

The request must name rollback triggers, decision owner, time limit for the go/no-go decision, and recovery steps. Preserve the approved release and configuration backup before implementation.

For an emergency change, follow the organization's emergency-change policy. Record the reason, approver, scope, safeguards, and evidence as soon as possible; obtain retrospective review within the policy deadline. Emergency status does not waive security, data-protection, or credential-handling requirements.

## 7. ITMS References

- [ITMS Installation Guide](../INSTALLATION.md)
- [Second Server Deployment Guide](./second-server-deployment-guide.md)
- [Second Server Runbook Template](./second-server-runbook-template.md)
- [Deployment Handoff](./deployment-handoff.md)

Before executing a referenced guide, verify that its repository URL, target values, and commands match the approved request and current deployment. Never copy example credentials into a live system.

## 8. Approval Request Form

Copy this section into the organization's change/request system. Store sensitive values in the approved secrets manager and provide only the vault reference.

### Request details

| Field | Value |
|---|---|
| Request / change ticket | |
| Requester and department | |
| Business / service owner | |
| Business reason and expected outcome | |
| Environment (development / test / production) | |
| Installation type (fresh / replacement / independent instance / HA) | |
| Hostname, IP, location/provider, OS/version | |
| CPU, memory, storage, and estimated ongoing cost | |
| ITMS components and optional integrations | |
| DNS, TLS, network flows, and requested firewall ports | |
| Data classification and whether data will be migrated | |
| User impact, downtime, and maintenance window | |
| Repository, approved release/commit, and deployment owner | |
| Backup, restore evidence, rollback triggers, and rollback owner | |
| Validation plan and business acceptance criteria | |
| Monitoring, support owner, and handover plan | |
| Secrets vault reference (no secret values) | |

### Approval record

| Required role | Approver | Decision (approve / reject / conditional) | Date/time | Conditions / ticket reference |
|---|---|---|---|---|
| Business / service owner | | | | |
| ITMS technical owner | | | | |
| Infrastructure / cloud owner | | | | |
| Information Security | | | | |
| Data Owner / DBA (if applicable) | | | | |
| Network / DNS owner (if applicable) | | | | |
| Change Manager / CAB (production only) | | | | |
| Procurement / Finance (if applicable) | | | | |

- **Final decision:** Approved / Rejected / Deferred
- **Approved scope and conditions:**
- **Approved implementation window:**
- **Final decision recorded by:**
