"use client"

import { useTransition } from "react"
import { Plus, RefreshCw } from "lucide-react"

import { cn } from "cn"
import { Button } from "@/components/ui/button"
import {
  addRuleFromTemplateAction,
  runRulesNowAction,
  setRuleEnabledAction,
} from "@/features/automation/actions"
import { explainSkip, OPERATOR_LABELS } from "@/services/automation/contracts"
import { getCanonicalMetric } from "@/services/metrics/canonical"
import type { AutomationRule, AutomationRun } from "@/types/database"

/**
 * The rules, and what each one has been doing.
 *
 * THE RUN HISTORY IS THE POINT OF THIS PANEL.
 *
 * A list of rules tells an owner what they asked for. The last few checks tell
 * them whether it is actually working — and when a rule stayed quiet, which of
 * the honest reasons applied: the period had nothing to measure, the cost data
 * was too incomplete to judge, or it had already alerted recently.
 *
 * Without that, silence is ambiguous, and ambiguous silence is why people stop
 * trusting alerts.
 */

type TemplateOption = {
  id: string
  name: string
  concern: string
  rationale: string
  alreadyAdded: boolean
}

export function RulePanel({
  rules,
  runsByRule,
  templates,
  canEdit,
}: {
  rules: AutomationRule[]
  runsByRule: Record<string, AutomationRun[]>
  templates: TemplateOption[]
  canEdit: boolean
}) {
  const [pending, startTransition] = useTransition()

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-heading text-lg font-semibold">Your rules</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Each one is checked on its own schedule. Nothing happens
            automatically beyond raising an alert.
          </p>
        </div>

        {canEdit && rules.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            className="rounded-4xl"
            disabled={pending}
            onClick={() => startTransition(async () => void (await runRulesNowAction()))}
          >
            <RefreshCw className={cn("size-4", pending && "animate-spin")} aria-hidden />
            {pending ? "Checking…" : "Check now"}
          </Button>
        )}
      </div>

      {rules.length > 0 && (
        <ul className="mt-4 space-y-3">
          {rules.map((rule) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              runs={runsByRule[rule.id] ?? []}
              canEdit={canEdit}
            />
          ))}
        </ul>
      )}

      {/* Starter rules. Only ones not already added are offered. */}
      {canEdit && templates.some((template) => !template.alreadyAdded) && (
        <div className="mt-8">
          <h3 className="text-sm font-semibold">
            {rules.length === 0 ? "Start with one of these" : "Add another"}
          </h3>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Each threshold below is a sensible opening guess, not a
            recommendation for your business. Add one, then change the number to
            whatever would actually worry you.
          </p>

          <ul className="mt-4 grid gap-3 sm:grid-cols-2">
            {templates
              .filter((template) => !template.alreadyAdded)
              .map((template) => (
                <li
                  key={template.id}
                  className="flex flex-col rounded-xl border border-border bg-card p-5"
                >
                  <p className="text-sm font-medium">{template.name}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    “{template.concern}”
                  </p>
                  <p className="mt-2 flex-1 text-xs text-muted-foreground">
                    {template.rationale}
                  </p>

                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-4 self-start rounded-4xl"
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        await addRuleFromTemplateAction({ templateId: template.id })
                      })
                    }
                  >
                    <Plus className="size-4" aria-hidden />
                    Add this rule
                  </Button>
                </li>
              ))}
          </ul>
        </div>
      )}

      {!canEdit && (
        <p className="mt-4 text-sm text-muted-foreground">
          Only an owner or admin can add or change rules.
        </p>
      )}
    </div>
  )
}

function RuleRow({
  rule,
  runs,
  canEdit,
}: {
  rule: AutomationRule
  runs: AutomationRun[]
  canEdit: boolean
}) {
  const [pending, startTransition] = useTransition()

  const metric = getCanonicalMetric(rule.metric)
  const last = runs[0]

  return (
    <li className="rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={cn("font-medium", !rule.enabled && "text-muted-foreground")}>
            {rule.name}
          </p>

          {/* The rule in words, built from the stored values. */}
          <p className="mt-1 text-sm text-muted-foreground">
            Tell me when{" "}
            <span className="font-medium text-foreground">
              {metric?.label ?? rule.metric}
            </span>{" "}
            {OPERATOR_LABELS[rule.operator].toLowerCase()}{" "}
            <span className="font-mono tabular-nums text-foreground">
              {rule.threshold}
            </span>
            , measured over {rule.period_days} days.
          </p>
        </div>

        {canEdit && (
          <Button
            size="sm"
            variant="ghost"
            className="rounded-4xl"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                await setRuleEnabledAction({ id: rule.id, enabled: !rule.enabled })
              })
            }
          >
            {rule.enabled ? "Turn off" : "Turn on"}
          </Button>
        )}
      </div>

      {/* Last check, and why it did or did not raise anything. */}
      <div className="mt-4 border-t border-border pt-3 text-xs">
        {!rule.enabled ? (
          <p className="text-muted-foreground">
            This rule is switched off, so it is not being checked.
          </p>
        ) : last === undefined ? (
          <p className="text-muted-foreground">
            Not checked yet. It runs within the next{" "}
            {rule.evaluate_every_minutes < 60
              ? `${rule.evaluate_every_minutes} minutes`
              : `${Math.round(rule.evaluate_every_minutes / 60)} hours`}
            .
          </p>
        ) : (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-muted-foreground">
              Last checked{" "}
              {new Date(last.evaluated_at).toLocaleString(undefined, {
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              })}
              :
            </span>

            {last.status === "FIRED" && (
              <span className="font-medium text-warning-strong">
                raised an alert — {rule.metric} was {last.metric_value}
              </span>
            )}

            {last.status === "NOT_MATCHED" && (
              <span className="text-success-strong">
                all clear — {last.metric_value} is within your limit
              </span>
            )}

            {last.status === "SKIPPED" && (
              <span className="text-muted-foreground">
                stayed quiet. {explainSkip(last.skipped_reason)}
              </span>
            )}

            {last.status === "FAILED" && (
              <span className="text-danger-strong">
                could not be checked. This has been logged.
              </span>
            )}
          </div>
        )}
      </div>
    </li>
  )
}
