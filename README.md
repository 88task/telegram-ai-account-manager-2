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

### 4. Authenticate Telegram MTProto Account
```bash
pnpm worker:auth
# Prompts for phone number, OTP received on Telegram, and 2FA password if enabled
```

### 5. Start the Background Worker
```bash
pnpm worker:start
```
