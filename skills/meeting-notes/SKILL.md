---
name: meeting-notes
description: Transcribe and summarize meeting recordings locally. Produces full transcript, summary, key decisions, and action items saved to Obsidian.
allowed-tools: Bash(cd * && node dist/meeting-cli.js *)
---

# Meeting Notes

Post-meeting transcription and summarization. Works with any audio format (m4a, mp3, wav, ogg, webm, aac).

Uses whisper-cpp locally (free, no cloud dependency) with Groq cloud fallback. Summarization via Gemini 2.0 Flash.

## Prerequisites

```bash
brew install whisper-cpp
mkdir -p ~/.local/share/whisper-models
curl -L -o ~/.local/share/whisper-models/ggml-large-v3-turbo.bin \
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin"
```

Set in `.env`:
```
WHISPER_MODEL_PATH=~/.local/share/whisper-models/ggml-large-v3-turbo.bin
```

Optional (for Obsidian notes):
```
MEETING_NOTES_VAULT=~/path/to/obsidian/vault
MEETING_NOTES_FOLDER=Meeting Notes
```

Also requires `GOOGLE_API_KEY` in `.env` for Gemini summarization.

## Commands

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)

# Transcribe + summarize a recording
node "$PROJECT_ROOT/dist/meeting-cli.js" transcribe "/path/to/recording.m4a"

# With custom title and folder
node "$PROJECT_ROOT/dist/meeting-cli.js" transcribe "/path/to/recording.m4a" --title "Q1 Planning" --folder "Work/Meetings"

# Skip Obsidian saving
node "$PROJECT_ROOT/dist/meeting-cli.js" transcribe "/path/to/recording.m4a" --no-obsidian

# List past meeting notes
node "$PROJECT_ROOT/dist/meeting-cli.js" list --limit 10

# Show a specific note
node "$PROJECT_ROOT/dist/meeting-cli.js" show <note-id>
```

## When to use

- User says "transcribe this meeting", "meeting notes", "summarize this recording"
- User sends an audio file and mentions it's a meeting or call recording
- User asks for action items or decisions from a recording

## Performance

- ~6 minutes per hour of audio on Apple Silicon (large-v3-turbo model)
- Gemini summarization adds <5 seconds
- Warn the user about expected wait time for long recordings

## Output

Produces an Obsidian Markdown note with:
- YAML frontmatter (date, duration, source, topics)
- Attendees (auto-detected from transcript)
- Executive summary (3-5 sentences)
- Key decisions
- Action items as checkboxes (`- [ ]`) with owners and deadlines
- Full transcript in a collapsible section

Action items integrate with the Obsidian task scanner automatically.

## Rules

- ALWAYS show the summary and action items in the Telegram response after transcription
- For recordings >30 minutes, warn about processing time before starting
- If the file is very short (<2 minutes), confirm it's a meeting and not just a voice memo
