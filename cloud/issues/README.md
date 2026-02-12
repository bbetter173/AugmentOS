# Design Documentation Guide

How we write technical design docs for cloud features.

## Philosophy

- **Information dense, not corporate fluff**
- **Easy to read, easy to find things**
- **Written for engineers by engineers**
- **No bullshit, no filler**

## Document Structure

Each feature gets a folder: `cloud/issues/{feature-name}/`

Example: `cloud/issues/livekit-grpc/` (matches branch `cloud/livekit-grpc`)

### Required Files

1. **README.md** - Quick navigation, 1-paragraph context, status checklist
2. **{feature}-spec.md** - Problem, goals, constraints (PM perspective but technical)
3. **{feature}-architecture.md** - Current system, proposed design, implementation details
4. **{protocol}.proto** or similar - Actual implementation artifacts

### Optional Files

- **{feature}-usage.md** - Code examples, patterns
- Historical reference docs (mark clearly as historical)

## What to CUT

❌ Corporate speak ("Dear stakeholders", "executive summary", "synergy")
❌ Emoji spam (one or two OK for visual scanning, not dozens)
❌ Obvious statements ("gRPC is a remote procedure call protocol")
❌ Tutorial content ("What is REST?")
❌ Fake status tracking that won't be updated
❌ Redundant summaries
❌ Box drawings and ASCII art decorations
❌ Motivational fluff

## What to KEEP

✅ **Diagrams showing actual data flow** (concise ASCII art)
✅ **Real code snippets** from the codebase
✅ **Specific numbers** (buffer sizes, timeouts, memory targets)
✅ **Decision rationale** ("Why X over Y")
✅ **Edge cases and gotchas**
✅ **Links to actual code files**
✅ **Open questions** that need answers
✅ **Constraints** we're working with

## Document Templates

### README.md Format

````markdown
# Feature Name

One-sentence description.

## Documents

- **{feature}-spec.md** - Problem, goals, constraints
- **{feature}-architecture.md** - Technical design

## Quick Context

**Current**: How it works now (problems)
**Proposed**: How we'll fix it

## Key Context

One paragraph explaining the critical constraint or insight.

## Status

- [x] Done thing
- [ ] TODO thing

### Spec Format

```markdown
# Feature Spec

## Overview

What we're building in 2-3 sentences.

## Problem

Technical problems we're solving:

1. Specific issue (with evidence)
2. Another issue (with numbers)

### Constraints

- Technical constraint (why it exists)
- Business constraint

## Goals

Scoping out what we are trying to achieve:

## Non-Goals

What we're explicitly NOT doing.

## Open Questions

1. Thing we need to decide
2. Another thing
```
````

### Architecture Format

```markdown
# Feature Architecture

## Current System

Diagram showing how it works now.

### Key Code Paths

Actual code snippets with line numbers.

### Problems

Specific issues with evidence.

## Proposed System

Diagram showing new design.

### Key Changes

1. What's different
2. Why it's better

### Implementation Details

Code examples for Go/TS/whatever.

## Migration Strategy

How we roll this out.

## Open Questions

Decisions needed.
```

## Writing Style

### Good Example

```markdown
## Audio Flow

Client→Cloud: DataChannel (LiveKit TS SDK can't publish custom PCM)
Cloud→Client: WebRTC Track (works fine)

Problem: Go bridge uses WebSocket for IPC (wrong tool, causes goroutine leaks)
Solution: gRPC bidirectional stream with automatic backpressure

Memory: Current 25MB/session → Target <5MB/session
```

### Bad Example

```markdown
## Audio Flow Architecture

### Overview

In this section, we will comprehensively explore the audio flow architecture
that enables real-time communication between our client devices and the cloud
infrastructure. This is a critical component of our system...

### Background

Audio streaming has been a cornerstone of modern communication systems since...
```

## Diagrams

Use concise ASCII art:

```
Client → Go Bridge → TypeScript → Apps
         (gRPC)      (WebSocket)
```

Not:

```
╔════════════════════════════════════════════╗
║                                            ║
║  ┌──────────┐      ┌──────────┐          ║
║  │  Client  │─────▶│   Go     │          ║
║  │          │      │  Bridge  │          ║
║  └──────────┘      └──────────┘          ║
║                                            ║
╚════════════════════════════════════════════╝
```

## Code Examples

Always include:

- File path: `packages/cloud/src/services/AudioManager.ts`
- Line numbers if referencing existing code
- Language in code fence: ` ```typescript `
- Context: "This causes X" or "This fixes Y"

## Numbers

Always include specific numbers:

- "Memory grows 500MB/hour" not "Memory grows a lot"
- "100ms chunks (1600 bytes)" not "Small chunks"
- "gRPC port 9090" not "a port"

## Open Questions

Always include "Open Questions" section for:

- Technical decisions not yet made
- Things we need to measure/benchmark
- Edge cases we're unsure about

Format:

```markdown
## Open Questions

1. **Unix socket vs TCP?**
   - Unix socket: 20-30% lower latency
   - TCP: easier debugging
   - **Decision**: Start with TCP, measure later

2. **Chunk size?**
   - Current: 100ms (1600 bytes)
   - Alternative: 50ms (800 bytes)
   - **Need to benchmark**
```

## File Naming

- Lowercase with hyphens: `livekit-grpc-spec.md`
- Not: `LiveKitGRPCSpec.md` or `livekit_grpc_spec.md`
- Match feature name: folder `livekit-grpc/`, files `livekit-grpc-*.md`
- Proto/code files: whatever their convention is (`.proto`, `.ts`, etc.)

## Document Length

- README: 1-2 pages max
- Spec: 3-5 pages
- Architecture: 10-15 pages is fine if information-dense
- Usage guide: As long as needed for examples

**Dense and useful > short and useless**

But also: **Dense and useful > long and fluffy**

## When to Update

Update docs when:

- Making architectural decisions
- Discovering new constraints
- Answering open questions
- Changing implementation approach

Don't update:

- Status checkboxes (too much churn)
- "Last updated" timestamps (git has this)
- Version numbers (git has this)

## Review Process

Before implementation:

1. Write all docs
2. Review together (PM/engineer)
3. Answer open questions
4. Approve architecture
5. **Then** start coding

Docs are **planning artifacts**, not post-implementation documentation.

## Examples

Good design doc folders:

- `cloud/issues/livekit-grpc/` - This guide's example
- (Add more as we create them)

## Anti-Patterns

❌ **"Living document"** - Docs that get stale immediately
❌ **"RFC"** numbered system - We're not that formal
❌ **"ADR"** (Architecture Decision Records) - Too heavyweight
❌ **Confluence/Notion** - Keep it in git with code
❌ **Google Docs** - Not version controlled
❌ **Miro boards** - Can't grep ASCII art

## Tools

- Editor: Whatever you want
- Diagrams: ASCII art (can be copied/pasted)
- Code examples: Copy from actual code
- Tables: Markdown tables
- No special tools needed

---

**Remember**: These docs are for us (engineers). Write what you'd want to read when joining the project or debugging at 2am.
