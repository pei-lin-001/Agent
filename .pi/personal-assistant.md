# Personal Assistant Foundation

This project now has two separate context layers:

- Stable profile: `.pi/extensions/personal-profile.ts`
- Dynamic long-term memory: `.pi/extensions/mem0-memory.ts`

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
