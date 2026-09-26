# AI Telegram Account Management Panel

An AI-driven management system designed for **personal Telegram accounts** (not bots) using Telegram's MTProto protocol, AWS Bedrock vision models (Amazon Nova Pro), and AWS RDS PostgreSQL.

---

## Architecture Overview

```
Incoming Telegram Message (via GramJS MTProto socket)
   │
   ▼
[Layer 1: Scope & Blocklist Filter]
   ├── Check Chat Type: Ignore groups/channels unless in ALLOWED_GROUP_IDS
   └── Check User: Ignore immediately if in BLOCKED_USER_IDS
   │
   ▼
[Layer 2: Triage & Unanswered Detection]
   ├── Detect who sent the latest message (me vs user)
   └── Detect if reply is required vs conversation is closed ("Thanks!", "Noted")
   │
   ▼
[Layer 3: Safety & Human Escalation Guard]
   └── Detect sensitive flags: payments, disputes, anger, partnerships -> Escalates to Human Review
   │
   ▼
[Layer 4: Memory & Bedrock Multimodal Engine]
   ├── Retrieves contact background & past communication rules from RDS
   └── Analyzes text + photos/screenshots using Bedrock Converse API (Amazon Nova Pro)
   │
   ▼
[Layer 5: Mode Dispatcher]
   ├── Manual Mode: Record suggestion in DB, send nothing
   ├── Draft Mode: Queue draft in Dashboard for 1-click review/edit/send
   └── Auto-Pilot: Send automatically only if safe + high confidence; otherwise route to Approval Queue
```

---

## Project Structure

```
├── packages/
│   ├── brain/                 # Multi-layer AI decision engine
│   │   ├── filters/           # Whitelist, blocklist, chat scope guards
│   │   ├── triage/            # Unanswered detection & necessity analyzer
│   │   ├── safety/            # Sensitive topic & escalation guardrails
│   │   ├── memory/            # Knowledge base & context assembler
│   │   ├── generator/         # Bedrock Converse API (Amazon Nova Pro multimodal)
│   │   └── dispatcher/        # Manual / Draft / Auto-Pilot dispatcher
│   ├── worker/                # Persistent GramJS MTProto client daemon
│   │   ├── client.ts          # MTProto socket connection & session manager
│   │   ├── auth.ts            # Phone, OTP, and 2FA password login
│   │   ├── listener.ts        # Incoming event listener routing to Brain
│   │   └── sender.ts          # Telegram sender with typing indicators & delays
│   ├── db/                    # AWS RDS PostgreSQL (Drizzle ORM)
│   │   ├── schema.ts          # Chats, messages, approvals, memory, audit logs
│   │   └── index.ts           # Connection pool & client
│   └── web/                   # Management web dashboard & review UI
```

---

## Setup & Getting Started

### 1. Prerequisites
- Node.js >= 20.x, pnpm >= 9.x
- AWS RDS PostgreSQL database
- AWS Bedrock access with model **Amazon Nova Pro (`amazon.nova-pro-v1:0`)** enabled
- Telegram API ID and API Hash from [my.telegram.org](https://my.telegram.org)

### 2. Configure Environment
```bash
cp .env.example .env
# Fill in your DATABASE_URL, AWS Bedrock credentials, and Telegram API credentials
```

### 3. Push Database Schema to RDS
```bash
pnpm db:push
```

### 4. Build the Application
```bash
pnpm build
```

### 5. Choose One Runtime per Database

**Dashboard (recommended):** the web server embeds the Telegram worker. Configure
panel authentication and encryption as described below, then log in to Telegram
from the dashboard.
```bash
pnpm web:start
# Access the dashboard at http://localhost:3000 (HTTPS proxy in production)
```

**Headless alternative:** authenticate from the CLI, then start only the standalone
worker. Do not run this alongside the web server against the same database.
```bash
pnpm worker:auth
# Prompts for phone number, Telegram OTP, and 2FA password if enabled
pnpm worker:start
```

**Dashboard Capabilities:**
- **Emergency Kill Switch:** Instant halt button to kill all automated Telegram replies.
- **Operating Mode Switch:** Toggle between Manual, Draft, and Auto-Pilot on the fly.
- **Group & Chat Scope:** Whitelist Telegram groups and manage blocked user IDs dynamically.
- **Approval Queue:** One-click review, inline edit, and dispatch for high-risk / low-confidence replies.
- **Conversation Triage:** Real-time visibility into unanswered messages, reply necessity, and chat history.
- **LUMO Knowledge & Feedback Memory:** Stored safety rules, 24 supported Indian banks, and few-shot exemplars.
- **Audit Logs:** Full traceability for every AI perception, model evaluation, and human action.

## Regression checks

```bash
pnpm test
# Use a disposable PostgreSQL database with TLS enabled. Tests create and remove
# their own random schemas; no Telegram or model-provider traffic is sent.
TEST_DATABASE_URL='postgresql://user:password@localhost:5432/telegram_test' pnpm test:integration
```

The unit suite covers triage, scope/dispatch boundaries, Telegram reply targeting,
and pending-login cleanup. Integration tests exercise schema upgrades and rollback,
concurrent duplicate events, the worker/brain pipeline, HTTP APIs, and OTP/2FA
lifecycle with synthetic provider stubs. Live Telegram transport, SRP authentication,
and model output quality still need validation in a configured environment.

Startup migrations retain the oldest message for each `(chat_id, telegram_message_id)`
and preserve duplicate rows, including legacy columns, as JSON in
`messages_duplicate_archive.original_row`. Back up the database before deployment;
initial deduplication takes a table lock. The unique index is also declared in the
Drizzle schema. `db:push` builds the database package and runs the same initialization/cleanup
before applying the Drizzle schema, including on databases containing duplicates.

For legacy conversation tables, startup also restores unique `chat_id` enforcement.
If duplicates exist, the most recent conversation metadata stays live; unanswered and
human-review flags are retained if any duplicate had them set. Removed rows, including
legacy columns, are preserved in `conversations_duplicate_archive.original_row`.
This repair runs in the same locked transaction as the other migrations. Startup
validates both incoming-message conflict targets before allowing the worker to run.
The obsolete `conversations.chat_jid` column is retained as nullable so existing JID
values survive and new Telegram conversations can use `chat_id` alone. JIDs are not
converted into Telegram IDs. Startup also checks for required columns omitted by
incoming-message inserts; unknown columns without a default produce an explicit
schema error before the worker runs, rather than repeatedly skipping messages.




### Required security and delivery configuration

Set `PANEL_USERNAME` and a unique `PANEL_PASSWORD` of at least 16 characters before
opening the dashboard. The panel and APIs use HTTP Basic authentication; expose
only an HTTPS reverse proxy in production. Set `PANEL_ORIGIN` to the external
origin if the proxy rewrites the Host header. `/healthz` is the unauthenticated health
probe. Configure deployment probes to use that path.

Set `SESSION_ENCRYPTION_KEY` to 64 hexadecimal characters (`openssl rand -hex 32`).
Back up that key securely: changing it makes existing encrypted sessions and API
keys unreadable. New credentials are never stored as plaintext. Legacy plaintext
active sessions are encrypted when loaded. PostgreSQL connections use TLS encryption
without server certificate verification, for both the application and migrations.
No custom CA is required. This permits connections to an untrusted server certificate;
the database server's identity is not verified.

`DATABASE_SSL_CA` and `DATABASE_SSL_REJECT_UNAUTHORIZED` are no longer read by the app.
When deploying this version, remove both from the ECS container's `environment` and
`secrets` entries. In particular, remove the SSM reference for `DATABASE_SSL_CA`:
ECS tries to fetch referenced secrets before the app starts, even when the app does
not use them. Keep the other application secrets, including `DATABASE_URL`.
Register the updated task definition and deploy it with the rebuilt image.

`db:push` accepts a standard PostgreSQL URL; non-TLS URL query parameters are
rejected because Drizzle cannot preserve them through its TLS-capable credentials form.

The default mode is `draft`. `DEFAULT_OPERATING_MODE` is preferred; the legacy
`OPERATING_MODE` remains supported. Explicit empty group/block/admin lists override
environment defaults. AI failures or failed critique checks require human review.
The kill switch disables automatic, approved, and manually composed sends.

Use one Telegram account per database, and run **one worker** per database. The web
server already embeds a worker; do not run the standalone worker alongside it.
The first authenticated Telegram ID binds the database to that account. Use a
separate database to manage another account so history and approvals cannot cross
accounts. Runtime worker/session transitions are serialized in each process.

Approvals claim a pending item before delivery. Concurrent clicks cannot send the
same item twice. `delivery_unknown` means Telegram delivery or subsequent storage
could not be confirmed; inspect Telegram before resolving it. A process crash can
leave `sending` items; reconcile those manually after checking the actual chat.
External sends and SQL commits cannot be atomic, so automatic retries are avoided.


The checked-in deployment workflow can restart all services in its ECS cluster.
Review its deployment targets before using it. Scale any separately deployed worker
for the same database to zero before using the embedded web worker; retain the
standalone image for headless deployments.
