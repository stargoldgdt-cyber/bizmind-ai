/**
 * The automation engine.
 *
 * V1 raises alerts and nothing else. There is no executor, no outbound action,
 * and no path by which a model can cause one -- every rule is a threshold an
 * owner wrote, compared in SQL, recorded whether it fired or not.
 *
 * See AUTOMATION.md for why each of those is a constraint rather than an
 * unfinished feature.
 */

export {
  AUTOMATION_OPERATORS,
  OPERATOR_LABELS,
  COMPARABLE_ANALYTICS_KEYS,
  SKIP_REASON_EXPLANATIONS,
  canWatch,
  createRuleSchema,
  explainSkip,
  isChangeOperator,
  updateRuleSchema,
  watchableMetrics,
  type CreateRuleInput,
  type UpdateRuleInput,
} from "./contracts"

export { RULE_TEMPLATES, getRuleTemplate, type RuleTemplate } from "./templates"

export {
  createRule,
  createRuleFromTemplate,
  deleteRule,
  evaluateBusinessNow,
  evaluateRuleNow,
  getRule,
  listRuleRuns,
  listRules,
  setRuleEnabled,
  updateRule,
  type RuleResult,
} from "./rules"

export {
  acknowledgeAlert,
  countOpenAlerts,
  listAlerts,
  presentAlert,
  type AlertFilter,
  type PresentedAlert,
} from "./alerts"

export { runAutomationWorker, type AutomationWorkerResult } from "./worker"
