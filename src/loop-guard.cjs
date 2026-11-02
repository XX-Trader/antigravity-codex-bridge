'use strict';

// Saved jobs are the ledger: restarting a host or changing a proposal cannot reset it.
function executionReport(text, items) {
  const marker = '\n[CODEX_EXECUTION_REPORT]';
  const at = text.lastIndexOf(marker);
  let report;
  try { report = JSON.parse(text.slice(at + marker.length).trim()); } catch { return { outcome: 'no_progress', reason: '缺少可核验的本轮执行报告' }; }
  if (!report || typeof report !== 'object' || Array.isArray(report) ||
      ['evidence_item_ids', 'evidence_commands', 'evidence_outputs'].some(key => report[key] !== undefined && !Array.isArray(report[key]))) {
    return { outcome: 'no_progress', reason: '执行报告结构无效' };
  }
  const ids = Array.isArray(report.evidence_item_ids) ? report.evidence_item_ids : [];
  const commands = Array.isArray(report.evidence_commands) ? report.evidence_commands : [];
  const outputs = Array.isArray(report.evidence_outputs) ? report.evidence_outputs : [];
  const matchesCommand = command => [...items].filter(([, value]) => typeof command === 'string' && command.trim() && command === (value.command ?? value));
  const matchesOutput = output => [...items].filter(([, value]) => typeof output === 'string' && output.trim().length >= 16 && value.output?.includes(output));
  const matched = [...commands.flatMap(c => matchesCommand(c).map(([id]) => id)), ...outputs.flatMap(o => matchesOutput(o).map(([id]) => id))];
  const evidence = [...new Set([...ids, ...matched])];
  if (at < 0 || !['accepted', 'progress', 'failed', 'no_progress'].includes(report.outcome) ||
      !evidence.length || ids.some(id => typeof id !== 'string' || !items.has(id)) || commands.some(c => !matchesCommand(c).length) || outputs.some(o => !matchesOutput(o).length) ||
      typeof report.reason !== 'string' || !report.reason.trim() ||
      !Array.isArray(report.remaining_checks) || report.remaining_checks.some(v => typeof v !== 'string') ||
      (report.outcome === 'accepted' && report.remaining_checks.length)) {
    return { outcome: 'no_progress', reason: '执行报告缺失、证据未对应本轮成功工具记录，或验收仍有缺项' };
  }
  return { outcome: report.outcome, reason: report.reason.slice(0, 4000), evidence_item_ids: evidence, remaining_checks: report.remaining_checks };
}

function loopState(jobs) {
  let failures = 0, noProgress = 0, since = null, last = null;
  for (const job of [...jobs].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.job_id.localeCompare(b.job_id))) {
    if (job.loop_reset?.human_reply_job_id === job.job_id && job.plan_decision && job.request_context?.followups?.some(f => f.job_id === job.job_id && f.text?.trim())) {
      failures = 0; noProgress = 0; since = null; last = null;
    }
    if (job.handoff?.blocker_type === 'human_takeover' && !job.repair_round_failed && !job.execution_report) continue;
    if (job.execution_report?.outcome === 'accepted' && job.execution_report.evidence_item_ids?.length && job.status === 'completed' && job.verification_state === 'accepted_with_evidence') {
      failures = 0; noProgress = 0; since = null; last = null; continue;
    }
    const rejected = ['review_revise', 'review_needs_evidence'].includes(job.handoff?.kind) || ['review_revise', 'review_needs_evidence'].includes(job.status);
    const failed = job.repair_round_failed || rejected || (!job.execution_block && ['failed', 'timed_out'].includes(job.status)) || job.execution_report?.outcome === 'failed';
    if (failed) { failures++; since ||= job.created_at; last = job; }
    // A review pass or an unexecuted plan is never progress. Legacy execution rounds
    // without reports are unknown; new workers explicitly save no_progress.
    if (job.execution_report) {
      noProgress = job.execution_report.outcome === 'no_progress' ? noProgress + 1 : 0;
      if (job.execution_report.outcome === 'no_progress') { since ||= job.created_at; last = job; }
    }
  }
  return { failures, consecutive_no_progress: noProgress, since, trigger: failures >= 3 ? 'failed_rounds' : noProgress >= 2 ? 'no_progress' : null,
    last_job_id: last?.job_id || null, last_reason: last?.execution_report?.reason || last?.plan_review?.reason || last?.handoff?.reason || last?.error || null };
}

function takeover(state) {
  return { kind: 'needs_input', blocker_type: 'human_takeover', requires_user_decision: true,
    reason: `同一未完成事项累计失败 ${state.failures} 轮，连续无可核验进展 ${state.consecutive_no_progress} 轮，已停止自动修订和执行。`,
    known_facts: [`原任务记录累计失败 ${state.failures} 轮，连续无可核验进展 ${state.consecutive_no_progress} 轮`],
    reported_cause: state.last_reason || '现有记录不足以确认失败根因',
    unknowns: ['为何反复失败或没有实质进展？需要补充哪些证据才能确定根因？'],
    diagnostic_questions: ['现在失败的原因是什么？哪些已证实、哪些仍是假设？', '如何解决最合适？建议有什么证据、影响和未完成项？'],
    question: '自动重试已暂停。说明失败原因、证据和解决建议后，请你决定：按建议继续、先补诊断，还是暂停交人工处理？',
    options: ['按已核实原因修改方案后继续，保留原验收条件', '先做只读诊断补齐根因证据', '暂停，交人工处理'],
    recommendation: '先核对最近失败证据，给出最合适的解决方案；不得自动选择。' };
}

module.exports = { executionReport, loopState, takeover };
