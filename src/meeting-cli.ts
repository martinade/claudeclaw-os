#!/usr/bin/env node
/**
 * ClaudeClaw Meeting Notes CLI
 *
 * Post-meeting transcription and summarization pipeline.
 * Transcribes audio locally via whisper-cpp, summarizes via Gemini,
 * saves structured notes to Obsidian and the database.
 *
 * Usage:
 *   node dist/meeting-cli.js transcribe /path/to/recording.m4a
 *   node dist/meeting-cli.js transcribe /path/to/recording.m4a --title "Q1 Planning"
 *   node dist/meeting-cli.js transcribe /path/to/recording.m4a --folder "Work/Meetings"
 *   node dist/meeting-cli.js transcribe /path/to/recording.m4a --no-obsidian
 *   node dist/meeting-cli.js list [--limit N]
 *   node dist/meeting-cli.js show <note-id>
 */

import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

import { initDatabase, saveMeetingNote, getMeetingNote, listMeetingNotes } from './db.js';
import { readEnvFile } from './env.js';
import { getAudioDuration, transcribeMeeting, formatDuration } from './meeting-transcribe.js';
import { summarizeMeeting, formatMeetingNote, saveToObsidian, type MeetingSummary } from './meeting-summarize.js';

initDatabase();

const args = process.argv.slice(2);
const command = args[0];

function flag(name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function boolFlag(name: string): boolean {
  return args.includes(name);
}

// ── transcribe ───────────────────────────────────────────────────────────────

async function cmdTranscribe(): Promise<void> {
  // Find the audio file (first arg that doesn't start with --)
  const audioPath = args.slice(1).find(a => !a.startsWith('--'));
  if (!audioPath || !fs.existsSync(audioPath)) {
    console.error('Usage: meeting-cli transcribe /path/to/audio.m4a [--title "..."] [--folder "..."] [--date "YYYY-MM-DD"] [--no-obsidian]');
    process.exit(1);
  }

  const resolvedPath = path.resolve(audioPath);
  const title = flag('--title');
  const folder = flag('--folder');
  const skipObsidian = boolFlag('--no-obsidian');
  const dateOverride = flag('--date');

  const noteId = crypto.randomUUID();
  const today = dateOverride || new Date().toISOString().split('T')[0];

  // Step 1: Duration
  console.log('Step 1/4: Getting audio duration...');
  const durationSec = await getAudioDuration(resolvedPath);
  console.log(`  Duration: ${formatDuration(durationSec)}`);
  if (durationSec > 60) {
    const estMin = Math.ceil(durationSec / 600); // ~10x realtime on M-series
    console.log(`  Estimated transcription time: ~${estMin} minute${estMin > 1 ? 's' : ''}`);
  }

  // Step 2: Transcribe
  console.log('Step 2/4: Transcribing audio...');
  const startTime = Date.now();
  const { transcript, provider } = await transcribeMeeting(resolvedPath);
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`  Transcribed via ${provider} in ${formatDuration(elapsed)} (${transcript.length} chars)`);

  // Step 3: Summarize
  console.log('Step 3/4: Generating summary via Gemini...');
  const summary = await summarizeMeeting(transcript);
  const meetingTitle = title || summary.title;
  console.log(`  Title: ${meetingTitle}`);
  console.log(`  Topics: ${summary.topics.join(', ')}`);
  console.log(`  Decisions: ${summary.keyDecisions.length}`);
  console.log(`  Action items: ${summary.actionItems.length}`);

  // Format note
  const noteContent = formatMeetingNote(summary, transcript, {
    audioPath: resolvedPath,
    durationSec,
    date: today,
    provider,
  });

  // Step 4: Save
  let obsidianPath: string | null = null;
  if (!skipObsidian) {
    const env = readEnvFile(['MEETING_NOTES_VAULT', 'MEETING_NOTES_FOLDER']);
    const vaultPath = env.MEETING_NOTES_VAULT;
    if (vaultPath) {
      console.log('Step 4/4: Saving to Obsidian...');
      obsidianPath = saveToObsidian(
        noteContent,
        `${today} ${meetingTitle}`,
        vaultPath.replace(/^~/, process.env.HOME || ''),
        folder || env.MEETING_NOTES_FOLDER || 'Meeting Notes',
      );
      console.log(`  Saved: ${obsidianPath}`);
    } else {
      console.log('Step 4/4: Skipping Obsidian (MEETING_NOTES_VAULT not set in .env)');
    }
  } else {
    console.log('Step 4/4: Skipping Obsidian (--no-obsidian)');
  }

  // Save to DB
  saveMeetingNote({
    id: noteId,
    title: meetingTitle,
    audioPath: resolvedPath,
    durationSec,
    transcript,
    summary: JSON.stringify(summary),
    obsidianPath,
    meetingDate: today,
  });

  // Output result
  console.log('\n========================================');
  console.log(`Meeting Notes: ${meetingTitle}`);
  console.log(`ID: ${noteId}`);
  console.log(`Duration: ${formatDuration(durationSec)} | Provider: ${provider}`);
  console.log('========================================');
  console.log(`\nSummary:\n${summary.summary}`);
  if (summary.keyDecisions.length > 0) {
    console.log('\nKey Decisions:');
    for (const d of summary.keyDecisions) console.log(`  - ${d}`);
  }
  if (summary.actionItems.length > 0) {
    console.log('\nAction Items:');
    for (const ai of summary.actionItems) {
      const owner = ai.owner ? ` [${ai.owner}]` : '';
      const deadline = ai.deadline ? ` (by ${ai.deadline})` : '';
      console.log(`  - ${ai.task}${owner}${deadline}`);
    }
  }
  if (obsidianPath) {
    console.log(`\nObsidian note: ${obsidianPath}`);
  }

  // Output as JSON for programmatic use (last line)
  const result = { id: noteId, title: meetingTitle, summary: summary.summary, actionItems: summary.actionItems, obsidianPath };
  console.log(`\n__JSON__${JSON.stringify(result)}`);
}

// ── list ─────────────────────────────────────────────────────────────────────

async function cmdList(): Promise<void> {
  const limit = parseInt(flag('--limit') || '10', 10);
  const notes = listMeetingNotes(limit);
  if (notes.length === 0) {
    console.log('No meeting notes found.');
    return;
  }
  console.log(`${'ID'.padEnd(10)} ${'Date'.padEnd(12)} ${'Duration'.padEnd(10)} Title`);
  console.log('-'.repeat(60));
  for (const n of notes) {
    const date = n.meeting_date || new Date(n.created_at * 1000).toISOString().split('T')[0];
    const dur = n.duration_sec ? formatDuration(n.duration_sec) : '?';
    console.log(`${n.id.slice(0, 8).padEnd(10)} ${date.padEnd(12)} ${dur.padEnd(10)} ${n.title}`);
  }
}

// ── show ─────────────────────────────────────────────────────────────────────

async function cmdShow(): Promise<void> {
  const noteId = args[1];
  if (!noteId) {
    console.error('Usage: meeting-cli show <note-id>');
    process.exit(1);
  }

  // Support partial ID matching
  const notes = listMeetingNotes(100);
  const match = notes.find(n => n.id.startsWith(noteId));
  if (!match) {
    console.error(`Note not found: ${noteId}`);
    process.exit(1);
  }

  const full = getMeetingNote(match.id);
  if (!full) {
    console.error(`Note not found: ${noteId}`);
    process.exit(1);
  }

  let summary: MeetingSummary;
  try {
    summary = JSON.parse(full.summary);
  } catch {
    summary = { title: full.title, attendees: [], summary: '', keyDecisions: [], actionItems: [], topics: [] };
  }

  console.log(`Title: ${full.title}`);
  console.log(`Date: ${full.meeting_date || 'unknown'}`);
  console.log(`Duration: ${full.duration_sec ? formatDuration(full.duration_sec) : 'unknown'}`);
  console.log(`Audio: ${full.audio_path}`);
  if (full.obsidian_path) console.log(`Obsidian: ${full.obsidian_path}`);
  console.log(`\nSummary:\n${summary.summary}`);

  if (summary.keyDecisions.length > 0) {
    console.log('\nKey Decisions:');
    for (const d of summary.keyDecisions) console.log(`  - ${d}`);
  }
  if (summary.actionItems.length > 0) {
    console.log('\nAction Items:');
    for (const ai of summary.actionItems) {
      const owner = ai.owner ? ` [${ai.owner}]` : '';
      const deadline = ai.deadline ? ` (by ${ai.deadline})` : '';
      console.log(`  - ${ai.task}${owner}${deadline}`);
    }
  }
  if (summary.attendees.length > 0) {
    console.log(`\nAttendees: ${summary.attendees.join(', ')}`);
  }
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

(async () => {
  switch (command) {
    case 'transcribe':
      await cmdTranscribe();
      break;
    case 'list':
      await cmdList();
      break;
    case 'show':
      await cmdShow();
      break;
    default:
      console.log('ClaudeClaw Meeting Notes CLI\n');
      console.log('Commands:');
      console.log('  transcribe <audio-file>   Transcribe + summarize a meeting recording');
      console.log('  list [--limit N]          List recent meeting notes');
      console.log('  show <note-id>            Show a specific meeting note\n');
      console.log('Options:');
      console.log('  --title "Meeting Title"   Override auto-generated title');
      console.log('  --folder "Work/Meetings"  Obsidian subfolder (default: Meeting Notes)');
      console.log('  --date "2026-04-20"       Override meeting date');
      console.log('  --no-obsidian             Skip saving to Obsidian');
      process.exit(command ? 1 : 0);
  }
})().catch((err) => {
  console.error(`Error: ${err.message || err}`);
  process.exit(1);
});
