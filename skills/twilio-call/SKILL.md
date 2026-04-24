---
name: twilio-call
description: Make outbound voice calls via Twilio. Call a phone number and deliver a spoken message.
allowed-tools: Bash(cd * && node dist/twilio-call-cli.js *)
---

# Twilio Voice Call Skill

Make outbound phone calls with text-to-speech via Twilio. The recipient's phone rings, they answer, and a voice reads them the message.

## Commands

### Make a call

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
node "$PROJECT_ROOT/dist/twilio-call-cli.js" call "+15551234567" "Your meeting starts in 5 minutes"
```

### Custom voice

```bash
node "$PROJECT_ROOT/dist/twilio-call-cli.js" call "+15551234567" "message" --voice "Polly.Joanna"
```

Available voices: Polly.Matthew (default, male), Polly.Joanna (female), Polly.Amy (British female), Polly.Brian (British male).

### Repeat message (for urgent reminders)

```bash
node "$PROJECT_ROOT/dist/twilio-call-cli.js" call "+15551234567" "Wake up!" --repeat 3
```

### Check call status

```bash
node "$PROJECT_ROOT/dist/twilio-call-cli.js" status CA1234567890abcdef
```

### View call history

```bash
node "$PROJECT_ROOT/dist/twilio-call-cli.js" history --limit 10
```

## Rules

- ALWAYS confirm the phone number and message with the user before placing a call
- Never call without explicit confirmation unless it's a pre-approved scheduled reminder
- Phone numbers must include country code (e.g., +1 for US, +27 for South Africa)
- Keep messages concise and clear -- they'll be read by TTS

## Scheduled Call Reminders

To set a call reminder, combine with the schedule system:

```bash
node "$PROJECT_ROOT/dist/schedule-cli.js" create "Call +XXXXXXXXXXX and say: Time for your meeting. Use the twilio-call skill." "0 15 * * *"
```

## Cost

~$0.014/min for US calls. A typical TTS reminder is under 30 seconds (~$0.007 per call).
