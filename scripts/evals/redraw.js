'use strict';

// Does a model-generated redraw of the pipeline flowchart carry the O26 gate's
// two guarantees — that the baseline runs BEFORE the first change, and that the
// fix step cannot spiral?
//
// Result on 2026-08-14 (14 trials): NO. Survival ran at roughly 1 in 5 and was
// uncorrelated with encoding, node budget, or naming the facts as MUST-KEEP
// requirements (the must-keep arm scored 0/3 against a 1/3 control). An 8-of-8
// miss streak that looked systematic was ordinary variance at that rate.
//
// Kept as a regression eval: if a future model preserves these reliably, the
// hand-editing step after generating a graphic can be dropped. Until then, a
// generated diagram is verified and patched by hand, never trusted.

const SOURCE = `flowchart TD
  SEND(["user SEND"]) --> A["setup + harness"]
  A --> C["Pass 1 select context"]
  C --> I["Pass 2 derive plan"]
  I --> J{"simple or <=1 step?"}
  J -- "yes" --> FLAT["flat loop"]
  J -- "no" --> STEP["execute step"]
  STEP --> FIRST{"first mutation of this turn?"}
  FIRST -- "yes" --> BASEN["O26 BASELINE — check runs BEFORE anything changes; pre-existing failures attributed, never inherited"]
  FIRST -- "no" --> MUT
  BASEN --> MUT{"step mutated?"}
  MUT -- "no" --> SQ{"stuck?"}
  MUT -- "yes" --> CHK["O26 check gate"]
  CHK --> CP{"check passes?"}
  CP -- "yes" --> SQ
  CP -- "no" --> FIX["ONE bounded fix step"]
  FIX --> ONCE["single re-check — gate cannot spiral"]
  ONCE --> SQ
  SQ -- "no" --> NEXT{"more steps?"}
  NEXT -- "yes" --> STEP
  NEXT -- "no" --> REV["O11 review"]
  REV --> DEBT["O27 debt ledger"]
  DEBT --> K["persist + measure"]
  FLAT --> K`;

const MUST_KEEP = `
MUST-KEEP (these are the point of the diagram — never drop them):
- that the O26 baseline runs BEFORE the first change, so pre-existing failures are not blamed on this turn
- that the fix step re-checks ONCE and cannot spiral`;

const prompt = (budget, must) => `Redraw this mermaid flowchart as a legible WEBSITE GRAPHIC.

Hard limits: ${budget} nodes maximum, short labels (2-5 words), decision diamonds for real branch points, valid standalone mermaid. Group with subgraphs.${must}

SOURCE:
\`\`\`mermaid
${SOURCE}
\`\`\`

Reply with ONLY the fenced mermaid block.`;

module.exports = {
  name: 'redraw',
  description: 'do the O26 guarantees survive a compressed redraw?',
  replicates: 3,
  variants: {
    'control 18-24': prompt('18-24', ''),
    'must-keep 18-24': prompt('18-24', MUST_KEEP),
    'budget 30': prompt('30', '')
  },
  predicates: {
    baseline: (t) => /baseline/i.test(t),
    'no-spiral': (t) => /never re-?insert|cannot spiral|no re-?insert|once only|single re-?check|no second fix|re-?check once/i.test(t)
  }
};
