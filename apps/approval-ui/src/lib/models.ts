export type Approval = {
  id: string;
  caseId: string;
  action: Record<string, unknown>;
  evidence: Array<{ sourceId: string; span: string }>;
  approver: string;
  scope: string;
  expiresAt: string;
  decision: "approved" | "rejected" | "expired" | null;
  comment: string | null;
  decidedAt: string | null;
  /** Declared risk band 0-100 (anchors 10/55/90); null means no declared band. */
  risk: number | null;
};

export type SessionInfo = {
  email: string;
  tenantId: string;
  roles: string[];
  expiresAt: string | null;
};

export type JiraBoardOption = {
  id: number;
  name: string;
  type: string;
  project: string;
};

export type Workspace = {
  site: string;
  projects: string[];
  boards: JiraBoardOption[];
};
