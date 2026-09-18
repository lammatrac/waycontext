# Phase Manifest — WayDocs AI (AI Tutorial Video Generator)

Source spec: `tasks/context/ai-tutorial-video-generator/spec.md` (975 lines).

**Phase boundaries were synthesized, not sourced.** The spec's own § 6 "Pipeline"
table (L270–279) names five pipeline stages, and § 19.1 "Suggested Resolutions"
(L895–976) proposes design answers to the open questions — but neither is
labeled by the author as a delivery/milestone plan, and the spec explicitly
states (§ 4, L103–106; Q-007, L859–867) that it never draws a v1/v2 line and
that phasing requires confirmation. The 10 phases below regroup the pipeline
stages, the safety/guardrail requirements, and the § 19.1 resolutions into
independently buildable/testable layers (schema → service shell → policy/core
logic → execution → consumers → lifecycle → hardening).

Every phase inherits the spec's overall stance: nothing in § 19.1 is accepted
until confirmed (spec L897–901). Phase-implementers must treat the § 19.1
resolution referenced in their own spec range as the working default, not as
settled fact, and record any deviation in `contracts.md`.

| Phase | Title | Spec range | Depends on | Rev/Sec/Con/Blast/Infra/Amb | Total | Checkpoint | Status |
|---|---|---|---|---|---|---|---|
| 1 | Tutorial-plan.json schema & interface contract | §6.2.3 L357-373; §6 Rules (plan step semantics) L306-325; REQ-003 L129-137; REQ-011 L191-197; REQ-013 L205-216; §8 Data L489-496; Q-009 (credential-ref) L964-969 | — | 0/1/0/2/0/1 | 4 | yes | done |
| 2 | Orchestration service shell & trigger interface | §6.2.3 (unresolved API surface) L369-373; §6.2.7 L413-427; §8 API L497-499; §13 L623-633; Q-001 L799-808, L902-908; §16 L744-763; §17 L764-780 | 1 | 1/2/1/1/2/2 | 9 | yes | done |
| 3 | Staging / destructive-action safety guardrails | REQ-014 L217-224; REQ-015 L225-236; AC-007 L690-702; EDGE-002 L524-532; §10 Security L590-609; Q-003 L820-829, L917-925; Q-008 (fixture reset) L956-963 | 1 | 2/2/1/1/1/2 | 9 | yes | done |
| 4 | Documentation Agent — WayContext understanding & outline generation | REQ-005 L145-151; REQ-006 L152-159; AC-004 L664-672; EDGE-005 L549-557; Q-002 L809-818, L909-915 | 1 | 0/0/0/0/1/2 | 3 | yes | done |
| 5 | Credential handling & secrets resolution | Q-009 L878-886, L964-969; §10 Security L598-609; §6.2.6 (credential row) L403; REQ-001 L110-116 | 1 | 1/2/0/1/2/1 | 7 | yes | done |
| 6 | Playwright execution runner & recording | REQ-004 L138-144; REQ-007 L160-165; AC-003 L655-663; EDGE-001 L513-523; EDGE-003 L533-540; EDGE-004 L541-548; Q-004 L831-838, L926-935; §6.2.5 L390-397 | 1, 2, 3, 5 | 2/2/1/1/2/2 | 10 | yes | done |
| 7 | Narration script & TTS synthesis | REQ-008 L166-172; REQ-013 (language) L205-216; AC-006 L682-688; EDGE-006 L558-566; EDGE-007 L567-574; Q-005 L840-847, L936-942 | 1, 4 | 0/1/0/0/1/1 | 3 | no | done |
| 8 | Video assembly (FFmpeg mux, effects, masking) | REQ-009 L173-179; REQ-010 L180-190; AC-005 L673-681; EDGE-007 L567-574; Q-009 (masking) L964-969; §10 (video-exposure note) L603-605 | 5, 6, 7 | 0/1/0/0/1/1 | 3 | no | done |
| 9 | Approval lifecycle & publish gate | §6.2.1 L328-346; REQ-016 L237-247; AC-008 L703-710; Q-006 L849-857, L944-948; Q-002 (outline-gate tie-in) L909-915 | 2, 4, 8 | 1/1/0/1/1/2 | 6 | yes | done |
| 10 | Hardening — idempotency, failure taxonomy, observability | §6.2.4 L374-389; §6.2.5 L390-397; §6.2.8 L428-433; §15 L728-743; Q-008 L869-876, L956-963; EDGE-008 L575-581; EDGE-009 L582-589 | 2, 6, 9 | 1/0/2/1/1/2 | 7 | yes | done |

## Notes on scoring

- Phase 1 is flagged solely on Blast radius (2): every other phase consumes
  this schema, so an unreviewed change here ripples through the whole system,
  even though the phase itself is a pure, isolated addition.
- Phase 6 (execution runner) is the highest-risk phase (10/12, four
  dimensions at 2): it is the point where AI-authored plans drive a real
  browser against live staging state, combining reversibility, security
  ("new sandbox" / executes external input), and infra risk.
- Phases 4, 7, 8 score low on most axes because they are additive,
  isolated modules with no shared-state or blast-radius exposure; 4 is
  still checkpointed purely because Q-002 ("what deserves a tutorial") is
  spec-flagged as the hardest, least-settled part of the whole design
  (Spec ambiguity = 2).
- 8 of 10 phases are checkpointed. This tracks the spec's own framing: it
  is Profile: Full, security-relevant (browser automation with
  credentials), and carries 10 unresolved Open Questions (§ 19) whose
  § 19.1 resolutions are explicitly "pending confirmation," not accepted.
