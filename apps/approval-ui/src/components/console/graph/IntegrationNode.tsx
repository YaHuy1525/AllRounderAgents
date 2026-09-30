"use client";

import type { CSSProperties } from "react";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

import { integrationAccent, integrationLabel } from "@/lib/integrations";

import { ProviderGlyph } from "../icons";

/** Data carried by an integration satellite; mirrors `GraphIntegrationNode`. */
export type IntegrationNodeData = {
  provider: string;
  stepId: string;
  stepTitle: string;
};

export type IntegrationFlowNode = Node<IntegrationNodeData, "integrationNode">;

export function IntegrationNode({ data }: NodeProps<IntegrationFlowNode>) {
  const label = integrationLabel(data.provider);
  return (
    <div
      className="graph-satellite"
      style={{ "--provider-accent": integrationAccent(data.provider) } as CSSProperties}
      title={`${label} — used by “${data.stepTitle}”`}
      aria-label={`${label} integration`}
    >
      <Handle type="target" position={Position.Top} className="graph-handle" />
      <ProviderGlyph provider={data.provider} />
    </div>
  );
}
