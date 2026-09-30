import { describe, expect, it } from "vitest";

import type { WorkflowStep } from "@/lib/workflows";

import {
  GRAPH_PADDING,
  SATELLITE_GAP,
  SATELLITE_SIZE,
  SATELLITE_TOP_GAP,
  STEP_GAP_X,
  STEP_HEIGHT,
  STEP_WIDTH,
  integrationNodeId,
  stepNodeId,
  stepsToGraph,
  type GraphIntegrationNode,
  type GraphStepNode,
} from "./layout.js";

const STEPS: WorkflowStep[] = [
  { id: "select-pr", title: "Select the PR", sideEffecting: false, integrations: [] },
  { id: "ai-review", title: "Run the AI review", sideEffecting: false, integrations: ["github"] },
  {
    id: "review-options",
    title: "Post the review",
    sideEffecting: true,
    integrations: ["github", "slack"],
  },
];

function stepNodes(nodes: ReturnType<typeof stepsToGraph>["nodes"]): GraphStepNode[] {
  return nodes.filter((node): node is GraphStepNode => node.kind === "step");
}

function integrationNodes(
  nodes: ReturnType<typeof stepsToGraph>["nodes"],
): GraphIntegrationNode[] {
  return nodes.filter((node): node is GraphIntegrationNode => node.kind === "integration");
}

describe("stepsToGraph", () => {
  it("chains steps left-to-right in definition order", () => {
    const graph = stepsToGraph(STEPS);
    const steps = stepNodes(graph.nodes);
    expect(steps.map((node) => node.id)).toEqual([
      stepNodeId("select-pr"),
      stepNodeId("ai-review"),
      stepNodeId("review-options"),
    ]);
    expect(steps.map((node) => node.x)).toEqual([
      GRAPH_PADDING,
      GRAPH_PADDING + STEP_WIDTH + STEP_GAP_X,
      GRAPH_PADDING + 2 * (STEP_WIDTH + STEP_GAP_X),
    ]);
    for (const step of steps) expect(step.y).toBe(GRAPH_PADDING);
    const flow = graph.edges.filter((edge) => edge.kind === "flow");
    expect(flow.map((edge) => [edge.source, edge.target])).toEqual([
      [stepNodeId("select-pr"), stepNodeId("ai-review")],
      [stepNodeId("ai-review"), stepNodeId("review-options")],
    ]);
  });

  it("centers satellites under their step with one satellite edge each", () => {
    const graph = stepsToGraph(STEPS);
    const satellites = integrationNodes(graph.nodes);
    expect(satellites.map((node) => node.id)).toEqual([
      integrationNodeId("ai-review", "github"),
      integrationNodeId("review-options", "github"),
      integrationNodeId("review-options", "slack"),
    ]);
    const pair = satellites.filter((node) => node.stepId === "review-options");
    expect(pair[1]!.x - pair[0]!.x).toBe(SATELLITE_SIZE + SATELLITE_GAP);
    const stepX = GRAPH_PADDING + 2 * (STEP_WIDTH + STEP_GAP_X);
    const pairCenter = (pair[0]!.x + pair[1]!.x + SATELLITE_SIZE) / 2;
    expect(pairCenter).toBe(stepX + STEP_WIDTH / 2);
    for (const satellite of satellites) {
      expect(satellite.y).toBe(GRAPH_PADDING + STEP_HEIGHT + SATELLITE_TOP_GAP);
    }
    const satelliteEdges = graph.edges.filter((edge) => edge.kind === "satellite");
    expect(satelliteEdges).toHaveLength(3);
    expect(satelliteEdges[0]).toEqual({
      id: "satellite:ai-review:github",
      source: stepNodeId("ai-review"),
      target: integrationNodeId("ai-review", "github"),
      kind: "satellite",
    });
  });

  it("applies the run overlay and defaults unknown steps to future", () => {
    const graph = stepsToGraph(STEPS, {
      states: { "ai-review": "current", "review-options": "awaiting" },
    });
    const states = new Map(stepNodes(graph.nodes).map((node) => [node.stepId, node.state]));
    expect(states.get("select-pr")).toBe("future");
    expect(states.get("ai-review")).toBe("current");
    expect(states.get("review-options")).toBe("awaiting");
  });

  it("is deterministic and computes the bounding box from the constants", () => {
    const first = stepsToGraph(STEPS);
    expect(stepsToGraph(STEPS)).toEqual(first);
    expect(first.width).toBe(GRAPH_PADDING * 2 + 3 * STEP_WIDTH + 2 * STEP_GAP_X);
    expect(first.height).toBe(
      GRAPH_PADDING * 2 + STEP_HEIGHT + SATELLITE_TOP_GAP + SATELLITE_SIZE,
    );
    const noSatellites = stepsToGraph([STEPS[0]!]);
    expect(noSatellites.height).toBe(GRAPH_PADDING * 2 + STEP_HEIGHT);
    expect(noSatellites.edges).toEqual([]);
  });
});
