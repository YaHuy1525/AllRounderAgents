"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

import type { RunVisualState } from "@/lib/runs";

import { IconSparkles } from "../icons";

/** Data carried by a step node; mirrors `GraphStepNode` from `layout.ts`. */
export type StepNodeData = {
  stepId: string;
  title: string;
  index: number;
  sideEffecting: boolean;
  integrations: string[];
  state: RunVisualState;
  active: boolean;
  /** True when the run recorded a side effect for this step. */
  effect?: boolean;
};

export type StepFlowNode = Node<StepNodeData, "stepNode">;

const STATE_COPY: Record<RunVisualState, string> = {
  done: "Done",
  current: "Running",
  awaiting: "Awaiting review",
  blocked: "Blocked",
  future: "Queued",
};

export function StepNode({ data, selected }: NodeProps<StepFlowNode>) {
  const systems = data.integrations.length;
  return (
    <div
      className={`graph-step state-${data.state}${data.active ? " active" : ""}${
        selected ? " selected" : ""
      }`}
    >
      <Handle type="target" position={Position.Left} className="graph-handle" />
      <Handle type="source" id="main" position={Position.Right} className="graph-handle" />
      <Handle type="source" id="satellite" position={Position.Bottom} className="graph-handle" />
      <header className="graph-step-head">
        <span className="graph-step-index" aria-hidden="true">
          {data.index + 1}
        </span>
        <span className="graph-step-state">
          <span className="graph-step-dot" aria-hidden="true" />
          {STATE_COPY[data.state]}
        </span>
      </header>
      <p className="graph-step-title" title={data.title}>
        {data.title}
      </p>
      <footer className="graph-step-meta">
        {data.sideEffecting ? (
          <span
            className={`graph-step-badge${data.effect === true ? " effect-done" : ""}`}
            title={
              data.effect === true
                ? "Side effect recorded for this step"
                : "Writes to a target system"
            }
          >
            <IconSparkles />
            {data.effect === true ? "Effect recorded" : "Side effect"}
          </span>
        ) : (
          <span className="graph-step-soft">Read-only pass</span>
        )}
        {systems > 0 && (
          <span className="graph-step-soft">{`${systems} system${systems === 1 ? "" : "s"}`}</span>
        )}
      </footer>
    </div>
  );
}
