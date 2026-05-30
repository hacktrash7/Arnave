# Security Specification - TFA Team CRM

## Data Invariants
1. A Lead must have a valid status and contact information.
2. A Log entry must record a valid action and timestamp.
3. Only authorized Agents/Admins can access Lead data.
4. Agents can only see Leads assigned to them.
5. OTPs are short-lived and tied to a specific email.

## The "Dirty Dozen" (Attack Vectors)
1. **Unauthenticated Write**: Attempting to create a lead without being signed in.
2. **Identity Spoofing**: An agent trying to read leads assigned to another agent.
3. **Privilege Escalation**: An agent trying to delete another agent or access the OTP panel.
4. **ID Poisoning**: Injecting a 2KB string as a Lead ID.
5. **Shadow Update**: Updating a lead with an `isVerified: true` field that isn't in the schema.
6. **Orphaned Writes**: Creating a log entry for a non-existent lead.
7. **Timestamp Fraud**: Providing a backdated `createdAt` timestamp from the client.
8. **Bulk Scraping**: Attempting to list all Leads without an assignment filter.
9. **OTP Harvest**: Attempting to read all OTPs from the `otps` collection.
10. **Agent Deactivation Bypass**: A deactivated agent trying to access their dashboard.
11. **PII Leak**: Accessing an agent's contact number without authority.
12. **Status Shortcircuit**: Jumping a lead from "New" to "Converted" by-passing intermediate steps (if restricted).

## Test Cases (To be implemented in firestore.rules.test.ts)
- `test_unauthenticated_read_denied`
- `test_agent_access_others_leads_denied`
- `test_admin_full_access_allowed`
- `test_invalid_lead_schema_denied`
