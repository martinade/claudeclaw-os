#!/usr/bin/env node
/**
 * ClaudeClaw Twilio Call CLI
 *
 * Make outbound voice calls via Twilio with text-to-speech.
 *
 * Usage:
 *   node dist/twilio-call-cli.js call "+15551234567" "Your message here"
 *   node dist/twilio-call-cli.js call "+15551234567" "message" --voice "Polly.Joanna" --repeat 2
 *   node dist/twilio-call-cli.js status <call-sid>
 *   node dist/twilio-call-cli.js history [--limit N]
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Twilio = require('twilio');

import { initDatabase, logCall, getCallHistory, updateCallStatus } from './db.js';
import { readEnvFile } from './env.js';

// Init DB for call logging (non-fatal if it fails)
try {
  initDatabase();
} catch {
  // DB not available -- calls still work, just not logged
}

const [, , command, ...rest] = process.argv;

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildTwiml(message: string, voice: string, repeat: number): string {
  const sayTags = Array(repeat)
    .fill(`<Say voice="${voice}">${escapeXml(message)}</Say><Pause length="1"/>`)
    .join('');
  return `<Response>${sayTags}</Response>`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getTwilioClient(): { client: any; fromNumber: string } {
  const env = readEnvFile(['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER']);
  const accountSid = process.env.TWILIO_ACCOUNT_SID || env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN || env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER || env.TWILIO_FROM_NUMBER;

  if (!accountSid || !authToken || !fromNumber) {
    console.error('Missing Twilio credentials. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER in .env');
    console.error('Sign up at: https://www.twilio.com/try-twilio');
    process.exit(1);
  }

  const client = Twilio(accountSid, authToken);
  return { client, fromNumber };
}

async function main() {
  switch (command) {
    case 'call': {
      const to = rest[0];
      const message = rest[1];
      if (!to || !message) {
        console.error('Usage: twilio-call-cli call "+15551234567" "Your message"');
        process.exit(1);
      }
      const voice = parseFlag(rest, '--voice') || 'Polly.Matthew';
      const repeat = parseInt(parseFlag(rest, '--repeat') || '1', 10);
      const { client, fromNumber } = getTwilioClient();
      const twiml = buildTwiml(message, voice, repeat);

      const call = await client.calls.create({
        twiml,
        to,
        from: fromNumber,
      });

      // Log to DB
      try {
        logCall(call.sid, to, fromNumber, message, voice);
      } catch {
        // Non-fatal
      }

      console.log(`Call initiated: ${call.sid}`);
      console.log(`  To:      ${to}`);
      console.log(`  From:    ${fromNumber}`);
      console.log(`  Status:  ${call.status}`);
      console.log(`  Voice:   ${voice}`);
      console.log(`  Message: ${message.slice(0, 100)}${message.length > 100 ? '...' : ''}`);
      break;
    }

    case 'status': {
      const sid = rest[0];
      if (!sid) {
        console.error('Usage: twilio-call-cli status <call-sid>');
        process.exit(1);
      }
      const { client } = getTwilioClient();
      const call = await client.calls(sid).fetch();

      // Update local DB
      try {
        updateCallStatus(call.sid, call.status, call.duration ? parseInt(call.duration, 10) : undefined);
      } catch {
        // Non-fatal
      }

      console.log(`Call:     ${call.sid}`);
      console.log(`  Status:   ${call.status}`);
      console.log(`  Duration: ${call.duration ?? '-'}s`);
      console.log(`  To:       ${call.to}`);
      console.log(`  From:     ${call.from}`);
      console.log(`  Started:  ${call.startTime ?? '-'}`);
      console.log(`  Ended:    ${call.endTime ?? '-'}`);
      break;
    }

    case 'call-live': {
      // Two-way real-time voice call via Twilio Media Streams + Gemini Live
      const to = rest[0];
      if (!to) {
        console.error('Usage: twilio-call-cli call-live "+15551234567"');
        process.exit(1);
      }
      const env = readEnvFile(['TWILIO_WEBHOOK_URL']);
      const webhookUrl = process.env.TWILIO_WEBHOOK_URL || env.TWILIO_WEBHOOK_URL;
      if (!webhookUrl) {
        console.error('TWILIO_WEBHOOK_URL not set in .env. This is the public tunnel URL for your dashboard.');
        console.error('Run: cloudflared tunnel --url http://localhost:3141');
        console.error('Then set TWILIO_WEBHOOK_URL=https://your-tunnel-url in .env');
        process.exit(1);
      }
      const twimlUrl = `${webhookUrl}/twilio-voice/twiml`;
      const { client, fromNumber } = getTwilioClient();

      const call = await client.calls.create({
        url: twimlUrl,
        to,
        from: fromNumber,
      });

      // Log to DB
      try {
        logCall(call.sid, to, fromNumber, '[live voice call]', 'gemini-live');
      } catch {
        // Non-fatal
      }

      console.log(`Live call initiated: ${call.sid}`);
      console.log(`  To:       ${to}`);
      console.log(`  From:     ${fromNumber}`);
      console.log(`  Status:   ${call.status}`);
      console.log(`  TwiML:    ${twimlUrl}`);
      console.log(`  Mode:     Gemini Live (two-way voice)`);
      break;
    }

    case 'history': {
      const limit = parseInt(parseFlag(rest, '--limit') || '10', 10);
      try {
        const calls = getCallHistory(limit);
        if (calls.length === 0) {
          console.log('No call history.');
          break;
        }
        for (const c of calls) {
          const date = new Date(c.created_at * 1000).toLocaleString();
          console.log(`${c.sid} | ${c.to_number} | ${c.status} | ${date} | ${c.message.slice(0, 50)}`);
        }
      } catch {
        console.log('Call history not available (DB not initialized).');
      }
      break;
    }

    default:
      console.error('ClaudeClaw Twilio Call CLI');
      console.error('');
      console.error('Commands:');
      console.error('  call "+15551234567" "message"  Make an outbound call with TTS');
      console.error('  call-live "+15551234567"       Two-way voice call (Gemini Live)');
      console.error('  status <call-sid>              Check call status');
      console.error('  history [--limit N]            View call history');
      console.error('');
      console.error('Flags:');
      console.error('  --voice "Polly.Joanna"  TTS voice (default: Polly.Matthew)');
      console.error('  --repeat N              Repeat message N times (default: 1)');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message || err}`);
  process.exit(1);
});
