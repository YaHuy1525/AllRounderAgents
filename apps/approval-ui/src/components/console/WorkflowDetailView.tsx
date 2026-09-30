"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState, type CSSProperties } from "react";

import { ApiError } from "@/lib/api";
import { integrationAccent, integrationLabel } from "@/lib/integrations";
import { START_RUN_HINT } from "@/lib/roles";
import { RUNNABLE_WORKFLOWS } from "@/lib/runs";
import { listWorkflows, type WorkflowDefinition } from "@/lib/workflows";

import {
  IconLock,
  IconPlay,
  IconRefresh,
  IconSparkles,
  IconWorkflow,
  ProviderGlyph,
} from "./icons";

// React Flow is client-only (node-env tests render with renderToString), so
// the canvas always arrives through a dynamic import with ssr disabled.
const GraphCanvas = dynamic(() => import("./graph/GraphCanvas"), {
  ssr: false,
  loading: () => (
    <div className="flow-canvas flow-canvas-loading" style={{ height: 340 }} role="status">
      Loading the flow graph…
    </div>
  ),
});

type DetailState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "missing" }
  | { phase: "ready"; definition: WorkflowDefinition };

function detailErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return "Sign in with a role that can view workflows.";
    }
    return `The workflow definition could not be loaded (API ${error.status}).`;
  }
  return "The workflow definition could not be loaded.";
}

/**
 * Single-workflow view: the static flow graph with integration satellites,
 * a node-click step panel, and the step list — the same definitions the run
 * service executes, so graph and stepper can never disagree.
 */
export function WorkflowDetailView({
  workflowId,
  onStartRun,
  canStart = true,
}: {
  workflowId: string;
  onStartRun?: (workflowId: string) => void;
  canStart?: boolean;
}) {
  const [state, setState] = useState<DetailState>({ phase: "loading" });
  const [tick, setTick] = useState(0);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ phase: "loading" });
    listWorkflows().then(
      (workflows) => {
        if (cancelled) return;
        const definition = workflows.find((item) => item.id === workflowId);
        setState(definition ? { phase: "ready", definition } : { phase: "missing" });
      },
      (error: unknown) => {
        if (!cancelled) setState({ phase: "error", message: detailErrorMessage(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [workflowId, tick]);

  // Switching to another workflow tab resets the step selection.
  useEffect(() => setSelectedStepId(null), [workflowId]);

  const definition = state.phase === "ready" ? state.definition : null;
  const copy = useMemo(() => {
    if (definition === null) return null;
    const entry = RUNNABLE_WORKFLOWS.find((item) => item.id === definition.id);
    return {
      label: entry?.label ?? definition.title,
      description: entry?.description ?? "",
    };
  }, [definition]);

  const selected = useMemo(() => {
    if (definition === null || selectedStepId === null) return null;
    const index = definition.steps.findIndex((step) => step.id === selectedStepId);
    const step = index === -1 ? null : definition.steps[index];
    return step === null || step === undefined ? null : { step, index };
  }, [definition, selectedStepId]);

  return (
    <section
      id="workflow-detail-view"
      className="panel-view"
      aria-label="Workflow detail"
    >
      {state.phase === "loading" && (
        <>
          <div className="panel-heading">
            <p className="eyebrow">Workflows</p>
            <h2>{workflowId}</h2>
          </div>
          <div
            className="workflow-detail-grid"
            role="status"
            aria-label="Loading the workflow"
          >
            <div className="skeleton wf-skeleton-graph" aria-hidden="true" />
            <aside className="workflow-step-col" aria-hidden="true">
              {Array.from({ length: 5 }, (_, index) => (
                <div key={index} className="skeleton wf-skeleton-row" />
              ))}
            </aside>
          </div>
        </>
      )}

      {state.phase === "error" && (
        <>
          <div className="panel-heading">
            <p className="eyebrow">Workflows</p>
            <h2>{workflowId}</h2>
          </div>
          <div className="view-hold" role="alert">
            <IconWorkflow />
            <strong>Definition unavailable</strong>
            <p>{state.message}</p>
            <button
              type="button"
              className="wf-secondary"
              onClick={() => setTick((value) => value + 1)}
            >
              <IconRefresh />
              Retry
            </button>
          </div>
        </>
      )}

      {state.phase === "missing" && (
        <>
          <div className="panel-heading">
            <p className="eyebrow">Workflows</p>
            <h2>{workflowId}</h2>
          </div>
          <div className="view-hold" role="alert">
            <IconWorkflow />
            <strong>Unknown workflow</strong>
            <p>{`The catalog does not contain a workflow with id “${workflowId}”.`}</p>
          </div>
        </>
      )}

      {state.phase === "ready" && definition !== null && copy !== null && (
        <>
          <div className="panel-heading workflow-detail-heading">
            <div>
              <p className="eyebrow">{`Workflows · ${definition.mastraWorkflow}`}</p>
              <h2>{copy.label}</h2>
              {copy.description !== "" && <p className="panel-note">{copy.description}</p>}
            </div>
            <div className="workflow-detail-actions">
              <button
                type="button"
                className="wf-cta"
                disabled={!canStart}
                title={canStart ? undefined : START_RUN_HINT}
                onClick={() => onStartRun?.(definition.id)}
              >
                <IconPlay />
                Start run
              </button>
            </div>
          </div>

          {!canStart && (
            <p className="role-hint" role="note">
              <IconLock />
              {START_RUN_HINT}
            </p>
          )}

          <div className="workflow-detail-grid">
            <GraphCanvas
              workflow={definition}
              activeStepId={selectedStepId}
              onStepSelect={setSelectedStepId}
            />

            <aside className="workflow-step-col" aria-label="Steps">
              {selected === null ? (
                <p className="step-empty">
                  Select a step in the graph — or below — to see its target systems.
                </p>
              ) : (
                <article className="workflow-step-panel">
                  <p className="eyebrow">
                    {`Step ${selected.index + 1} of ${definition.steps.length}`}
                  </p>
                  <h3>{selected.step.title}</h3>
                  <p className="workflow-step-effect">
                    {selected.step.sideEffecting ? (
                      <>
                        <IconSparkles />
                        Side-effecting — writes to the systems below and carries an approval
                        receipt.
                      </>
                    ) : (
                      "Computed pass — no external writes."
                    )}
                  </p>
                  {selected.step.integrations.length > 0 && (
                    <ul
                      className="integration-chips"
                      aria-label={`${selected.step.title} integrations`}
                    >
                      {selected.step.integrations.map((provider) => (
                        <li
                          key={provider}
                          className="integration-chip"
                          style={
                            { "--provider-accent": integrationAccent(provider) } as CSSProperties
                          }
                        >
                          <ProviderGlyph provider={provider} />
                          {integrationLabel(provider)}
                        </li>
                      ))}
                    </ul>
                  )}
                </article>
              )}

              <ol className="workflow-step-list">
                {definition.steps.map((step, index) => (
                  <li key={step.id}>
                    <button
                      type="button"
                      className={`workflow-step-row${step.id === selectedStepId ? " active" : ""}`}
                      onClick={() => setSelectedStepId(step.id)}
                    >
                      <span className="workflow-step-index" aria-hidden="true">
                        {index + 1}
                      </span>
                      <span className="workflow-step-title">{step.title}</span>
                      {step.sideEffecting && (
                        <span className="workflow-step-badge" title="Side-effecting step">
                          <IconSparkles />
                        </span>
                      )}
                      {step.integrations.length > 0 && (
                        <span className="workflow-step-providers">
                          {step.integrations.map((provider) => (
                            <span
                              key={provider}
                              className="workflow-step-provider"
                              style={
                                {
                                  "--provider-accent": integrationAccent(provider),
                                } as CSSProperties
                              }
                              title={integrationLabel(provider)}
                            >
                              <ProviderGlyph provider={provider} />
                            </span>
                          ))}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ol>
            </aside>
          </div>
        </>
      )}
    </section>
  );
}
