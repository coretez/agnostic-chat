<!--
  DRAFT — NOT PUBLISHED, NOT A ROUTE.

  Proposed page for the Fluency site: /governed-ai-development
  Target repo:  ~/Projects/FluencyNuxtLight
  To publish:   copy to pages/governed-ai-development.vue, add to nav, push.
                (Placing it under pages/ is what makes it a live route — that
                step is deliberately NOT done here.)

  Matches the design system of pages/ai-clients.vue: same section rhythm,
  kicker/h2/body classes, card treatment, light+dark variants, and the
  declarative "evidence over vibes" voice.

  ACCURACY NOTE — every claim below maps to shipped, smoke-covered behavior
  in this repo (O26–O30, 333 assertions). Nothing here describes planned work.
  The O17 guard chain and O13 rollback are NOT mentioned because they are not
  built yet. Review the copy before it goes anywhere public.
-->
<template>
  <div>
    <AppHeader />

    <main class="bg-white text-slate-950 dark:bg-night dark:text-ink">
      <section class="border-b border-slate-200 bg-[linear-gradient(180deg,#f8fbff_0%,#ffffff_54%,#eef7ff_100%)] px-5 py-16 dark:border-white/10 dark:bg-[linear-gradient(180deg,#0b1220_0%,#101c30_58%,#0b1220_100%)] sm:py-24">
        <div class="mx-auto grid max-w-[1240px] gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
          <div>
            <p class="text-sm font-semibold uppercase tracking-[0.16em] text-sky-800 dark:text-sky-300">Governed AI development</p>
            <h1 class="mt-4 max-w-4xl text-5xl font-semibold leading-[1.02] tracking-normal text-slate-950 dark:text-white sm:text-6xl">
              Agents write the code. Gates decide what counts as done.
            </h1>
            <p class="mt-6 max-w-2xl text-lg leading-8 text-slate-600 dark:text-muted">
              An agent that grades its own work will call it finished. Shamrock replaces that judgment with checks it cannot talk its way past: the project's own test command, run by the framework, on every path a change can take.
            </p>
            <div class="mt-8 flex flex-col gap-3 sm:flex-row">
              <NuxtLink to="/headless-access/" class="inline-flex items-center justify-center rounded-lg bg-sky-700 px-5 py-3 text-sm font-semibold !text-white shadow-lg shadow-sky-900/15 transition hover:bg-sky-800">
                See how the gates run
              </NuxtLink>
              <NuxtLink to="/ai-clients/" class="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-5 py-3 text-sm font-semibold !text-slate-900 transition hover:border-sky-400 hover:!text-sky-800 dark:border-white/20 dark:bg-white/5 dark:!text-white dark:hover:border-sky-300">
                AI clients for security work
              </NuxtLink>
            </div>
          </div>

          <div class="rounded-lg border border-slate-200 bg-white p-4 shadow-2xl shadow-sky-950/10 dark:border-white/10 dark:bg-surface dark:shadow-black/30">
            <div class="flex items-center justify-between border-b border-slate-200 pb-4 dark:border-white/10">
              <div>
                <p class="text-xs font-semibold uppercase tracking-[0.16em] text-sky-800 dark:text-sky-300">The turn</p>
                <h2 class="mt-2 text-xl font-semibold text-slate-950 dark:text-white">What runs without being asked</h2>
              </div>
              <span class="rounded-md bg-sky-50 px-3 py-2 text-xs font-semibold text-sky-800 ring-1 ring-sky-100 dark:bg-sky-400/10 dark:text-sky-300 dark:ring-sky-400/20">framework, not prompt</span>
            </div>

            <div class="mt-4 space-y-3">
              <div v-for="step in turnStack" :key="step.title" class="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-white/10 dark:bg-night/60 sm:grid-cols-[9rem_1fr]">
                <p class="text-sm font-semibold text-sky-800 dark:text-sky-300">{{ step.title }}</p>
                <p class="text-sm leading-6 text-slate-600 dark:text-muted">{{ step.body }}</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section class="border-b border-slate-200 bg-white py-14 dark:border-white/10 dark:bg-night">
        <div class="mx-auto max-w-[1240px] px-5">
          <div class="mx-auto max-w-3xl text-center">
            <p class="text-sm font-semibold uppercase tracking-[0.16em] text-sky-800 dark:text-sky-300">Rules become gates</p>
            <h2 class="mt-3 text-3xl font-semibold text-slate-950 dark:text-white sm:text-4xl">A rule you have to repeat is a rule the model can ignore.</h2>
            <p class="mt-5 text-base leading-7 text-slate-600 dark:text-muted">
              Instructions in a prompt are advisory. A command the framework runs is not. Shamrock keeps a short project rulebook for the things judgment still governs, and promotes anything violated twice into a check that fails the work instead of asking nicely.
            </p>
          </div>

          <div class="mt-9 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <article v-for="gate in gates" :key="gate.title" class="rounded-lg border border-slate-200 bg-slate-50 p-5 dark:border-white/10 dark:bg-surface">
              <p class="text-xs font-semibold uppercase tracking-[0.16em] text-sky-800 dark:text-sky-300">{{ gate.kicker }}</p>
              <h3 class="mt-3 text-lg font-semibold text-slate-950 dark:text-white">{{ gate.title }}</h3>
              <p class="mt-3 text-sm leading-6 text-slate-600 dark:text-muted">{{ gate.body }}</p>
            </article>
          </div>
        </div>
      </section>

      <section class="border-b border-slate-200 bg-slate-50 py-14 dark:border-white/10 dark:bg-surface">
        <div class="mx-auto grid max-w-[1240px] gap-10 px-5 lg:grid-cols-[0.52fr_0.48fr] lg:items-start">
          <div>
            <p class="text-sm font-semibold uppercase tracking-[0.16em] text-sky-800 dark:text-sky-300">Nothing evaporates</p>
            <h2 class="mt-3 text-3xl font-semibold text-slate-950 dark:text-white sm:text-4xl">Findings outlive the conversation that produced them.</h2>
            <p class="mt-5 text-base leading-7 text-slate-600 dark:text-muted">
              One bounded fix cycle runs per turn, so review can never spiral. Whatever it does not resolve is written to a tech-debt ledger in the repository, with the finding, the file, and what would fix it. The second time the same finding appears it is flagged for promotion — the signal that a rule has earned enforcement.
            </p>
          </div>

          <div class="grid gap-3">
            <div v-for="record in records" :key="record.name" class="rounded-lg border border-slate-200 bg-white p-4 dark:border-white/10 dark:bg-night/60">
              <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <h3 class="font-mono text-sm font-semibold text-slate-950 dark:text-white">{{ record.name }}</h3>
                <span class="w-fit rounded-md bg-sky-50 px-2.5 py-1 text-xs font-semibold text-sky-800 ring-1 ring-sky-100 dark:bg-sky-400/10 dark:text-sky-300 dark:ring-sky-400/20">{{ record.kind }}</span>
              </div>
              <p class="mt-3 text-sm leading-6 text-slate-600 dark:text-muted">{{ record.body }}</p>
            </div>
          </div>
        </div>
      </section>

      <section class="border-b border-slate-200 bg-white py-14 dark:border-white/10 dark:bg-night">
        <div class="mx-auto grid max-w-[1240px] gap-8 px-5 lg:grid-cols-[0.45fr_0.55fr] lg:items-start">
          <div>
            <p class="text-sm font-semibold uppercase tracking-[0.16em] text-sky-800 dark:text-sky-300">Boundary that matters</p>
            <h2 class="mt-3 text-3xl font-semibold text-slate-950 dark:text-white sm:text-4xl">Standing consent is granted once, deliberately, and shown in full.</h2>
            <p class="mt-5 text-base leading-7 text-slate-600 dark:text-muted">
              The check command runs unattended, so it is treated as an execution grant rather than a preference. It is confirmed in the desktop app's own process, with the exact command on screen — a compromised interface cannot install one for you.
            </p>
          </div>

          <div class="grid gap-4 md:grid-cols-2">
            <article v-for="boundary in boundaries" :key="boundary.title" class="rounded-lg border border-slate-200 bg-slate-50 p-5 dark:border-white/10 dark:bg-surface">
              <h3 class="text-lg font-semibold text-slate-950 dark:text-white">{{ boundary.title }}</h3>
              <p class="mt-3 text-sm leading-6 text-slate-600 dark:text-muted">{{ boundary.body }}</p>
            </article>
          </div>
        </div>
      </section>

      <section class="bg-white py-14 dark:bg-white">
        <div class="mx-auto max-w-[1240px] px-5">
          <div class="grid gap-6 rounded-lg border border-sky-200 bg-sky-50 p-7 text-slate-950 shadow-xl shadow-sky-900/10 lg:grid-cols-[1fr_auto] lg:items-center">
            <div>
              <p class="text-sm font-semibold uppercase tracking-[0.16em] text-sky-800">Start where the work already is</p>
              <h2 class="mt-3 text-3xl font-semibold sm:text-4xl">Point it at a repository with a test command.</h2>
              <p class="mt-4 max-w-3xl text-base leading-7 text-slate-600">
                One command is the whole setup. From there the baseline, the per-step gate, the debt ledger, and the drift pass all have something real to measure against.
              </p>
            </div>
            <NuxtLink to="/headless-access/" class="inline-flex items-center justify-center rounded-lg bg-sky-700 px-5 py-3 text-sm font-semibold !text-white shadow-lg shadow-sky-900/15 transition hover:bg-sky-800">
              Talk to us
            </NuxtLink>
          </div>
        </div>
      </section>
    </main>

    <AppFooter />
  </div>
</template>

<script setup lang="ts">
const turnStack = [
  { title: 'Baseline', body: 'The project check runs once, just before the first change — so breakage that was already there is named as pre-existing instead of blamed on this turn.' },
  { title: 'Per step', body: 'Every step that touches a file is checked. A failure comes back with its output and earns one bounded fix step, never an open-ended retry loop.' },
  { title: 'After delegation', body: 'Work handed to parallel sub-agents is checked too. Their internals stay isolated; the verdict on the tree does not need them.' },
  { title: 'At the end', body: 'A check still failing is stated in the reply, recorded as debt, and left visible rather than summarized away.' },
]

const gates = [
  {
    kicker: 'Verification',
    title: 'The check is the framework\'s job',
    body: 'The project\'s own tests, lint, or build run automatically — not when the model remembers to schedule them. A verify step that already ran the command is not billed a duplicate run.',
  },
  {
    kicker: 'Test integrity',
    title: 'Green is earned, not arranged',
    body: 'A failing test is never deleted, skipped, or weakened to reach passing. Changing a test is legitimate only when the test itself is wrong, and the work has to say so out loud.',
  },
  {
    kicker: 'Context',
    title: 'The repository speaks first',
    body: 'A depth-limited map of the working tree and the project\'s own rulebook are placed in front of the planner, so plans name real files and follow rules that already exist. No rulebook is a valid, zero-cost state.',
  },
  {
    kicker: 'Memory',
    title: 'A debt ledger, versioned in the repo',
    body: 'Unresolved review findings and failing checks are appended to a tracked document with their file and suggested fix. Repeats are marked for promotion into a gate.',
  },
  {
    kicker: 'Maintenance',
    title: 'A pass that looks backward',
    body: 'Per-turn review sees one change. A drift scan reads recently modified files against the rulebook and the project\'s design documents, catching pattern drift and stale docs that no single turn would notice.',
  },
  {
    kicker: 'Transparency',
    title: 'Every verdict is an event',
    body: 'Baselines, per-step checks, skips, fixes, and debt writes all surface in the app\'s process view — the same glass box that shows what actually reached the model.',
  },
]

const records = [
  { name: 'DEBT.md', kind: 'ledger', body: 'Findings the bounded fix cycle left behind, each with its file, severity, suggested fix, and status. Repeats carry a promote-to-gate marker.' },
  { name: 'SPEC.md', kind: 'decisions', body: 'Directions you ratify are appended as dated decision records, so the next session plans against them instead of re-asking.' },
  { name: 'DESIGN.md', kind: 'architecture', body: 'Maintained after changes by a dedicated writer pass reading the files that actually changed — not the model\'s summary of its own work.' },
  { name: 'AGENT_RULES.md', kind: 'rulebook', body: 'The short, non-negotiable rules for the repository, injected into planning and execution. Kept small on purpose: a rulebook nobody prunes is a rulebook nobody follows.' },
]

const boundaries = [
  { title: 'Confirmed in the app, not the page', body: 'Enabling an unattended command requires a confirmation from the desktop process itself, showing the verbatim command it will run.' },
  { title: 'Failure is reported, not smoothed', body: 'A check still failing at the end marks the reply and the saved message. A confident summary never hides a red build.' },
  { title: 'Bounded everywhere', body: 'One fix cycle per finding set, one fix step per failing check, and fix steps that re-verify but cannot trigger further inserts.' },
  { title: 'Scope holds', body: 'Every file action resolves inside the project directory, symlinks included. Gates add restriction; they never grant reach.' },
]

useSeoMeta({
  title: 'Governed AI Development | Shamrock by Fluency',
  ogTitle: 'Governed AI Development',
  description: 'Shamrock runs your project\'s own tests as a framework gate on every path an AI change can take, records what it cannot fix, and scans for architectural drift — so agent-written code is verified rather than asserted.',
  ogDescription: 'Deterministic check gates, a versioned debt ledger, test-integrity rules, and a backward-looking drift pass for AI-assisted development.',
})
</script>
