"use client";

import { useEffect, useState, type CSSProperties } from "react";

import { ApiError } from "@/lib/api";
import { integrationAccent, integrationLabel, workflowIntegrations } from "@/lib/integrations";
import { RUNNABLE_WORKFLOWS } from "@/lib/runs";
import { START_RUN_HINT } from "@/lib/roles";
import { listWorkflows, type WorkflowDefinition } from "@/lib/workflows";

import { IconArrowRight, IconLock, IconPlay, IconRefresh, IconWorkflow, ProviderGlyph } from "./icons";

const SKELETON_TILES = 6;

type CatalogState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; workflows: WorkflowDefinition[] };

function catalogErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return "Sign in with a role that can view workflows.";
    }
    return `The workflow catalog could not be loaded (API ${error.status}).`;
  }
  return "The workflow catalog could not be loaded.";
}

/** Console copy (label + description) for a workflow id, when present. */
function workflowCopy(id: string, fallbackTitle: string): { label: string; description: string } {
  const entry = RUNNABLE_WORKFLOWS.find((item) => item.id === id);
  return { label: entry?.label ?? fallbackTitle, description: entry?.description ?? "" };
}

/**
 * Catalog of every runnable workflow: step counts, the systems each workflow
 * touches, and the two actions the console offers — open the flow graph or
 * start a run (which opens the new-tab start flow with this workflow
 * preselected).
 */
export function WorkflowCatalogView({
  onOpenWorkflow,
  onStartRun,
  canStart = true,
}: {
  onOpenWorkflow?: (workflow: { id: string; title: string }) => void;
  onStartRun?: (workflowId: string) => void;
  /** Role gate for the Start run CTA (agent/admin); disabled when false. */
  canStart?: boolean;
}) {
  const [state, setState] = useState<CatalogState>({ phase: "loading" });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ phase: "loading" });
    listWorkflows().then(
      (workflows) => {
        if (!cancelled) setState({ phase: "ready", workflows });
      },
      (error: unknown) => {
        if (!cancelled) setState({ phase: "error", message: catalogErrorMessage(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return (
    <section id="workflows-view" className="panel-view" aria-label="Workflow catalog">
      <div className="panel-heading">
        <p className="eyebrow">Workflows</p>
        <h2>Workflow catalog</h2>
        <p className="panel-note">
          Every runnable workflow with its step count, the systems it talks to, and a link into
          the full flow graph.
        </p>
      </div>

      {!canStart && (
        <p className="role-hint" role="note">
          <IconLock />
          {START_RUN_HINT}
        </p>
      )}

      {state.phase === "loading" && (
        <div className="workflow-grid" role="status" aria-label="Loading workflows">
          {Array.from({ length: SKELETON_TILES }, (_, index) => (
            <div key={index} className="skeleton wf-skeleton-card" aria-hidden="true" />
          ))}
        </div>
      )}

      {state.phase === "error" && (
        <div className="view-hold" role="alert">
          <IconWorkflow />
          <strong>Catalog unavailable</strong>
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
      )}

      {state.phase === "ready" && (
        <div className="workflow-grid">
          {state.workflows.map((definition) => {
            const { label, description } = workflowCopy(definition.id, definition.title);
            const providers = workflowIntegrations(definition.steps);
            const sideEffecting = definition.steps.filter((step) => step.sideEffecting).length;
            return (
              <article key={definition.id} className="workflow-tile">
                <header className="workflow-tile-head">
                  <span className="workflow-tile-mark" aria-hidden="true">
                    <IconWorkflow />
                  </span>
                  <div className="workflow-tile-copy">
                    <h3>{label}</h3>
                    <p className="workflow-tile-id">{definition.mastraWorkflow}</p>
                  </div>
                </header>
                {description !== "" && <p className="workflow-tile-desc">{description}</p>}
                <p className="workflow-tile-meta">
                  {`${definition.steps.length} steps · ${sideEffecting} side-effecting`}
                </p>
                {providers.length > 0 ? (
                  <ul className="integration-chips" aria-label={`${label} integrations`}>
                    {providers.map((provider) => (
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
                ) : (
                  <p className="workflow-tile-meta">No external systems</p>
                )}
                <div className="workflow-tile-actions">
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
                  <button
                    type="button"
                    className="wf-secondary"
                    onClick={() => onOpenWorkflow?.({ id: definition.id, title: label })}
                  >
                    View graph
                    <IconArrowRight />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
