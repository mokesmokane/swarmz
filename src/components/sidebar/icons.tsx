/** The sidebar redesign's line icons (direction 2a), drawn in `currentColor`. */
type P = { size?: number; className?: string };

export const TerminalIcon = ({ size = 18 }: P) => (
  <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <rect x="2" y="3" width="14" height="12" rx="2" />
    <path d="M5 7l2.5 2L5 11M9 11h4" />
  </svg>
);

export const TreeIcon = ({ size = 14, className, strokeWidth = 1.3 }: P & { strokeWidth?: number }) => (
  <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={strokeWidth} className={className} aria-hidden="true">
    <circle cx="7" cy="3" r="1.8" />
    <circle cx="3" cy="11" r="1.8" />
    <circle cx="11" cy="11" r="1.8" />
    <path d="M7 4.8v2.2M7 7L3.9 9.4M7 7l3.1 2.4" />
  </svg>
);

export const PhoneIcon = ({ size = 18 }: P) => (
  <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <rect x="5" y="2" width="8" height="14" rx="2" />
    <path d="M8 13.5h2" />
  </svg>
);

export const BellIcon = ({ size = 18 }: P) => (
  <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <path d="M4.5 12.5V8a4.5 4.5 0 0 1 9 0v4.5l1.2 1.5H3.3z" />
    <path d="M7.5 16h3" />
  </svg>
);

export const ReloadIcon = ({ size = 14 }: P) => (
  <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
    <path d="M11.5 7a4.5 4.5 0 1 1-1.3-3.2" />
    <path d="M11.7 1.8v2.4H9.3" />
  </svg>
);

export const PlusIcon = ({ size = 14 }: P) => (
  <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <path d="M7 2.5v9M2.5 7h9" />
  </svg>
);

export const CaretIcon = ({ size = 10 }: P) => (
  <svg width={size} height={size} viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <path d="M2.5 3.8L5 6.3l2.5-2.5" />
  </svg>
);

export const SelectAllIcon = ({ size = 11 }: P) => (
  <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
    <rect x="1.5" y="1.5" width="9" height="9" rx="2" />
    <path d="M3.8 6.2l1.5 1.5 3-3.2" />
  </svg>
);

export const HistoryIcon = ({ size = 13 }: P) => (
  <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <path d="M2.5 7a4.5 4.5 0 1 0 1.3-3.2" />
    <path d="M2.3 1.8v2.4h2.4" />
    <path d="M7 4.6V7l1.8 1.2" />
  </svg>
);

export const CloseIcon = ({ size = 11 }: P) => (
  <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
  </svg>
);

export const CheckIcon = ({ size = 8 }: P) => (
  <svg width={size} height={size} viewBox="0 0 8 8" fill="none" stroke="#fff" strokeWidth="1.6" aria-hidden="true">
    <path d="M1.2 4.2l1.8 1.8 3.8-4" />
  </svg>
);

export const MoreIcon = ({ size = 13 }: P) => (
  <svg width={size} height={size} viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
    <circle cx="3" cy="7" r="1.2" />
    <circle cx="7" cy="7" r="1.2" />
    <circle cx="11" cy="7" r="1.2" />
  </svg>
);
