type IconProps = { className?: string };

const BASE = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
  focusable: false,
} as const;

export function IconGrid({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </svg>
  );
}

export function IconBoard({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <rect x="4" y="4" width="4.5" height="16" rx="1.2" />
      <rect x="9.75" y="4" width="4.5" height="10" rx="1.2" />
      <rect x="15.5" y="4" width="4.5" height="13" rx="1.2" />
    </svg>
  );
}

export function IconApprovals({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <path d="M12 3l7 3v5.2c0 4.4-2.9 7.5-7 9.3-4.1-1.8-7-4.9-7-9.3V6l7-3z" />
      <path d="M9 11.8l2.1 2.2 4-4.2" />
    </svg>
  );
}

export function IconChat({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <path d="M4.5 5.5h15a1.5 1.5 0 011.5 1.5v8a1.5 1.5 0 01-1.5 1.5H9.5L4 20.5V7a1.5 1.5 0 011.5-1.5z" />
      <path d="M8 10h8M8 13h5" />
    </svg>
  );
}

export function IconDocs({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <path d="M12 6.2C10 4.8 7.2 4.2 4 4.2v14c3.2 0 6 .6 8 2 2-1.4 4.8-2 8-2v-14c-3.2 0-6 .6-8 2z" />
      <path d="M12 6.2v14" />
    </svg>
  );
}

export function IconSettings({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 00.34 1.87l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.7 1.7 0 00-1.87-.34 1.7 1.7 0 00-1.03 1.56V21a2 2 0 11-4 0v-.09a1.7 1.7 0 00-1.11-1.56 1.7 1.7 0 00-1.87.34l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.7 1.7 0 00.34-1.87 1.7 1.7 0 00-1.56-1.03H3a2 2 0 110-4h.09a1.7 1.7 0 001.56-1.11 1.7 1.7 0 00-.34-1.87l-.06-.06a2 2 0 112.83-2.83l.06.06a1.7 1.7 0 001.87.34h.08a1.7 1.7 0 001.03-1.56V3a2 2 0 114 0v.09a1.7 1.7 0 001.03 1.56h.08a1.7 1.7 0 001.87-.34l.06-.06a2 2 0 112.83 2.83l-.06.06a1.7 1.7 0 00-.34 1.87v.08a1.7 1.7 0 001.56 1.03H21a2 2 0 110 4h-.09a1.7 1.7 0 00-1.56 1.03z" />
    </svg>
  );
}

export function IconAccount({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <circle cx="12" cy="8.5" r="3.8" />
      <path d="M4.5 20c.6-3.3 3.8-5.5 7.5-5.5s6.9 2.2 7.5 5.5" />
    </svg>
  );
}

export function IconClock({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

export function IconPlus({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function IconClose({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
    </svg>
  );
}

export function IconRefresh({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <path d="M20.5 12a8.5 8.5 0 11-2.6-6.1" />
      <path d="M20.5 4.5V10H15" />
    </svg>
  );
}

export function IconCode({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <path d="M9 8l-4 4 4 4M15 8l4 4-4 4" />
    </svg>
  );
}

export function IconPlay({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <path d="M8.5 5.8v12.4l10.2-6.2z" />
    </svg>
  );
}

export function IconStop({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
    </svg>
  );
}

export function IconCheck({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <path d="M5 12.6l4.4 4.4L19 7.4" />
    </svg>
  );
}

export function IconCheckCircle({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.4 12.3l2.4 2.4 4.8-5" />
    </svg>
  );
}

export function IconXCircle({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6" />
    </svg>
  );
}

export function IconAlert({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <path d="M12 4.2 21 19.8H3z" />
      <path d="M12 10v4.4M12 17.1v.1" />
    </svg>
  );
}

export function IconInfo({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11.2v4.8M12 7.7v.1" />
    </svg>
  );
}

export function IconLock({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <rect x="5.5" y="10.5" width="13" height="9" rx="2" />
      <path d="M8.5 10.5V8a3.5 3.5 0 017 0v2.5" />
    </svg>
  );
}

export function IconShield({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <path d="M12 3l7 3v5.2c0 4.4-2.9 7.5-7 9.3-4.1-1.8-7-4.9-7-9.3V6l7-3z" />
    </svg>
  );
}

export function IconSparkles({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <path d="M10.5 4.5l1.5 4 4 1.5-4 1.5-1.5 4-1.5-4-4-1.5 4-1.5z" />
      <path d="M18 13.8l.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8z" />
    </svg>
  );
}

export function IconSend({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <path d="M20.5 3.8 3.8 10.6l6.4 2.6 2.6 6.4z" />
      <path d="M10.2 13.2l10.3-9.4" />
    </svg>
  );
}

export function IconSearch({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <circle cx="11" cy="11" r="6.3" />
      <path d="M15.7 15.7l4.8 4.8" />
    </svg>
  );
}

export function IconFileText({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <path d="M6.5 3.5h7l5 5v12h-12z" />
      <path d="M13.5 3.5V8.5h5" />
      <path d="M9.5 13h5M9.5 16h5" />
    </svg>
  );
}

export function IconList({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <path d="M9 6.5h11M9 12h11M9 17.5h11" />
      <path d="M4.5 6.5h.1M4.5 12h.1M4.5 17.5h.1" />
    </svg>
  );
}

export function IconGitBranch({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <circle cx="6.5" cy="6" r="2.2" />
      <circle cx="6.5" cy="18" r="2.2" />
      <circle cx="17.5" cy="9" r="2.2" />
      <path d="M6.5 8.2v7.6" />
      <path d="M17.5 11.2c0 3.1-3 4.4-5.4 4.9" />
    </svg>
  );
}

export function IconGitPullRequest({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <circle cx="6.5" cy="6" r="2.2" />
      <circle cx="6.5" cy="18" r="2.2" />
      <circle cx="17.5" cy="18" r="2.2" />
      <path d="M6.5 8.2v7.6" />
      <path d="M17.5 15.8v-4.3c0-2.1-1.4-3.5-3.5-3.5H9.8" />
      <path d="M11.9 6 9.7 8l2.2 2" />
    </svg>
  );
}

export function IconExternalLink({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <path d="M13.5 5.5h5v5" />
      <path d="M18.3 5.7 11.5 12.5" />
      <path d="M18.5 14v4.5a1.5 1.5 0 01-1.5 1.5H6a1.5 1.5 0 01-1.5-1.5V7.5A1.5 1.5 0 016 6h4.5" />
    </svg>
  );
}

export function IconChevronDown({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <path d="M7 10l5 5 5-5" />
    </svg>
  );
}

export function IconChevronRight({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <path d="M10 7l5 5-5 5" />
    </svg>
  );
}

export function IconCopy({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <rect x="9.5" y="9.5" width="10" height="10" rx="2" />
      <path d="M15.5 5.5V5a2 2 0 00-2-2H5.5a2 2 0 00-2 2V12a2 2 0 002 2h.5" />
    </svg>
  );
}

export function IconTerminal({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <path d="M8 9.8l2.8 2.2L8 14.2M12.8 14.5h3.4" />
    </svg>
  );
}

export function IconActivity({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <path d="M3.5 12h4l2.4-6 4.2 12 2.4-6h4" />
    </svg>
  );
}

export function IconWorkflow({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <rect x="3.5" y="4" width="6" height="5" rx="1.5" />
      <rect x="14.5" y="4" width="6" height="5" rx="1.5" />
      <rect x="9" y="15" width="6" height="5" rx="1.5" />
      <path d="M6.5 9v3.4c0 .9.7 1.6 1.6 1.6h7.8c.9 0 1.6-.7 1.6-1.6V9" />
    </svg>
  );
}

export function IconGauge({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <path d="M4.5 18.5a8.6 8.6 0 1 1 15 0" />
      <path d="M12 15 15.4 10.4" />
      <circle cx="12" cy="15.2" r="1.2" />
    </svg>
  );
}

export function IconBot({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <rect x="4.5" y="8" width="15" height="10.5" rx="2.5" />
      <path d="M12 4.6V8" />
      <circle cx="12" cy="4" r=".9" />
      <path d="M9.2 12.3v.1M14.8 12.3v.1" />
    </svg>
  );
}

export function IconInbox({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <path d="M4.3 13.2 6.8 5.5h10.4l2.5 7.7V17a2 2 0 01-2 2H6.3a2 2 0 01-2-2z" />
      <path d="M4.3 13.2h4.4l1.3 2.3h4l1.3-2.3h4.4" />
    </svg>
  );
}

export function IconFilter({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <path d="M4.5 5.5h15l-5.9 6.6v5.4l-3.2-1.7v-3.7z" />
    </svg>
  );
}

export function IconArrowRight({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <path d="M4.5 12h15" />
      <path d="M14.5 7l5 5-5 5" />
    </svg>
  );
}

/**
 * Integration provider glyphs, keyed by the registry id in
 * `lib/integrations.ts` (same hand-rolled BASE style as the console icons).
 * Unknown providers fall back to a generic connector mark.
 */
function providerPaths(provider: string) {
  switch (provider) {
    case "github":
      return (
        <path d="M9.2 20.3v-2.2c-3 .6-3.7-1.4-3.7-1.4-.5-1.2-1.2-1.5-1.2-1.5-1-.7.1-.7.1-.7 1.1.1 1.7 1.1 1.7 1.1 1 1.7 2.6 1.2 3.3.9.1-.7.4-1.2.7-1.5-2.4-.3-5-1.2-5-5.4 0-1.2.4-2.2 1.1-3-.1-.3-.5-1.4.1-2.9 0 0 1-.3 3.2 1.1a8.9 8.9 0 014.6 0c2.2-1.4 3.2-1.1 3.2-1.1.6 1.5.2 2.6.1 2.9.7.8 1.1 1.8 1.1 3 0 4.2-2.6 5.1-5 5.4.4.4.8 1 .8 2.1v3.2" />
      );
    case "jira":
      return (
        <>
          <path d="M12 4.2 19.8 12 12 19.8 4.2 12z" />
          <path d="M12 8.4 15.6 12 12 15.6 8.4 12z" />
        </>
      );
    case "slack":
      return (
        <>
          <path d="M14.6 4.6V11" />
          <path d="M9.4 13v6.4" />
          <path d="M4.6 9.4H11" />
          <path d="M13 14.6h6.4" />
        </>
      );
    case "okta":
      return (
        <>
          <circle cx="12" cy="12" r="8.5" />
          <circle cx="12" cy="12" r="3.2" />
        </>
      );
    case "workday":
      return <path d="M4.8 8.5l3.4 7.6 3.8-7 3.8 7 3.4-7.6" />;
    case "aws":
      return (
        <>
          <path d="M4.6 15.2c4.6 2.8 10.4 2.5 14.8-.6" />
          <path d="M16.6 13.6l2.9.9-.9 2.8" />
        </>
      );
    case "zendesk":
      return (
        <>
          <path d="M10.5 6.5v9.7L4.8 16.2z" />
          <path d="M13.5 17.5V7.8l5.7 2.5z" />
        </>
      );
    case "email":
      return (
        <>
          <rect x="3.8" y="5.5" width="16.4" height="13" rx="2" />
          <path d="M4.5 7.5 12 13l7.5-5.5" />
        </>
      );
    case "web":
      return (
        <>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M3.5 12h17" />
          <path d="M12 3.5c2.4 2.3 3.6 5.1 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.1-3.6-8.5s1.2-6.2 3.6-8.5z" />
        </>
      );
    case "kb":
      return (
        <>
          <path d="M12 6.2C10 4.8 7.2 4.2 4 4.2v14c3.2 0 6 .6 8 2 2-1.4 4.8-2 8-2v-14c-3.2 0-6 .6-8 2z" />
          <path d="M12 6.2v14" />
        </>
      );
    case "erp":
      return (
        <>
          <ellipse cx="12" cy="6.2" rx="7" ry="2.7" />
          <path d="M5 6.2v11.6c0 1.5 3.1 2.7 7 2.7s7-1.2 7-2.7V6.2" />
          <path d="M5 12c0 1.5 3.1 2.7 7 2.7s7-1.2 7-2.7" />
        </>
      );
    case "banking":
      return (
        <>
          <path d="M4 9.5 12 4l8 5.5" />
          <path d="M5.5 9.5v8M10 9.5v8M14 9.5v8M18.5 9.5v8" />
          <path d="M4 19.5h16" />
        </>
      );
    case "payroll":
      return (
        <>
          <rect x="3.8" y="7" width="16.4" height="10" rx="2" />
          <path d="M3.8 10.5h16.4" />
          <path d="M14.8 14h2.4" />
        </>
      );
    case "xero":
      return (
        <>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6" />
        </>
      );
    default:
      return (
        <>
          <path d="M9 3.5v4.5M15 3.5v4.5" />
          <path d="M6.5 8h11v2.8a5.5 5.5 0 01-11 0z" />
          <path d="M12 16.3v4.2" />
        </>
      );
  }
}

export function ProviderGlyph({ provider, className }: IconProps & { provider: string }) {
  return (
    <svg {...BASE} className={className}>
      {providerPaths(provider)}
    </svg>
  );
}
