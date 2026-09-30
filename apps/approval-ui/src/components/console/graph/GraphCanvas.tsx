"use client";

import "@xyflow/react/dist/style.css";

import { useCallback, useEffect, useMemo } from "react";

import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from "@xyflow/react";

import type { RunVisualState } from "@/lib/runs";
import type { WorkflowDefinition } from "@/lib/workflows";

import { IntegrationNode, type IntegrationFlowNode } from "./IntegrationNode";
import { StepNode, type StepFlowNode } from "./StepNode";
import { SATELLITE_SIZE, STEP_HEIGHT, STEP_WIDTH, stepsToGraph } from "./layout";

const NODE_TYPES = { stepNode: StepNode, integrationNode: IntegrationNode };
const FIT_VIEW_OPTIONS = { padding: 0.16, maxZoom: 1.05 };
const PRO_OPTIONS = { hideAttribution: true };
const STEP_PREFIX = "step:";

function stepIdFromNodeId(nodeId: string): string {
  return nodeId.startsWith(STEP_PREFIX) ? nodeId.slice(STEP_PREFIX.length) : nodeId;
}

export type GraphCanvasProps = {
  workflow: Pick<WorkflowDefinition, "id" | "steps">;
  /** Run overlay: step id → visual state (absent steps stay `future`). */
  states?: Readonly<Record<string, RunVisualState>>;
  /** Run overlay: step id → true when the run recorded a side effect for it. */
  effects?: Readonly<Record<string, boolean>>;
  /** Step id to mark as the live/selected node. */
  activeStepId?: string | null;
  /** Animate the flow edges — used while a run is executing. */
  animated?: boolean;
  /** Node click callback (step nodes only). */
  onStepSelect?: (stepId: string) => void;
  height?: number;
};

/**
 * Client-only React Flow canvas (always mounted through `next/dynamic` with
 * `ssr: false`): deterministic layout from `stepsToGraph`, node components
 * reusing the console's run-state tokens, satellite nodes for integrations.
 */
export default function GraphCanvas({
  workflow,
  states,
  effects,
  activeStepId,
  animated = false,
  onStepSelect,
  height = 340,
}: GraphCanvasProps) {
  const graph = useMemo(
    () => stepsToGraph(workflow.steps, { states }),
    [workflow.steps, states],
  );

  const stepTitles = useMemo(() => {
    const map = new Map<string, string>();
    for (const step of workflow.steps) map.set(step.id, step.title);
    return map;
  }, [workflow.steps]);

  const computedNodes = useMemo<Node[]>(
    () =>
      graph.nodes.map((node): Node => {
        if (node.kind === "step") {
          const data: StepFlowNode["data"] = {
            stepId: node.stepId,
            title: node.title,
            index: node.index,
            sideEffecting: node.sideEffecting,
            integrations: node.integrations,
            state: node.state,
            active: node.stepId === activeStepId,
            effect: effects?.[node.stepId] === true,
          };
          return {
            id: node.id,
            type: "stepNode",
            position: { x: node.x, y: node.y },
            data,
            width: STEP_WIDTH,
            height: STEP_HEIGHT,
            draggable: false,
            connectable: false,
          };
        }
        const data: IntegrationFlowNode["data"] = {
          provider: node.provider,
          stepId: node.stepId,
          stepTitle: stepTitles.get(node.stepId) ?? node.stepId,
        };
        return {
          id: node.id,
          type: "integrationNode",
          position: { x: node.x, y: node.y },
          data,
          width: SATELLITE_SIZE,
          height: SATELLITE_SIZE,
          draggable: false,
          connectable: false,
          selectable: false,
        };
      }),
    [graph.nodes, activeStepId, stepTitles, effects],
  );

  const computedEdges = useMemo<Edge[]>(
    () =>
      graph.edges.map((edge): Edge => {
        if (edge.kind === "satellite") {
          return {
            id: edge.id,
            source: edge.source,
            target: edge.target,
            sourceHandle: "satellite",
            type: "straight",
            className: "graph-edge graph-edge-satellite",
          };
        }
        const executed = states?.[stepIdFromNodeId(edge.source)] === "done";
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: "main",
          type: "smoothstep",
          animated,
          className: `graph-edge graph-edge-flow${executed ? " is-executed" : ""}`,
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
        };
      }),
    [graph.edges, animated, states],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(computedNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(computedEdges);

  // Prop-driven updates flow into the interactive store (selection and other
  // interaction changes are handled by the store itself).
  useEffect(() => setNodes(computedNodes), [computedNodes, setNodes]);
  useEffect(() => setEdges(computedEdges), [computedEdges, setEdges]);

  const handleNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      if (node.type !== "stepNode") return;
      const data = node.data as StepFlowNode["data"];
      onStepSelect?.(data.stepId);
    },
    [onStepSelect],
  );

  return (
    <div className="flow-canvas" style={{ height }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={NODE_TYPES}
        onNodeClick={handleNodeClick}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        proOptions={PRO_OPTIONS}
        fitView
        fitViewOptions={FIT_VIEW_OPTIONS}
        minZoom={0.3}
        maxZoom={1.5}
        zoomOnScroll={false}
        zoomOnDoubleClick={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} className="graph-bg" />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
    </div>
  );
}
