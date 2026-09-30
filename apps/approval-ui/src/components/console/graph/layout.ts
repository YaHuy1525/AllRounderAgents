import type { RunVisualState } from "@/lib/runs";
import type { WorkflowStep } from "@/lib/workflows";

/**
 * Pure, deterministic workflow-graph layout: steps chain left-to-right in
 * definition order, each step's integration satellites sit directly below it.
 *
 * No React Flow import here — the canvas adapts these plain objects to
 * `@xyflow/react` nodes, which keeps this module unit-testable in the node
 * environment and the geometry stable across renders.
 */

export const STEP_WIDTH = 224;
export const STEP_HEIGHT = 68;
export const STEP_GAP_X = 56;
export const SATELLITE_SIZE = 34;
export const SATELLITE_GAP = 10;
export const SATELLITE_TOP_GAP = 56;

export const GRAPH_PADDING = 24;

export type GraphStepNode = {
  id: string;
  kind: "step";
  stepId: string;
  title: string;
  index: number;
  sideEffecting: boolean;
  integrations: string[];
  state: RunVisualState;
  x: number;
  y: number;
};

export type GraphIntegrationNode = {
  id: string;
  kind: "integration";
  provider: string;
  stepId: string;
  x: number;
  y: number;
};

export type GraphNode = GraphStepNode | GraphIntegrationNode;

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  /** `flow` chains steps; `satellite` links a step to one of its providers. */
  kind: "flow" | "satellite";
};

export type WorkflowGraph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
};

export function stepNodeId(stepId: string): string {
  return `step:${stepId}`;
}

export function integrationNodeId(stepId: string, provider: string): string {
  return `integration:${stepId}:${provider}`;
}

export type StepsToGraphOptions = {
  /** Run overlay: step id → visual state (absent steps stay `future`). */
  states?: Readonly<Record<string, RunVisualState>>;
};

export function stepsToGraph(
  steps: readonly WorkflowStep[],
  options: StepsToGraphOptions = {},
): WorkflowGraph {
  const states = options.states ?? {};
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  steps.forEach((step, index) => {
    const x = GRAPH_PADDING + index * (STEP_WIDTH + STEP_GAP_X);
    const y = GRAPH_PADDING;
    nodes.push({
      id: stepNodeId(step.id),
      kind: "step",
      stepId: step.id,
      title: step.title,
      index,
      sideEffecting: step.sideEffecting,
      integrations: [...step.integrations],
      state: states[step.id] ?? "future",
      x,
      y,
    });
    if (index > 0) {
      const previous = steps[index - 1];
      if (previous) {
        edges.push({
          id: `flow:${previous.id}->${step.id}`,
          source: stepNodeId(previous.id),
          target: stepNodeId(step.id),
          kind: "flow",
        });
      }
    }
    const satellites = step.integrations;
    if (satellites.length > 0) {
      const totalWidth = satellites.length * SATELLITE_SIZE + (satellites.length - 1) * SATELLITE_GAP;
      const startX = x + (STEP_WIDTH - totalWidth) / 2;
      const satelliteY = y + STEP_HEIGHT + SATELLITE_TOP_GAP;
      satellites.forEach((provider, satelliteIndex) => {
        nodes.push({
          id: integrationNodeId(step.id, provider),
          kind: "integration",
          provider,
          stepId: step.id,
          x: startX + satelliteIndex * (SATELLITE_SIZE + SATELLITE_GAP),
          y: satelliteY,
        });
        edges.push({
          id: `satellite:${step.id}:${provider}`,
          source: stepNodeId(step.id),
          target: integrationNodeId(step.id, provider),
          kind: "satellite",
        });
      });
    }
  });

  const width = GRAPH_PADDING * 2 + steps.length * STEP_WIDTH + Math.max(0, steps.length - 1) * STEP_GAP_X;
  const hasSatellites = steps.some((step) => step.integrations.length > 0);
  const height =
    GRAPH_PADDING * 2 +
    STEP_HEIGHT +
    (hasSatellites ? SATELLITE_TOP_GAP + SATELLITE_SIZE : 0);

  return { nodes, edges, width, height };
}
