# Test Task 2: Small Documentation Update

## Prompt
"Update .pi/multi-agent-orchestration.md to add a section about the worker executor tool."

## Classification
- **Mode:** immediate (simple doc edit)
- **Alternative:** long_task if user explicitly asks to track

## Expected Worker Plan (if escalated to multi_agent_candidate)
1. **researcher** — Read current .pi/multi-agent-orchestration.md, understand structure
2. **docWriter** — Add worker executor section
3. **reviewer** — Review doc change for accuracy and readability

## Expected Test Commands
```bash
grep "worker executor" .pi/multi-agent-orchestration.md
```

## Acceptance Criteria
1. New section exists in orchestration doc
2. No markdown syntax errors
3. Section is factually accurate about the worker_execute tool
