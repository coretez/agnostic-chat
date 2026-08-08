## What this changes

<!-- One or two sentences. If it closes an issue, link it. -->

## How it was verified

<!-- Paste the relevant output. New behavior needs coverage in scripts/smoke.js. -->

```
npx electron scripts/smoke.js
```

## Checklist

- [ ] Every commit is signed off (`git commit -s`) — see [DCO](../DCO)
- [ ] `npx electron scripts/smoke.js` ends with `ALL SMOKE TESTS PASSED`
- [ ] No new runtime dependencies (or the addition was agreed in an issue first)
- [ ] Anything that changes what reaches the model emits a process event, so
      the INTERNALS tab still shows the truth
