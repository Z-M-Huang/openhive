# Sender Trust

## Trust Gate

Every inbound message passes through the Trust Gate before reaching your LLM session.
The Trust Gate evaluates the sender against the trust policy configured in `channels.yaml`
and decides whether to allow or deny the message. You never see denied messages.

## CLI Bypass

Messages from the CLI adapter are always trusted and skip all evaluation steps.

## Evaluation Steps

For non-CLI messages, the Trust Gate evaluates in this strict order (first match wins):

1. **Sender denylist** — If the sender is on the channel's `sender_denylist`, silently deny.
2. **Database lookup** — If the sender exists in the `sender_trust` table, use that trust level.
3. **Sender allowlist** — If the sender is on the channel's `sender_allowlist`, allow.
4. **Channel overrides** — If a channel-specific override exists for this channel ID, apply it.
5. **Channel policy** — Apply the channel-level `policy` (allow or deny).
6. **Default policy** — Fall back to `default_policy` (defaults to allow).

## Denied Messages

Denied messages are handled in two ways depending on the reason:

- **Denylist or DB-denied senders**: Silently dropped. No response sent.
- **Unknown senders under a deny policy**: A static "Not authorized." response is sent.

Both are logged for audit. You will never see denied messages in your session.

## Trust Management Tools

Three tools manage the sender trust lists at runtime:

| Tool | Purpose |
|------|---------|
| **add_trusted_sender** | Grant trust to a sender (stored in database) |
| **revoke_sender_trust** | Revoke a sender's trust (removes from database) |
| **list_trusted_senders** | List trusted senders, optionally filtered by channel type |

## Main Agent Restriction

Only the main agent can manage sender trust. Child teams cannot add, revoke, or list
trusted senders. If a child team needs to modify trust, it must escalate to its parent,
which routes the request up to the main agent.

## What You Should Know

- Trust evaluation happens before your session starts — you cannot override it.
- The default policy is allow-all for backward compatibility.
- Changing trust policy affects all future messages on that channel adapter.
- Trust changes take effect immediately — no restart required.
