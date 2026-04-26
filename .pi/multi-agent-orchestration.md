# Multi-Agent Orchestration Design

## Why Multi-Agent

A single agent serving all roles creates problems:

- **Context overload**: long sessions accumulate irrelevant context, degrading response quality.
- **Tool sprawl**: one agent holding all tools increases routing errors and latency.
- **Mixed responsibilities**: coding, research, writing, and planning compete for attention in the same turn.

Multi-agent splits work by role, keeping each agent's context lean and focused.

## Which Tasks Fit Multi-Agent

| Fits | Does Not Fit |
|------|-------------|
| Multi-stage development spanning sessions | Simple questions and explanations |
| Work needing cross-session persistence | One-off code edits |
| Tasks requiring different capabilities (research + code + review) | Quick lookups |
| Periodic or continuously improving processes | Temporary queries |
| Explicitly long-term work the user marks for tracking | Stateless one-shot tasks |

## Lead Agent Responsibilities

The lead agent (the one the user talks to directly) does:

1. **Classify complexity**: decide immediate mode vs. long-task mode.
2. **Route**: hand off to the right worker or handle directly.
3. **Plan decomposition**: for long tasks, break the goal into steps.
4. **Synthesize**: merge worker outputs into a coherent response.
5. **Persist state**: update long-task records with progress and artifacts.

The lead never delegates everything. For simple tasks it acts directly.

## Worker Agent Responsibilities

Workers are scoped agents that do one thing well:

| Worker | Scope | Permissions |
|--------|-------|-------------|
| researcher | read files, search web, query memory | read-only on project, no write |
| coder | read and write source files | read-write on assigned files only |
| reviewer | read files, comment | read-only, output is review text |
| tester | run tests, read test files | read test files, execute test commands |
| docWriter | read source, write docs | read source, write to docs/ and .md files |

Workers receive a focused context slice, not the full conversation.

## Context Passing Between Agents

```
Lead agent
  ├── classifies task
  ├── creates long_task (if complex)
  └── for each step:
       ├── selects worker
       ├── builds context slice:
       │     - step goal
       │     - relevant file paths
       │     - output of prior steps (artifacts)
       │     - relevant memories (mem0 query)
       └── collects output → writes to long_task artifact
```

Context slices are explicit, not ambient:
- **No full conversation history** passed to workers.
- Workers receive: goal, input context, expected output format.
- Outputs are markdown or structured text stored as task artifacts.

## Result Merging and Review

1. Each worker step produces an artifact written to the long-task record.
2. The lead agent reads artifacts from completed steps before planning the next step.
3. The reviewer worker (when used) produces a review artifact listing issues.
4. The lead agent decides whether to iterate or accept.

No automatic merging. The lead agent makes all merge decisions.

## Integration with long_task

The existing `long_task` system in `.pi/extensions/long-task-runner.ts` is the persistence layer:

- **Task creation**: lead agent calls `long_task create` for complex work.
- **Step planning**: lead agent calls `long_task add_step` with worker/model hints.
- **Step execution**: worker runs, lead calls `long_task set_step completed` with output.
- **Artifacts**: results go into `long_task add_artifact`.
- **Resumption**: `long_task resume` rebuilds context from task record.

Multi-agent orchestration is a thin routing layer over long_task, not a parallel replacement.

## Minimum Viable Product

The MVP does not implement concurrent worker processes. It adds judgment and planning on top of the existing long_task system.

### MVP Scope

1. **Complexity classification**: lead agent decides immediate vs. long-task using the existing task router rules plus the escalation signals described below.
2. **Simple tasks**: handled directly, no long-task created.
3. **Complex tasks**: lead agent creates a long_task and produces a step plan.
4. **Planning-level workers**: steps reference a worker role (researcher, coder, etc.) but the lead agent still executes each step sequentially. No real worker spawning yet.
5. **Artifact collection**: each step result is written back to the long_task record.

### What MVP Does NOT Include

- Real concurrent worker processes.
- Agent-to-agent message passing beyond the lead.
- Automatic context slicing (the lead manually prepares context for now).
- Worker sandboxing or scoped file permissions.

## Escalation Signals (Refined)

### Should escalate to long-task

- Multi-stage development.
- Work needing cross-session continuity.
- Tasks requiring sustained observation or periodic improvement.
- Tasks involving multiple agents, models, or tools coordinating.
- User explicitly says "long-term", "ongoing", "track", "continue later" (长期, 持续, 后续跟踪).

### Should NOT escalate to long-task

- Simple Q&A.
- Single code change.
- Temporary lookup.
- One-shot explanation.
- Any task with no follow-up state value.

## Data Structures (Draft)

```ts
type AgentRole = "lead" | "researcher" | "coder" | "reviewer" | "tester" | "docWriter";

type AgentAssignment = {
  id: string;
  role: AgentRole;
  goal: string;
  context: string[];
  expectedOutput: string;
  status: "pending" | "running" | "completed" | "failed";
};
```

### Storage

Agent assignments reuse the existing long-task step structure:
- Each step in a `LongTaskRecord` already has `worker`, `input`, `output`, and `status`.
- `AgentAssignment` maps 1:1 to a step: the step's `worker` field becomes the `AgentRole`.
- No new storage format needed. Assignments live in `.pi/tasks/*.json` as steps.

### Artifacts

Step outputs stored in the existing `artifacts` array on the task record. File paths or inline text.

### Failure Recovery

If a step fails:
1. The lead agent sees the step status `"failed"` and the `error` field.
2. The lead decides: retry with different context, switch worker, or mark task blocked.
3. No automatic retry. The lead agent has full control.

## Later Iteration Ideas (Not MVP)

- Real worker spawning via `coding-agent` subprocess or API call.
- Scoped file system access per worker role.
- Parallel read-only workers with git worktrees for coders.
- A task dashboard TUI view.
- Automatic context slicing based on file relevance scoring.

## MVP Planning Flow

This section documents the current implementation pipeline for multi-agent planning (planning only, no worker execution).

### Pipeline

```
User prompt
    │
    ▼
1. classifyAgentRequest()
       Determines: immediate | long_task | multi_agent_candidate
    │
    ▼
2. recommendAgentDispatch()
       Maps mode → action (answer_directly | use_long_task | plan_multi_agent)
       Adds shouldCreateTask / shouldPlanWorkers flags
    │
    ▼
3. workerPlanHints
       For multi_agent_candidate: [researcher, coder, tester, reviewer]
       + docWriter if documentation signal detected
    │
    ▼
4. buildAgentStepDrafts()
       Converts workerPlanHints → AgentStepDraft[] (title, worker, reason, expectedOutput)
       Returns [] for non-multi_agent_candidate modes
    │
    ▼
5. Routing prompt injection (buildTaskRoutingSystemPrompt in long-task-runner.ts)
       Exposes: mode, reason, signals, action, shouldCreateTask, shouldPlanWorkers,
       worker plan hints, step drafts, recommendation usage rules
    │
    ▼
6. long_task suggest_steps (preview, no write)
       Calls buildAgentStepDrafts(goal)
       Returns formatted step draft preview
       Does NOT create tasks or write files
    │
    ▼
7. long_task add_suggested_steps (explicit persist)
       Only writes steps when explicitly called by the model
       Calls addTaskStep() for each draft with dedup
       Stores: title, worker, input (reason), expectedOutput
```

### Current Boundaries

- **No worker spawning**: workers exist only as metadata on long-task steps.
- **Lead agent still executes all steps**: no concurrency, no sub-agent processes.
- **Worker roles are planning hints**: `worker` field on steps is guidance for future execution, not an instruction to spawn.
- **No automatic step creation**: steps are only added to tasks via explicit `add_step` or `add_suggested_steps` calls, never automatically from the routing prompt.

### Key Files

| File | Role |
|------|------|
| `.pi/extensions/multi-agent-dispatcher.ts` | Classification, recommendation, worker hints, step drafts |
| `.pi/extensions/long-task-runner.ts` | Routing prompt injection, long_task tool (suggest_steps, add_suggested_steps), durable task records |
| `packages/coding-agent/test/suite/multi-agent-dispatcher.test.ts` | Pure function tests for classification, recommendation, drafts |
| `packages/coding-agent/test/suite/long-task-runner-extension.test.ts` | Routing prompt integration tests, tool action tests |