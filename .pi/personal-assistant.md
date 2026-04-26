# Personal Assistant Foundation

This project now has two separate context layers:

- Stable profile: `.pi/extensions/personal-profile.ts`
- Dynamic long-term memory: `.pi/extensions/mem0-memory.ts`

It also has a planned task architecture for balancing quick everyday work with long-running complex tasks:

- Task architecture: `.pi/long-task-agent.md`
- Task router template: `.pi/task-router.config.example.json`
- Long-task runner: `.pi/extensions/long-task-runner.ts`

## Stable Profile

Global private profile:

```text
~/.pi/agent/profile.md
```

Project profile:

```text
.pi/profile.md
```

Template:

```text
.pi/profile.example.md
```

Use stable profile files for facts and preferences that should not depend on semantic retrieval, such as communication style, long-term goals, operating principles, and security preferences.

## Dynamic Memory

Use mem0 for automatically extracted memories from real conversations. The user should not need to issue explicit memory commands.

## Service Commands

```bash
.pi/mem0-service.sh start
.pi/mem0-service.sh status
.pi/mem0-service.sh stop
.pi/mem0-service.sh logs
```

The service uses local runtime files under `.pi/memory/`, which are ignored by Git.

## Task Architecture

The personal agent should keep simple tasks lightweight by default.

Long-task mode should only be used when work is clearly complex, multi-step, long-running, interruptible, or explicitly requested by the user.

The first implementation is a local task runner that stores durable task records under `.pi/tasks/`. Those runtime task files are ignored by Git.

Available command:

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

Available model tool:

```text
long_task
```

The model should use `long_task` only for complex, multi-step, interruptible, or explicitly tracked work. Simple requests should stay in immediate mode.

The extension also injects task routing guidance into each turn so the main agent knows that immediate mode remains the default and long-task mode is reserved for genuinely complex work.
