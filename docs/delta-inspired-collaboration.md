# Delta-Inspired Collaboration: Design Proposal

**Status: proposal — Phase 1 done (U3, A1a, A1b); Phase 2 done (U1, U2, U4); Phase 3 done
(A2 — named branch; the `local` remote half dropped as redundant); Phase 4 done (A3 —
session + file rewind: A3a host primitives, A3b renderer wiring, A3c per-message UI); U5
(cowork sidebar nesting) done; cowork page attachments done (gap fill).**

This document studies [Delta](https://delta.dev/docs) (Zed's collaborative agent
workspace) and proposes which of its ideas are worth borrowing into GreyWork, split
into two tracks:

- **Architecture** — worktree preparation, branch handback, session/file rewind.
- **UI** — the "group chat" interaction model.

When an item here is implemented, its decision should be folded into
[`architecture.md`](./architecture.md) (host/domain side) and
[`ui-design.md`](./ui-design.md) (renderer side), which remain the canonical design
docs. This file is the proposal and the record of what we deliberately rejected.

## Why Delta is relevant

Delta and GreyWork are in the same product category: a workspace where an agent works
on a checkout of your repository and you review the result. Delta is _not_ a drop-in
component for GreyWork — it is a closed, cloud-backed client (all data on Cloudflare,
Zed account required, no self-hosting, no ACP server mode, no public API). It cannot
be plugged in as an ACP backend the way Claude Code / Gemini CLI can, and it conflicts
with GreyWork's single-user self-hosted posture. So the value is in **ideas**, not
integration.

## Part 1 — Delta's "group chat" is three mechanisms

1. **One timeline, every participant is a first-class author.** Messages, edits,
   comments and agent activity all land in one thread; each message is attributed and
   the agent knows who wrote it. Avatars carry per-person colors.
2. **Live drafts.** In-progress composer text is visible to everyone as it is typed.
   Pressing send submits _every trailing draft_ — from all authors — as one agent turn,
   charged to whoever sent.
3. **Comments on a passage.** Select text in a message or a diff, attach a note; notes
   thread, and the agent's reply links back to the annotation.

## Part 2 — GreyWork today

| Dimension          | Delta                             | GreyWork                                                                                                             |
| ------------------ | --------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Message author     | multi-author, avatar + color      | `ThreadMessage` has only `role: user \| assistant \| system` (`packages/workbench/src/types.ts:239`)                 |
| Conversation shape | one thread, many people           | 1:1 bubbles (`features/conversation/ConversationMessage.vue`)                                                        |
| Multi-member       | same timeline                     | Cowork: each slot owns its own thread; the panel is pills + task board + mail list (`features/team/CoworkPanel.vue`) |
| Pending messages   | drafts inline, submitted together | `commandQueue` exists but is not in the stream (`stores/chat/state.ts`)                                              |
| Selection action   | comment                           | `SelectionToolbar` / `SelectionLayer` / `lib/selection.ts` already do "selection → send to conversation"             |
| Sub-agents         | nested in sidebar / tabs          | clicking a slot navigates away                                                                                       |

The core gap: **GreyWork's collaboration is multi-agent orchestration; Delta's is a
group chat.** Notably, `CoworkMail` (`packages/cowork/src/types.ts`, with
`from` / `to` / `body` / `summary`) is _already_ a chat message model — it is just
rendered as a mail list instead of a transcript.

## Part 3 — Architecture borrowings

### A1 · `.agents/prepare` + `.agents/linked`

- **Delta:** when a new checkout is created it runs `.agents/prepare` (must be fast),
  and symlinks files listed in `.agents/linked` to a shared location.
- **GreyWork then:** `worktree_provision` only ran `git worktree add --detach` or a
  directory copy; there was no prepare hook and no shared-file linking
  (`crates/greywork-host/src/infra/worktree.rs`).
- **Fit:** the repo already uses `.agents/skills/`, so `.agents/` is an established
  convention.
- **Split into two steps**, because the two halves have very different risk profiles:

#### A1a · `.agents/linked` — **implemented**

- **What:** after a checkout is provisioned, each entry in `<source>/.agents/linked` is
  symlinked from the source into the new snapshot.
- **Guards (all part of the change):** entries must be a safe relative path (no `..`,
  no absolute/root prefix), must be git-ignored (else the link shows up as a new file in
  `git status` and the agent's change view), and must already exist in the source. Any
  violation is logged and skipped — provisioning never fails because of a bad manifest.
- **Platform note:** symlinks are created directly (no copy fallback). On Windows this
  needs Developer Mode or admin rights; failure degrades to a logged warning rather than
  a broken checkout.
- **Touch points:** `crates/greywork-host/src/infra/worktree.rs` (+ tests).

#### A1b · `.agents/prepare` — **implemented**

- **What:** run `<checkout>/.agents/prepare` after provisioning (build-cache setup, git
  hooks, config files). Delta warns it must be fast — it runs on every fresh checkout.
- **Why it was separate:** this executes a script shipped inside the repository, so it
  needed its own security review and could not ride along with A1a. The three concerns
  called out when it was scoped are all addressed:
  - **Tier gating (fail-closed).** `prepare` defaults **false** everywhere: the host
    `ProvisionArgs` marks `prepare` `#[serde(default)]`. The renderer
    (`lib/workspace-dir.ts`) only opts in when
    `permissionTier !== "read-only"`, and — the load-bearing part — the server clamps it
    regardless of what the renderer sends: `overlay_args` in `apps/server/src/policy.rs`
    forces `prepare = false` when `tier == "read-only"`, exactly like `acp_start`'s
    `sandbox` / `tier`. A compromised renderer cannot run a repo script on a `read-only`
    host.
  - **Timeout.** The run is bounded by a 30s `PREPARE_TIMEOUT`; a hang is killed rather
    than blocking provisioning.
  - **Platform shell.** On unix the script runs directly when executable, else via
    `sh <script>`; on Windows it runs via `cmd /C <script>`.
- **Failure is warn-only.** A non-zero exit, timeout, or spawn error logs a warning and
  the checkout is still provisioned — matching A1a's "a bad manifest never fails
  provisioning" posture.
- **Touch points:** `crates/greywork-host/src/infra/worktree/` (+ tests),
  `crates/greywork-host/src/infra/git/` (`run_capture` → `pub(crate)`),
  `crates/greywork-host/src/app/commands/git.rs`,
  `apps/server/src/policy.rs` (+ test), `packages/workbench/src/lib/workspace-dir.ts`.
- **Cost:** medium (done).

### A2 · Two remotes (source + local) — **implemented (named branch only)**

- **Delta:** a managed checkout has a _source_ remote (your upstream, e.g. GitHub) and a
  _local_ remote pointing at your own clone, so the agent can push a branch straight
  into your repository without a round trip through the forge.
- **GreyWork today:** the worktree was created `--detach`, so there was no branch to hand
  back. Worse, `release` runs `git worktree remove --force --force`, which deletes the
  detached HEAD — the agent's commits became unreachable and were effectively lost.
- **What shipped:** create the worktree on a **named branch** `greywork/<slug>-<hash12>`
  (same slug + fingerprint as the snapshot directory) instead of `--detach`. If the
  branch already exists (e.g. left behind by a previous `release`), it is **reused**
  (attached), never reset — `-B` is deliberately avoided because it would silently
  discard commits the user may have merged or still wants. On any failure it still falls
  back to the directory copy, as before.
- **Why the `local` remote half was dropped** (verified on a scratch repo before writing
  any code — the original proposal predated this check):
  - **A linked worktree shares `refs/heads/*` with the source repo.** A branch created in
    the worktree is _already_ visible in the user's checkout (`git branch` marks it `+`),
    so handback needs **no remote at all**. The `local` remote would be redundant.
  - **The worktree already inherits the source's remotes** (`origin`, …) via the shared
    config — the "source remote" half is free.
  - **A remote added inside a worktree leaks into the shared `.git/config`** (the source's
    `git remote -v` shows it). Scoping it needs `extensions.worktreeConfig=true` +
    `git config --worktree`, but that flag is itself a mutation of the user's shared
    config — a real cost for near-zero benefit.
  - **Pushing into the user's checkout is not viable by default:** `receive.denyCurrentBranch`
    defaults to `refuse`, so `git push local HEAD:main` is rejected. (The earlier draft's
    "a clean checkout updates in place" was wrong.) Only pushes to a _non-checked-out_
    branch succeed — and those are the redundant case above.
- **Handback:** the branch survives `release` and is discoverable with
  `git branch --list 'greywork/*'` / `git log <branch>`; merge it into your working branch
  as usual. **Caveat:** the snapshot marker `.greywork-worktree.json` lives at the
  worktree root, so an agent that commits with `git add -A` will include it in the handed
  back branch (pre-existing behaviour, now durable). Left as a known follow-up rather
  than bundling an orthogonal marker-relocation refactor into A2.
- **Touch points:** `crates/greywork-host/src/infra/worktree.rs` (+ tests).
- **Cost:** small (done).

### A3 · Rewind conversation and files together (largest, last)

- **Delta:** DeltaDB records each edit as a delta; reverting a thread rewinds the
  conversation _and_ the thread's files to an earlier point, with no commit involved.
- **GreyWork today:** `worktree_provision`/`release`/`list` manage whole-run snapshots
  (`~/.greyWork/worktrees/<slug>-<hash>`), with a read-only management UI
  (`features/settings/WorktreeSnapshotsCard.vue`), but there is **no per-turn snapshot**
  and no "rewind the session and its files together". The message stream lives in
  `SessionRecord.messages` (opaque JSON, `stores/session.ts:16-35`) with **no truncate
  API** — the only message-level splice today is `cancelPlan` (`chat/submit.ts:86-90`).

#### A3.1 · Snapshot primitive (validated on a scratch repo)

A per-turn snapshot must not disturb the agent's working state, must not move the
handed-back branch, and must survive worktree release. Verified approach — a commit
written into a **private ref namespace** through a **temporary index**:

```
GIT_INDEX_FILE=<tmp> git read-tree HEAD      # seed temp index from the branch base
GIT_INDEX_FILE=<tmp> git add -A              # stage tracked + untracked (respects .gitignore)
tree=$(GIT_INDEX_FILE=<tmp> git write-tree)
sha=$(git commit-tree "$tree" -p HEAD -m "greywork turn <n>")
git update-ref refs/greywork/turns/<session>/<n> "$sha"
```

- **Non-destructive:** the real index and the branch tip are untouched (verified — the
  agent keeps editing as if nothing happened).
- **Private namespace:** `refs/greywork/*` is not under `refs/heads`, so it never shows in
  `git branch` or the handed-back branch; it **survives `git worktree remove`** and its
  objects stay readable.
- **Scope:** keyed by session id — several conversations can bind the same worktree, so
  refs are `refs/greywork/turns/<sessionId>/<n>` (sessionId sanitised to a ref component).
- Each snapshot is a **full tree** (not a delta), parented on `HEAD`, so
  `git diff HEAD <ref>` reads as "all agent changes up to this turn".

Restore back to a snapshot:

```
git read-tree --reset -u <ref>   # worktree + index := snapshot
git clean -fdq                   # delete files created after the snapshot
git reset -q                     # index := branch HEAD; worktree untouched
```

Verified: modified files restored, files added after the snapshot removed,
previously-untracked files re-materialised, and the post-restore `git status` is a normal
dirty worktree. Ignored files are neither snapshotted nor restored (documented).

#### A3.2 · Anchoring & semantics

- **Snapshot at turn _start_, anchored to the user message** (the `snapshotRef` is recorded
  on the user message and persisted with the session JSON). Taking it before `acp.prompt()`
  is what makes it "the state this turn started from" — one self-contained ref per rewind
  target, no initial-snapshot bookkeeping needed. (The earlier sketch proposed snapshotting
  at turn _end_ and anchoring to the assistant message; the turn-start form is simpler and
  is what shipped.)
- **Decision (made):** rewind targets a **user turn** — drop that user message and
  everything after it, restore the matching snapshot, so the user can re-edit and re-run.
  (The alternative — rewind to _after_ an assistant turn, keeping it — is a smaller action
  and can be added later.)
- **Decision (made):** **hard restore** — the worktree is made strictly equal to the
  snapshot (files created after it are deleted), behind a confirm dialog.
- **Scope:** only normal user turns (`!options.hooks` — planner/remote turns are not user
  turns), only `runMode === "worktree"`, only when the session already has a `cwd`. A
  failed snapshot (e.g. a `copy`/`direct` checkout) is warn-only — the turn proceeds and
  that message simply has no rewind target.

#### A3.3 · Load-bearing limitation: the agent cannot rewind

GreyWork sends the agent **only the new prompt** — it never replays history
(`packages/acp/src/client.ts:204-208`); the agent keeps its context server-side keyed by
`sessionId`, and ACP has no truncate/rewind call (only `session/cancel`). So rewinding the
_displayed_ messages does **not** rewind the agent's memory. A rewind must therefore
**clear the ACP binding** so the next turn opens a fresh session — which means the agent
**forgets everything**, not just the rewound turns. This is the core divergence from Delta
and must be surfaced in the UI ("回退会重置 agent 的上下文"). Keeping the session and
accepting that the agent still remembers is incoherent and rejected.

#### A3.4 · Phasing

| Step | Content                                                                                                                                                                        | Status   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| A3a  | host primitives `worktree_snapshot` / `worktree_restore` (+ tests) in `infra/worktree.rs` (ref namespace + temp index)                                                         | **done** |
| A3b  | renderer wiring: snapshot at turn start (gated on `!hooks` + worktree mode), `snapshotRef` on the user message, `rewindTo` = restore + truncate `messages` + clear ACP binding | **done** |
| A3c  | UI: per-message "回退到这里" + confirm dialog; doc                                                                                                                             | **done** |

- **A3a delivered:** `worktree_snapshot(root) -> ref` (temp-index `write-tree` →
  `commit-tree` → `update-ref refs/greywork/snap/<id>`) and
  `worktree_restore(root, ref)` (`read-tree --reset -u` + `clean -fd` + `reset`), guarded to
  our own `kind=git` snapshots; refs validated to the `refs/greywork/snap/` namespace.
  Registered in the shared command table and the desktop handler (drift test green).
- **A3b delivered:** `worktreeBackend.snapshot/restore`; `ThreadMessage.snapshotRef`;
  `startAcpTurn` returns the user message; `sendGlobalTurn` snapshots at turn start
  (`agent/turn.ts`); session `truncateMessages`; `agent.rewindTo(threadId, messageId)` does
  restore → truncate → clear binding → reset session ownership. Exposed on the agent store.
  Tests: `tests/unit/stores/rewind.test.ts` (+ session `truncateMessages` case).
- **A3c delivered:** the message context menu (`lib/context-menu.ts`) gains an optional
  `rewind` action — the view supplies it only for `role=user` messages carrying a
  `snapshotRef` (availability lives in the view, the builder just renders "回退到这里" with a
  separator + destructive styling when given). `ConversationView` opens a `ConfirmDialog`
  whose body spells out the A3.3 limitation (files hard-restored; this and later messages
  discarded; **agent context is reset**), and on confirm calls `agent.rewindTo(...)`; failures
  surface through the global notice store. Tests: builder cases in
  `tests/unit/lib/context-menu.test.ts`, UI wiring in `ConversationView.contextmenu.dom.test.ts`.
- **Non-goals:** no DeltaDB-style continuous deltas; no cross-session rewind; no rewind
  once the worktree has been released (the ref survives, but there is no worktree to
  restore into).
- **Cost:** large — treat as its own project, delivered in the three checkpoints above; do
  not bundle with the UI work.

## Part 4 — UI borrowings (the group chat)

### U1 · Give messages an author dimension — **implemented**

- **What:** `ThreadMessage` gained optional `authorId` (`user` / `system` / a cowork slot
  id) and `authorName`. When set, `ConversationMessage` renders an author row (initial
  avatar + name) above the message and emits `authorClick` so a transcript can open that
  author's session.
- **Reuse:** `docs/ui-design.md` already defines the `--grey-*` agent identity color
  family — used rather than introducing new tokens. The mapping lives in a pure module,
  `lib/author-identity.ts`: a stable hash picks a `--grey-*` color per author id (same
  author ⇒ same color across sessions), with `user` / `system` pinned to fixed colors.
- **Coupling (found during implementation):** there is no producer for extra authors
  today — every message is `user` / `assistant` / `system`, and the only multi-author
  source is Cowork (each slot owns its own thread). So U1 alone would be dead code; it
  shipped **together with U2**, which is where the authors come from.
- **Touch points:** `packages/workbench/src/types.ts`,
  `features/conversation/ConversationMessage.vue`, `lib/author-identity.ts` (new, + test),
  `features/conversation/__tests__/ConversationMessage.author.dom.test.ts` (new).
- **Cost:** small (done).

### U2 · Collapse Cowork into a team timeline (highest value) — **implemented**

- **Delta:** one thread, many participants.
- **GreyWork today:** `CoworkPanel` is a control console (slot pills, task board, mail
  list); each member's output lives in its own thread and you navigate away to read it.
- **Implemented:** the "activity" card gained a segmented **toggle** between the existing
  mail list and a new group-chat **timeline**. The timeline projects `CoworkMail` into a
  chronological `ThreadMessage[]` (`stores/cowork.ts` → `transcript`, carrying `authorId` /
  `authorName`) and renders it with `ConversationMessage`, so leader, teammates and the
  user appear in one stream with per-author avatars; clicking an author row opens that
  member's full session. This is a _view_ layered on top of the existing model; it does
  **not** change the "each slot owns its own session" core (which is what lets single-chat
  streaming, permission prompts and model switching be reused as-is).
- **Touch points:** `features/team/CoworkPanel.vue` (toggle + transcript),
  `stores/cowork.ts` (`transcript` projection, + test), i18n locales.
- **Decision (made):** the transcript sits **beside** the mail list as a toggle, not a
  replacement — lower risk and keeps the existing mail-list view available. The mail list
  stays the default view.
- **Cost:** medium (done).

### U3 · Queued messages as Delta-style pending drafts — **implemented**

- **Delta:** trailing drafts are inline, editable, deletable, and submitted together.
- **GreyWork today (before this change):** the M5 queue was a half-built feature — the
  slice, its tests, and the `waiting` session status all existed, but the composer
  **blocked** sending during a turn (it never enqueued) and nothing rendered the queue.
  Worse, the auto-drain called `submitText` directly, bypassing `dispatchIntent`, so
  wiring it as-is would have routed queued messages to the local LLM even in an ACP
  session.
- **Implemented:** the drain now goes through `dispatchIntent` via an app-level bridge
  (`lib/queue-bridge.ts`, wired in `Shell.vue`) — the queue slice stays a plain list and
  falls back to `submitText` only when no dispatcher is injected. The composer enqueues
  while a turn is active (attachments are materialized before enqueue), and pending
  items render inline above the composer, each removable or pull-back-to-edit.
- **Deviation from Delta:** GreyWork drains **one item per turn** (the existing tested
  `auto` behaviour), not "submit all trailing drafts as one turn". Changing that would
  alter the M5 contract and is a separate decision.
- **Touch points:** `stores/chat/queue.ts`, `stores/chat/index.ts`,
  `lib/queue-bridge.ts` (new), `features/shell/Shell.vue`,
  `features/conversation/ConversationView.vue`, i18n locales.
- **Cost:** small–medium (done).

### U4 · Comment on a selection — **implemented**

- **Delta:** select text in a message or diff, attach a comment; comments thread and the
  agent's reply links back.
- **GreyWork today:** the selection infrastructure already exists —
  `features/preview/SelectionToolbar.vue`, `SelectionLayer.vue`, `lib/selection.ts` —
  and does "selection → send to conversation".
- **Implemented:** the selection toolbar gained a **Comment** action. Clicking it reveals
  an inline note input; submitting emits `chat:comment` with the selected passage, the
  note and the source. A new bridge (`lib/use-chat-comment.ts`) records a
  `MessageComment { quote, note, source }` on the composer's comment draft **and** appends
  the note to the draft text (the note is what you're saying to the agent; the quote is
  the annotation). The comment rides the message as the new `comments?` field on
  `ThreadMessage`, rendered as a quoted annotation on the user bubble. The referenced
  passage is prepended to the prompt (`lib/message-comments.ts` → `buildCommentPrompt`) so
  the agent knows what the note is about; the note itself is already the message body.
- **Deviation from Delta:** the agent reply is **not** back-linked to the annotation — the
  annotation lives on the user message and the reply is simply the assistant message that
  follows. A true bidirectional link needs a reply-reference id and is a separate decision.
- **Plumbing:** comments travel the same path as attachments — `dispatchIntent` option →
  `chat.submitText` / `agent.dispatchToAcp` → `startAcpTurn` → message; the send queue
  carries them too (`QueuedCommand.comments`), and the ACP plan gate stashes them on the
  scaffold (`planComments`) so a plan-confirm re-dispatch keeps them.
- **Touch points:** `types.ts` (`MessageComment`, `ThreadMessage.comments`, `planComments`,
  `QueuedCommand.comments`), `events.ts` (`chat:comment`), `lib/use-chat-comment.ts` (new,
  - test), `lib/use-chat-receiver.ts`, `lib/message-comments.ts` (new, + test),
    `lib/dispatch-intent.ts`, `stores/chat/submit.ts`, `stores/chat/queue.ts`,
    `stores/chat/index.ts`, `stores/agent/{turn,shared}.ts`,
    `features/preview/SelectionToolbar.vue`, `features/preview/SelectionLayer.vue`,
    `features/conversation/ConversationView.vue`, `features/conversation/ConversationMessage.vue`,
    `features/guid/GuidView.vue`, i18n locales.
- **Cost:** medium (done).

### U5 · Sidebar nesting — **implemented**

- **Delta:** sub-agents are nested under their parent in the sidebar; subthreads open as
  tabs.
- **Proposal:** nest cowork slots under their run in the sidebar and add "open as
  primary", instead of only navigating away on click.
- **What shipped:** the sidebar gained a **Cowork** section (`features/team/CoworkSiderSection.vue`,
  mounted by `Sider.vue`): the current run is the parent node (goal + run-status chip;
  click → `/team` console) and each member slot is nested under it (wake dot + name +
  unread/failed badge; click → open that slot's session, i.e. the existing
  `openSlot` behaviour). Zero render when there is no run.
- **"Open as primary" needed no new state:** GreyWork is route-based with a single main
  pane, so opening a slot's session in the main pane _is_ `router.push('/conversation/:threadId')`
  — the same primitive the sidebar already uses for any session. No tab/primary-pane
  concept was introduced (the Delta model doesn't map onto a route-based shell).
- **De-duplication:** a slot owns a real session, so it would otherwise appear both under
  the run and in the normal "workspace → sessions" list. `groupSessions` gained an
  `excludeIds` set; `Sider` computes the current run's slot threadIds and passes them to
  `GroupedHistory` via a new `excludeSessionIds` prop, so a slot's session shows **only**
  under its run (matching Delta's "subthreads are nested, not duplicated").
- **Scope note:** cowork runs are in-memory only (a single run at a time, no archive);
  the section is therefore session-scoped and disappears on reload, consistent with the
  rest of the cowork model. When a new run starts it replaces the node, and the previous
  run's slot sessions reappear in the workspace list.
- **Cost:** medium (done).

### Cowork page attachments — **implemented** (gap fill, not a Delta borrowing)

Not a Delta borrowing — this closed a capability gap found while shipping U5: the Team
page could only send text, so there was no way to hand a member a file/image.

- **What shipped:** both entry points on the cowork page now take attachments — the start
  form's goal (initial context for the leader) and the "talk to team" input (to the
  leader or a chosen member). `CoworkPanel` reuses the conversation composer's
  `useAttachments` + `AttachmentTray` (pick / drag / paste).
- **Delivery:** attachments are materialized into the **target member's** session
  attachment library (`stores/cowork.ts`), stashed in a per-slot map, and consumed on that
  member's next dispatch — converted with `toAcpUnits` and passed to `acp.prompt` as prompt
  units. Keying by slot (not mail id) matches the engine, which already drains a slot's
  whole inbox into one prompt per turn. The member's audit message lists the attachment
  names.
- **Image gating:** each slot's ACP session records whether it declared `imagePrompts`
  (`startRun`); on dispatch, `toAcpUnits(attachments, targetSupportsImages)` drops images
  the target backend can't take and notifies — gating by the **target member**, since
  members can run on different backends.

### U6 · Chat-first console + run capabilities + teammate commits — **implemented**

Follow-up to U2, requested as "make the team UI modern, let it use skills / MCP, and let me
see teammates' commits".

- **Chat-first layout.** The running console now leads with the group-chat transcript (U2's
  timeline is the default view, mail list is the secondary tab) in a fixed-height, auto-scrolled
  panel with the composer docked beneath it; the task board and the new commits card sit in a
  right rail. The start form is split into three cards: goal, members, and run capabilities.
- **Run-level capabilities (skills + MCP).** The start form gains a `CoworkTooling` card: MCP
  servers and skills are toggles, defaulting to the settings-enabled servers and all installed
  skills. `startRun` accepts a 4th `CoworkRunOptions` arg; the MCP selection overrides
  `settings.enabledMcpServers` for this run, and the skill selection is threaded through
  `isolateForRun(base, { skills })` → `worktree_provision.skills` (see `architecture.md`). The
  filter only bites under `worktree` isolation; every other mode uses the source directory, so
  the card says so. Declared/skipped MCP servers (per the agent's capabilities) are surfaced on
  the run header.
- **Git integration — "see teammates' commits".** Cowork members share one isolated workspace on
  one `greywork/<slug>-<hash>` branch, so teammate commits are that workspace's history. The
  store attaches a git service at `startRun`, records a baseline, and refreshes on each turn;
  `CoworkCommits` renders the log (author avatar, subject, `fromRun` badge, branch) and lazy-loads
  a commit's diff. Non-git workspaces hide the card, and the run proceeds.
- **Not done (deliberately).** Per-member worktrees/branches: members still share one snapshot.
  Splitting them would let each teammate own a branch, but it changes the workspace/session
  wiring (one `isolateForRun` call today) and is a separate project — the commit card works with
  the shared snapshot and does not depend on that split.
- **Touch points:** `features/team/CoworkPanel.vue`, `CoworkTooling.vue`, `CoworkCommits.vue`,
  `TeamView.vue`, `stores/cowork.ts` (`CoworkRunOptions`, `availableSkills`, commit state),
  `stores/skills.ts` (`scanSkills`), `lib/workspace-dir.ts`, `infra/worktree/skills.rs`,
  `worktree_provision` args, i18n locales.
- **Cost:** medium (done).

## Part 5 — Suggested phasing

| Phase | Content                                                                                   | Leverage                              |
| ----- | ----------------------------------------------------------------------------------------- | ------------------------------------- |
| 1     | ~~U3 (queued drafts)~~ + ~~A1a (linked)~~ + ~~A1b (prepare)~~ **done**                    | small changes, immediately visible    |
| 2     | ~~U2 (team timeline)~~ + ~~U1 (author dimension)~~ + ~~U4 (selection comments)~~ **done** | the bulk of the group-chat experience |
| 3     | ~~A2 (two remotes)~~ **done** (named branch; remote half dropped)                         | closes the workflow loop              |
| 4     | ~~A3 (session + file rewind)~~ **done** (A3a/A3b/A3c)                                     | large; separate project               |
| 5     | ~~U6 (chat-first console, run capabilities, teammate commits)~~ **done**                  | polishes the console; host skills fix |

U1 moved from phase 1 to phase 2: it needs U2 to have any producer (see U1 above).
Phase 2 was delivered in two checkpoints — U1 + U2 first, then U4. A2 was scoped down at
implementation time: a pre-code probe showed the `local` remote is redundant for a
_worktree_ (shared refs already hand the branch back), so only the named-branch half
shipped. Run each phase to full acceptance, stop and report, then continue — matching the
existing preference for stepwise delivery with checkpoints.

## Part 6 — Deliberately not borrowed

- **Delta as an agent backend.** Delta is a workspace, not an agent; it exposes no ACP
  server mode and no programmatic API. `delta` CLI is account/thread administration only.
- **Cloud sync / sharing.** Delta's thread sharing depends on Cloudflare-hosted DeltaDB
  and a Zed account; GreyWork is single-user and self-hosted, so multi-human presence,
  "anyone with the link", and follow-a-collaborator do not apply. The group-chat
  mechanisms are borrowed to describe **agents as participants**, not remote humans.
- **DeltaDB as a storage engine.** The continuous-delta model is interesting (A3) but
  adopting the storage layer wholesale would replace git-based history; only the
  rewind _capability_ is proposed, built on git.

## Appendix — Sources

- <https://delta.dev/docs/concepts/core-concepts>
- <https://delta.dev/docs/concepts/delta-and-git>
- <https://delta.dev/docs/concepts/worktrees>
- <https://delta.dev/docs/collaboration/collaborate-thread>
- <https://delta.dev/docs/agents/comments>
- <https://delta.dev/docs/agents/models-and-providers>
- <https://delta.dev/docs/privacy-and-security/data-storage>
