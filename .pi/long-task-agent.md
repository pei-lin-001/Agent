# Personal Agent Task Architecture

## Goal

The personal agent should support both everyday lightweight tasks and long-running complex work.

The system must not force every request through a heavy workflow. Simple requests should stay fast and direct. Long tasks should gain durable state, step tracking, model routing, worker delegation, and recovery.

## Core Principle

Default to immediate mode. Escalate to long-task mode only when the request is clearly complex, long-running, interruptible, or explicitly asks for background progress.

This keeps the assistant useful for small tasks while still allowing it to take on larger projects.

## Modes

### Immediate Mode

Use immediate mode when the task can reasonably be handled in one focused interaction.

Examples:

- Answer a direct question.
- Explain a concept.
- Inspect a file.
- Make a small code change.
- Run a specific command.
- Summarize a short document.

Immediate mode uses the main agent directly. It may still use memory and model routing, but it does not create a durable task record or spawn multiple workers by default.

### Long-Task Mode

Use long-task mode when the task needs planning, multiple steps, recovery, or extended execution.

Examples:

- Implement a feature touching several modules.
- Research several options before choosing a design.
- Run a sequence of implementation, testing, review, and documentation.
- Continue work after interruption.
- Work in the background or across multiple sessions.
- Coordinate multiple read-only workers or isolated coding workers.

Long-task mode creates a task record under `.pi/tasks/` and updates it after each step.

## Task Router

The task router decides whether a request stays in immediate mode or becomes a long task.

Initial routing should be conservative:

- Default: immediate mode.
- Escalate automatically only for clearly complex tasks.
- Ask the user when the request is ambiguous and the long-task overhead may be unnecessary.
- Before creating a new long task, inspect active task records and reuse an existing matching task whenever possible.
- If an active task's next pending or running step matches the user's request, continue that step instead of creating a duplicate task.
- Create a new long task only when no active task covers the goal.

Routing signals:

- User explicitly says: "长期任务", "后台", "持续推进", "拆成步骤", "慢慢做", "复杂任务".
- The task has multiple independent phases such as research, implementation, testing, and review.
- The task is likely to touch many files or packages.
- The task depends on external research plus code changes.
- The task should survive process restarts or context loss.

### Duplicate Avoidance

The task runner should surface active tasks in the routing prompt so the model can compare the current request against existing work.

Required behavior:

- Reuse a running, pending, or blocked task whose title, goal, or next step already covers the user request.
- Use `/task resume <taskId>` or the `long_task` `resume`/`show` actions to continue existing work.
- Add steps or artifacts to the existing task when the user is refining the same project.
- Before adding a new step, compare it with the existing plan. If the current pending or running step already covers the requested implementation slice, continue that step instead of adding narrower duplicate substeps.
- Treat role setup, routing rules, context passing, result merging, and validation as part of an existing "multi-agent dispatch" step unless the user explicitly asks to split that step.
- Do not create parallel top-level tasks for the same project direction.

Example:

If a task named `Personal Agent Multi-Capability Collaborative Platform Evolution` already has next step `Implement minimal viable multi-agent dispatch`, then a request such as "逐步实现多 agent 协作编排层" should continue that task instead of creating a new "Implement multi-agent orchestration" task.

## Long-Task Runner

The long-task runner stores task state and executes steps.

This is inspired by durable workflow systems such as Inngest, Temporal, Trigger.dev, and OpenWorkflow, but the first version should remain local and lightweight.

### Task State

Each task should have:

- `id`: stable task identifier.
- `title`: short human-readable name.
- `status`: `pending`, `running`, `blocked`, `completed`, `failed`, or `cancelled`.
- `createdAt`: creation time.
- `updatedAt`: last update time.
- `mode`: `long-task`.
- `goal`: original user goal.
- `plan`: ordered list of steps.
- `currentStepId`: step currently being executed.
- `artifacts`: important files, notes, logs, or summaries.
- `memoryKeys`: related memory namespace or tags.

### Step State

Each step should have:

- `id`: stable step identifier.
- `title`: short action name.
- `status`: `pending`, `running`, `completed`, `failed`, `skipped`, or `blocked`.
- `dependsOn`: step ids that must complete first.
- `worker`: optional worker type.
- `modelPolicy`: model routing hint.
- `input`: concise step input.
- `output`: concise result summary.
- `error`: failure summary when applicable.
- `startedAt`: step start time.
- `completedAt`: step completion time.

### Recovery

Recovery means the system can continue from the last completed step after interruption.

Rules:

- Completed steps should not be repeated unless explicitly requested.
- Failed steps should keep their error context.
- A resumed task should first summarize completed work, then continue from the next pending or failed step.
- Task files should be plain JSON or Markdown in the first version so they are easy to inspect and repair manually.

## Model Router

The model router selects a model based on the work type.

The first version should use explicit local rules instead of an opaque AI router.

Example capabilities:

- `coding`: strong code model.
- `reasoning`: strong planning and analysis model.
- `longContext`: model with large context window.
- `cheapBatch`: cheaper model for low-risk batch work.
- `chineseWriting`: model that writes stable Chinese.

The router should integrate with Pi's existing model registry and provider configuration instead of introducing a new provider system first.

## Workers

Workers are specialized executors called by the main agent. They are not autonomous peers in the first version.

Initial worker types:

- `researcher`: read-only research and codebase exploration.
- `reviewer`: read-only review of plans, diffs, and risks.
- `coder`: scoped code changes only.
- `tester`: focused validation commands only.
- `docWriter`: documentation and summary updates.

### Worker Permissions

Permissions should be explicit:

- Read-only workers cannot edit files.
- Coding workers must receive an allowed write scope.
- Parallel coding workers must not share write scopes.
- Destructive git operations remain forbidden.
- Secrets must not be passed into worker prompts unless required and approved.

## Parallelism

Parallelism should be opt-in and safe.

Allowed in the first version:

- Multiple read-only workers.
- Independent research tasks.
- Review while implementation is paused.

Not allowed by default:

- Multiple workers editing overlapping files.
- Workers changing git history.
- Workers pushing to remotes.
- Workers launching unbounded background processes.

For parallel coding later, use isolated git worktrees.

## Memory Integration

The existing mem0 integration should remain silent and shared with the main agent.

Long tasks need additional structure:

- Main agent memories use the current personal namespace.
- Worker memories should include role labels such as `worker:researcher` or `worker:reviewer`.
- Task-specific memories should include the task id.
- Long-task progress should be stored in task files first, not only in semantic memory.

Semantic memory is useful for recall, but task files are the source of truth for durable progress.

## Trace Log

Every long task should keep a trace log.

The trace should record:

- task creation
- routing decision
- model selected for each step
- worker selected for each step
- commands or tools used
- step result
- failure and retry information

The trace should be technical enough for debugging, but concise enough to read.

## First Implementation Slice

The first implementation is intentionally small:

1. Add a task design and storage format.
2. Add a command or extension for creating a long task manually.
3. Store task records under `.pi/tasks/`.
4. Support step status updates.
5. Support resume by reading the task file and summarizing next steps.
6. Keep model routing as config-only hints.
7. Do not implement autonomous worker spawning yet.

This creates the durable foundation without making the everyday assistant heavier.

Implemented extension:

```text
.pi/extensions/long-task-runner.ts
```

Implemented command:

```text
/task create <goal>
/task list
/task show <taskId>
/task add-step <taskId> <title>
/task add-artifact <taskId> <artifact>
/task set-task <taskId> <pending|running|blocked|completed|failed|cancelled>
/task set-step <taskId> <stepId> <pending|running|completed|failed|skipped|blocked> [message]
/task resume <taskId>
```

Implemented model tool:

```text
long_task
```

The tool intentionally manages task records only. It does not spawn workers, run background jobs, or edit files. The main agent can use it to create, inspect, update, and resume durable task state when the work is clearly worth tracking.

The extension also appends task-routing guidance to the system prompt. This guidance keeps immediate mode as the default and tells the model to use `long_task` only when the request is complex enough to justify durable tracking.

## Later Slices

After the foundation is stable:

1. Add `model-router` rules.
2. Add read-only `delegate-worker` for researcher and reviewer.
3. Add scoped `coder` worker.
4. Add safe parallel read-only execution.
5. Add worktree-isolated coding workers.
6. Add task dashboard or status command.

## Open Decisions

- Whether `.pi/tasks/` should start as JSON files or SQLite.
- Whether task creation should be command-driven first, automatic first, or both.
- Whether worker execution should use Pi RPC mode, child processes, or direct extension calls.
- Whether model routing should live in `.pi/model-router.config.json` or reuse existing model configuration.

Initial recommendation:

- Use JSON files first.
- Use manual command first.
- Use Pi RPC or child-process workers later.
- Keep routing hints separate from provider credentials.
