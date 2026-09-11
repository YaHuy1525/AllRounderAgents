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
