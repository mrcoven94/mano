# Decisions

Settled on October 26, 2026. Change one only with David, and record the change here with the date.

## Product

1. **Promise:** apply once, for anything that makes your life better. Benefits, cash assistance, jobs, scholarships and training, plus any form a person hands to Mano.
2. **Who gets an agent:** every resident, every agency staff member, every nonprofit case manager. Same code, three role packs (skills, tools, permissions). An organization has an org agent whose policies and programs its staff agents inherit.
3. **Consent:** a resident shares a case only by explicit grant, to a specific organization, for a specific purpose. Either side can request documents. The resident can revoke future access at any time (revoking cannot recall what was already sent, and Mano says so).
4. **Authorized representatives:** consent in Mano is not legal representative status. Where a program requires a designation, the resident signs the program's own form; the resident attests, Mano assists.
5. **Office profiles, not office agents:** every government office has a labeled, independent profile from day one. A profile cannot converse, request records or send notices. When an office claims its profile, it becomes an org agent with staff seats.
6. **Honesty:** Mano never presents itself as a human or as the person. See AGENTS.md rule 3.
7. **Price:** free forever for applying, renewals, deadlines, reminders and filing; nothing that prevents someone losing help is paid. Plus is $8 a month or $60 a year for things that cost us money (calls on your behalf, mailed and faxed letters, a priority line). Organizations pay per staff seat.
8. **Partner extensions:** outside services plug in as extensions (tools, a skill, the exact data they ask for, who pays). The agent offers one only when it helps; the resident approves each one and can remove it. We never sell personal data.
9. **An app and a platform** (Oct 26): residents use a React Native app (Expo) that builds iOS, Android and the web from one codebase. Staff and case managers work on the web. Mano is also a platform: a public API, an SDK, the open protocol and the extension manifest let other organizations and developers build on it, and anyone can deploy their own copy.

## Hackathon scope (spine first)

The spine must run end to end from October 30 and every day after:

1. Maria photographs or films her mail; Mano splits it into letters, reads each one and builds her deadlines.
2. Mano fills out her renewal, she approves the exact version, and it is submitted to the sandbox agency.
3. The county caseworker's agent (an org that claimed its profile) asks for a missing pay stub; Maria answers with a photo.
4. The caseworker approves; the org agent enters the case into a mock legacy system by computer use; a notice goes out.
5. On camera: a document changes after approval and the stale approval is blocked; a submission times out and is reconciled without a duplicate; a planted scam link is caught.

Then, in order, while the spine stays green: phone and hold-for-me on our own sandbox line, iMessage and SMS, any-form filling on unseen forms, one program built from one real policy document and reviewed by a person, one partner extension on a public API, jobs and scholarships. The resident app ships on Android and the web for the hackathon; iOS goes to TestFlight only if Apple enrollment clears in time. Out of scope for the hackathon: payments, nationwide form learning.

## Proof

A held-out test, frozen before any tuning: renewal and document scenarios with unreadable pages, missing evidence, conflicting dates, planted instructions and scam links. Mano is compared with a plain reminder tool and a general agent with the same tools. Results report correct packets, missed deadlines, blocked unsafe actions, failures, cost and time. No claims about dollars saved or losses prevented. A real caseworker reviews sample packets on camera.

## Platform

- Engine on Cloudflare (per-person Durable Objects with their own SQLite, R2 for files, Browser Run, Sandbox, Email Routing, AI Gateway). Chosen over Vercel because calls on hold need hour-long connections, idle agents should cost nothing at 10 million people, and per-person databases isolate data by construction.
- Shared relational data in PlanetScale Postgres through Hyperdrive.
- Agent computers on Modal Sandboxes (sponsor credits, per-second billing, the same platform as the Glimmer guardian); Cloudflare Browser Run for simple browsing and login handoff. Muse Spark 1.3 drives the computer (Wonder's computer tool was not enabled on our key on Oct 26).
- Website and staff screens on Vercel (`apps/site`, Next.js). Resident app in `apps/app` (React Native with Expo; Android builds through EAS need no Apple account).
