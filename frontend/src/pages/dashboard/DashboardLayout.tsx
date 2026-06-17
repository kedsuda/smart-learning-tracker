import { useEffect, useMemo, useRef, useState, type SyntheticEvent } from 'react';
import { House, BookOpen, ClipboardText, CalendarBlank, Target, Bell, Microphone, Suitcase, Robot, FileText, User, Archive, DotsThree, Sun, Moon } from 'phosphor-react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { api, assetBaseURL } from '../../services/api';
import robotImage from '../../img/robot.png';
import {
  LOCAL_NOTIFICATIONS_EVENT,
  REMOTE_NOTIFICATIONS_EVENT,
  deleteLocalNotification,
  markLocalNotificationAsRead,
  readLocalNotifications
} from '../../services/localNotifications';

const LogOut = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M16 17l5-5-5-5" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
    <path d="M21 12H9" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
    <path d="M9 19H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// Minimal accent themes used by the layout. Kept compact but include the
// properties referenced elsewhere (accent, accentStrong, accentSoft, accentRgb,
// onAccent, onAccentRgb, preview, id, label).
const accentThemes = [
  {
    id: 'blue',
    label: 'Blue',
    accent: '#3b82f6',
    accentStrong: '#2563eb',
    accentSoft: '#bfdbfe',
    accentRgb: '59,130,246',
    onAccent: '#ffffff',
    onAccentRgb: '255,255,255',
    preview: 'radial-gradient(circle at 10% 10%, rgba(59,130,246,0.28), rgba(59,130,246,0.12))'
  },
  {
    id: 'ember',
    label: 'Ember',
    accent: '#f97316',
    accentStrong: '#ea580c',
    accentSoft: '#ffedd5',
    accentRgb: '249,115,22',
    onAccent: '#ffffff',
    onAccentRgb: '255,255,255',
    preview: 'radial-gradient(circle at 10% 10%, rgba(249,115,22,0.28), rgba(249,115,22,0.12))'
  },
  {
    id: 'violet',
    label: 'Violet',
    accent: '#8b5cf6',
    accentStrong: '#6d28d9',
    accentSoft: '#efe6ff',
    accentRgb: '139,92,246',
    onAccent: '#ffffff',
    onAccentRgb: '255,255,255',
    preview: 'radial-gradient(circle at 10% 10%, rgba(139,92,246,0.28), rgba(139,92,246,0.12))'
  },
];

// Minimal background themes: include dark/light palette and gradients referenced
// by the layout.
const backgroundThemes = [
  {
    id: 'default',
    label: 'Default',
    darkBase: '#070914',
    darkPanel: '#0b1220',
    darkSidebar: '#060812',
    darkGradient: 'radial-gradient(1200px circle at 0% -20%, rgba(10, 10, 30, 0.35), transparent 45%), var(--bg)',
    darkPreview: '#070914',
    lightBase: '#f8fafc',
    lightPanel: '#ffffff',
    lightSidebar: '#f1f5f9',
    lightGradient: 'radial-gradient(900px circle at 100% 0%, rgba(59,130,246,0.06), transparent 45%), var(--bg)',
    lightPreview: '#f8fafc'
  }
];

const ThemeModeSwitch = ({
  theme,
  onChange,
  size = 'md'
}: {
  theme: 'dark' | 'light';
  onChange: (next: 'dark' | 'light') => void;
  size?: 'sm' | 'md' | 'lg';
}) => {
  const isDark = theme === 'dark';
  const iconSize = size === 'sm' ? 16 : size === 'lg' ? 22 : 18;
  return (
    <button
      type="button"
      onClick={() => onChange(isDark ? 'light' : 'dark')}
      aria-label="Toggle theme"
      className={`flex h-10 w-10 items-center justify-center rounded-full border transition ${
        isDark ? 'border-white/10 text-slate-200 hover:border-white/20' : 'border-slate-200 bg-white text-slate-600 shadow-sm hover:text-slate-900'
      }`}
    >
      {isDark ? <Sun size={iconSize} weight="duotone" /> : <Moon size={iconSize} weight="duotone" />}
    </button>
  );
};

const accentStorageKey = 'smart-classroom-accent';
const themeStorageKey = 'smart-classroom-theme';
const fontScaleStorageKey = 'smart-classroom-font-scale';
const browserNotifyEnabledStorageKey = 'slt::browser-notify-enabled';
const seenNotificationKeysStoragePrefix = 'slt::seen-notification-keys::user:';
const FONT_SCALE_MIN = 0.8;
const FONT_SCALE_MAX = 1.3;
const sidebarDarkPalette = [
  '59, 130, 246',  // blue
  '34, 197, 94',   // green
  '249, 115, 22',  // orange
  '236, 72, 153',  // pink
  '168, 85, 247',  // purple
  '234, 179, 8',   // yellow
  '6, 182, 212',   // cyan
  '99, 102, 241',  // indigo
] as const;

const MobileIcon = ({
  name,
  active = false,
  className = 'h-6 w-6',
  accent
}: {
  name: IconName;
  active?: boolean;
  className?: string;
  accent: string;
}) => {
  const normalizedAccent = accent.trim().toLowerCase();
  const accentColor =
    normalizedAccent === '#fff' ||
    normalizedAccent === '#ffffff' ||
    normalizedAccent === '#0f172a'
      ? accent
      : active
        ? shadeColor(accent, -42)
        : shadeColor(accent, -20);

  switch (name) {
    case 'overview': // หน้าหลัก (บ้าน)
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none">
          {active ? (
            <>
              <path
                d="M4.5 10.6 12 4.2l7.5 6.4v9.2a2.2 2.2 0 0 1-2.2 2.2H6.7a2.2 2.2 0 0 1-2.2-2.2v-9.2Z"
                fill={accentColor}
                stroke={accentColor}
                strokeWidth={1.4}
                strokeLinejoin="round"
              />
              <path d="M10.2 22v-6.5a1.8 1.8 0 0 1 1.8-1.8h0a1.8 1.8 0 0 1 1.8 1.8V22" stroke="#fff" strokeWidth={1.7} strokeLinecap="round" />
            </>
          ) : (
            <>
              <path
                d="M4.5 10.6 12 4.2l7.5 6.4v9.2a2.2 2.2 0 0 1-2.2 2.2H6.7a2.2 2.2 0 0 1-2.2-2.2v-9.2Z"
                stroke={accentColor}
                strokeWidth={1.9}
                strokeLinejoin="round"
              />
              <path d="M9.8 22v-6.7a2.2 2.2 0 0 1 2.2-2.2h0a2.2 2.2 0 0 1 2.2 2.2V22" stroke={accentColor} strokeWidth={1.8} strokeLinecap="round" />
            </>
          )}
        </svg>
      );
    case 'subjects': // หนังสือ
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none">
          {active ? (
            <>
              <path
                d="M7.2 4.5h9.6a2.3 2.3 0 0 1 2.3 2.3v13.9a1.1 1.1 0 0 1-1.6 0.98L12 18.9l-5.5 2.78a1.1 1.1 0 0 1-1.6-0.98V6.8a2.3 2.3 0 0 1 2.3-2.3Z"
                fill={accentColor}
              />
              <path
                d="M10 5.9v7.2l2-1.15 2 1.15V5.9"
                stroke="#fff"
                strokeWidth={1.7}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path d="M9.2 16.1h5.6" stroke="#fff" strokeWidth={1.7} strokeLinecap="round" />
            </>
          ) : (
            <>
              <path
                d="M7.2 4.5h9.6a2.3 2.3 0 0 1 2.3 2.3v13.9a1.1 1.1 0 0 1-1.6 0.98L12 18.9l-5.5 2.78a1.1 1.1 0 0 1-1.6-0.98V6.8a2.3 2.3 0 0 1 2.3-2.3Z"
                stroke={accentColor}
                strokeWidth={1.8}
                strokeLinejoin="round"
              />
              <path
                d="M10 5.9v7.2l2-1.15 2 1.15V5.9"
                stroke={accentColor}
                strokeWidth={1.6}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path d="M9.2 16.1h5.6" stroke={accentColor} strokeWidth={1.6} strokeLinecap="round" />
            </>
          )}
        </svg>
      );
    case 'quizzes': // แบบฝึกหัด (คลิปบอร์ด)
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none">
          {active ? (
            <>
              <path
                d="M8 4.5h8a2.2 2.2 0 0 1 2.2 2.2v12.9A2.4 2.4 0 0 1 15.8 22H8.2A2.4 2.4 0 0 1 5.8 19.6V6.7A2.2 2.2 0 0 1 8 4.5Z"
                fill={accentColor}
                stroke={accentColor}
                strokeWidth={1.2}
                strokeLinejoin="round"
              />
              <path
                d="M9.2 4.5h5.6a1.4 1.4 0 0 1 1.4 1.4v.8H7.8v-.8a1.4 1.4 0 0 1 1.4-1.4Z"
                fill="#fff"
                opacity={0.95}
              />
              <path d="M9 13.2l2.1 2.1L15.4 11" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
            </>
          ) : (
            <>
              <path
                d="M8 4.5h8a2.2 2.2 0 0 1 2.2 2.2v12.9A2.4 2.4 0 0 1 15.8 22H8.2A2.4 2.4 0 0 1 5.8 19.6V6.7A2.2 2.2 0 0 1 8 4.5Z"
                stroke={accentColor}
                strokeWidth={1.9}
                strokeLinejoin="round"
              />
              <path
                d="M9.2 4.5h5.6a1.4 1.4 0 0 1 1.4 1.4v.8H7.8v-.8a1.4 1.4 0 0 1 1.4-1.4Z"
                stroke={accentColor}
                strokeWidth={1.8}
                strokeLinejoin="round"
              />
              <path d="M9 13.2l2.1 2.1L15.4 11" stroke={accentColor} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
            </>
          )}
        </svg>
      );
    case 'calendar': // ปฏิทิน
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none">
          {active ? (
            <>
              <rect x="3" y="6" width="18" height="15" rx="2.4" fill={accentColor} />
              <rect x="3" y="10" width="18" height="2" fill="#fff" />
              <circle cx="8" cy="15" r="1.2" fill="#fff" />
              <circle cx="12" cy="15" r="1.2" fill="#fff" />
              <circle cx="16" cy="15" r="1.2" fill="#fff" />
            </>
          ) : (
            <>
              <rect x="4" y="5.5" width="16" height="14.5" rx="2.5" stroke={accentColor} strokeWidth={1.8} />
              <line x1="4" y1="10" x2="20" y2="10" stroke={accentColor} strokeWidth={1.6} />
              <line x1="8" y1="3.8" x2="8" y2="7" stroke={accentColor} strokeWidth={1.8} strokeLinecap="round" />
              <line x1="16" y1="3.8" x2="16" y2="7" stroke={accentColor} strokeWidth={1.8} strokeLinecap="round" />
            </>
          )}
        </svg>
      );
    case 'more': // เมนูเพิ่มเติม
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none">
          <circle cx="6" cy="12" r="2" fill={accentColor} />
          <circle cx="12" cy="12" r="2" fill={accentColor} />
          <circle cx="18" cy="12" r="2" fill={accentColor} />
        </svg>
      );
    case 'profile': // โปรไฟล์
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none">
          <circle cx="12" cy="8" r="4" stroke={accentColor} strokeWidth={2} />
          <path d="M4 20c1.8-4 13.2-4 16 0" stroke={accentColor} strokeWidth={2} strokeLinecap="round" />
        </svg>
      );
    case 'goals': // เป้าหมาย (เป้า)
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none">
          {active ? (
            <>
              <circle cx="12" cy="12" r="9" fill={accentColor} stroke={accentColor} strokeWidth={1.2} />
              <circle cx="12" cy="12" r="5.2" stroke="#fff" strokeWidth={1.9} />
              <circle cx="12" cy="12" r="2" fill="#fff" />
              <path d="M12 4.2v2.8" stroke="#fff" strokeWidth={2} strokeLinecap="round" />
            </>
          ) : (
            <>
              <circle cx="12" cy="12" r="9" stroke={accentColor} strokeWidth={2} />
              <circle cx="12" cy="12" r="5.2" stroke={accentColor} strokeWidth={2} />
              <circle cx="12" cy="12" r="2" stroke={accentColor} strokeWidth={1.8} />
              <path d="M12 4.2v2.8" stroke={accentColor} strokeWidth={2} strokeLinecap="round" />
            </>
          )}
        </svg>
      );
    case 'voiceSummary': // ไมโครโฟน
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none">
          <rect x="9" y="3" width="6" height="12" rx="3" fill={accentColor} />
          <path d="M7 10v2a5 5 0 0 0 10 0v-2" stroke={accentColor} strokeWidth={1.8} strokeLinecap="round" />
          <path d="M12 22v-4" stroke={accentColor} strokeWidth={1.8} strokeLinecap="round" />
          <path d="M8 22h8" stroke={accentColor} strokeWidth={1.8} strokeLinecap="round" />
        </svg>
      );
    case 'careerAdvisor': // จรวด
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none">
          {active ? (
            <>
              <path
                d="M12 3.5c-2.7 2.2-4.3 5.1-4.3 8.4v4.1l4.3 2.4 4.3-2.4v-4.1c0-3.3-1.6-6.2-4.3-8.4Z"
                fill={accentColor}
                stroke={accentColor}
                strokeWidth={1.2}
                strokeLinejoin="round"
              />
              <circle cx="12" cy="10.1" r="1.55" fill="#fff" />
              <path
                d="M8.3 15.2 6.2 17.3v2.7l2.3-1.1"
                stroke="#fff"
                strokeWidth={1.7}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M15.7 15.2l2.1 2.1v2.7l-2.3-1.1"
                stroke="#fff"
                strokeWidth={1.7}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M12 18.2c-1 1-1.6 2-1.6 3.1 0 1 .6 1.9 1.6 2.6 1-.7 1.6-1.6 1.6-2.6 0-1.1-.6-2.1-1.6-3.1Z"
                fill="#fff"
              />
            </>
          ) : (
            <>
              <path
                d="M12 3.5c-2.7 2.2-4.3 5.1-4.3 8.4v4.1l4.3 2.4 4.3-2.4v-4.1c0-3.3-1.6-6.2-4.3-8.4Z"
                stroke={accentColor}
                strokeWidth={1.8}
                strokeLinejoin="round"
              />
              <circle cx="12" cy="10.1" r="1.55" stroke={accentColor} strokeWidth={1.6} />
              <path
                d="M8.3 15.2 6.2 17.3v2.7l2.3-1.1"
                stroke={accentColor}
                strokeWidth={1.7}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M15.7 15.2l2.1 2.1v2.7l-2.3-1.1"
                stroke={accentColor}
                strokeWidth={1.7}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M12 18.2c-1 1-1.6 2-1.6 3.1 0 1 .6 1.9 1.6 2.6 1-.7 1.6-1.6 1.6-2.6 0-1.1-.6-2.1-1.6-3.1Z"
                stroke={accentColor}
                strokeWidth={1.6}
                strokeLinejoin="round"
              />
            </>
          )}
        </svg>
      );
    case 'assistant': // หุ่นยนต์
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none">
          <rect x="6" y="8" width="12" height="8" rx="4" fill={accentColor} />
          <circle cx="9" cy="12" r="1.2" fill="#fff" />
          <circle cx="15" cy="12" r="1.2" fill="#fff" />
          <rect x="10" y="16" width="4" height="2" rx="1" fill={accentColor} />
          <rect x="8" y="6" width="8" height="2" rx="1" fill={accentColor} />
        </svg>
      );
    case 'documentSummary': // สรุปด้วย AI (ประกาย)
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none">
          <path d="M12 5.2l1.15 3.2 3.2 1.15-3.2 1.15L12 13.9l-1.15-3.2-3.2-1.15 3.2-1.15L12 5.2Z" fill={active ? accentColor : 'none'} stroke={accentColor} strokeWidth={1.6} strokeLinejoin="round" />
          <path d="M17.5 14.3l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6.6-1.6Z" fill={active ? accentColor : 'none'} stroke={accentColor} strokeWidth={1.4} strokeLinejoin="round" />
          <path d="M6.9 14.8l.45 1.2 1.2.45-1.2.45-.45 1.2-.45-1.2-1.2-.45 1.2-.45.45-1.2Z" fill={active ? accentColor : 'none'} stroke={accentColor} strokeWidth={1.2} strokeLinejoin="round" />
        </svg>
      );
    case 'archive': // กล่องเก็บถาวร
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none">
          <rect x="4" y="7" width="16" height="12" rx="2" stroke={accentColor} strokeWidth={1.8} />
          <rect x="6" y="5" width="12" height="4" rx="1.5" fill={accentColor} />
          <path d="M9 13h6" stroke={accentColor} strokeWidth={1.8} strokeLinecap="round" />
        </svg>
      );
    case 'notifications': // กระดิ่ง
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none">
          <path
            d="M12 4a6 6 0 0 0-6 6v3.4l-1.2 2A1 1 0 0 0 5.7 17H18.3a1 1 0 0 0 .86-1.6L18 13.4V10a6 6 0 0 0-6-6Z"
            fill={accentColor}
            stroke={accentColor}
            strokeWidth={1.4}
            strokeLinejoin="round"
          />
          <path d="M10 19a2 2 0 0 0 4 0" stroke={accentColor} strokeWidth={1.6} strokeLinecap="round" />
        </svg>
      );
    default:
      return null;
  }
};

const shadeColor = (hex: string, percent: number) => {
  const num = parseInt(hex.replace('#', ''), 16);
  const amt = Math.round(2.55 * percent);
  const r = (num >> 16) + amt;
  const g = ((num >> 8) & 0x00ff) + amt;
  const b = (num & 0x0000ff) + amt;
  return `#${(
    0x1000000 +
    (r < 255 ? (r < 1 ? 0 : r) : 255) * 0x10000 +
    (g < 255 ? (g < 1 ? 0 : g) : 255) * 0x100 +
    (b < 255 ? (b < 1 ? 0 : b) : 255)
  )
    .toString(16)
    .slice(1)}`;
};

const resolveProfileUrl = (value?: string | null, fallbackBase?: string) => {
  const raw = value?.trim();
  if (!raw) return null;
  if (raw.startsWith('//')) return `https:${raw}`;
  if (raw.startsWith('http')) {
    if (typeof window !== 'undefined') {
      try {
        const parsed = new URL(raw);
        const current = new URL(window.location.origin);
        const isLocalPair =
          ['localhost', '127.0.0.1'].includes(parsed.hostname) &&
          ['localhost', '127.0.0.1'].includes(current.hostname);
        if (isLocalPair && parsed.origin !== current.origin) {
          return `${current.origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
        }
      } catch {
        // Keep original URL when parsing fails.
      }
    }
    return raw;
  }
  const base = fallbackBase
    ?.replace(/\/public\/index\.php\/api\/?$/, '')
    ?.replace(/\/index\.php\/api\/?$/, '')
    ?.replace(/\/api\/?$/, '');
  if (!base) return raw;
  const normalized = raw.startsWith('/') ? raw : `/${raw}`;
  return `${base}${normalized}`;
};

const getSeenNotificationKeyStorage = (userId?: number | null) =>
  `${seenNotificationKeysStoragePrefix}${userId ?? 'guest'}`;

const readSeenNotificationKeys = (userId?: number | null): Set<string> => {
  if (typeof window === 'undefined') return new Set<string>();
  const raw = window.localStorage.getItem(getSeenNotificationKeyStorage(userId));
  if (!raw) return new Set<string>();
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set<string>();
    return new Set(parsed.filter(item => typeof item === 'string'));
  } catch {
    return new Set<string>();
  }
};

const hasSeenNotificationKey = (userId: number | null | undefined, key: string): boolean =>
  readSeenNotificationKeys(userId).has(key);

const persistSeenNotificationKey = (userId: number | null | undefined, key: string) => {
  if (typeof window === 'undefined') return;
  const seen = readSeenNotificationKeys(userId);
  seen.add(key);
  const capped = Array.from(seen).slice(-300);
  window.localStorage.setItem(getSeenNotificationKeyStorage(userId), JSON.stringify(capped));
};

const normalizeNotifications = (payload: unknown): StudyNotification[] => {
  if (Array.isArray(payload)) {
    return payload as StudyNotification[];
  }
  if (payload && typeof payload === 'object' && Array.isArray((payload as any).data)) {
    return (payload as any).data as StudyNotification[];
  }
  return [];
};

const parseNotificationDate = (value?: string | null) => {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (match) {
    const [, year, month, day, hour, minute, second] = match;
    const parsed = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second ?? '0')
    );
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(trimmed)) {
    const parsedIso = new Date(trimmed);
    if (!Number.isNaN(parsedIso.getTime())) return parsedIso;
  }

  const fallback = new Date(trimmed);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
};

export const DashboardLayout = () => {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const brandLogo = `${import.meta.env.BASE_URL}img/admin.png`;
  const logoCandidates = [brandLogo, robotImage];
  const logoUrl = logoCandidates[0];
  const handleLogoImageError = (event: SyntheticEvent<HTMLImageElement>) => {
    const target = event.currentTarget;
    const currentIndex = Number.parseInt(target.dataset.logoFallbackIndex ?? '0', 10);
    const nextIndex = Number.isFinite(currentIndex) ? currentIndex + 1 : 1;
    if (nextIndex >= logoCandidates.length) return;
    target.dataset.logoFallbackIndex = String(nextIndex);
    target.src = logoCandidates[nextIndex];
  };
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    if (typeof window === 'undefined') return 'light';
    const stored = window.localStorage.getItem(themeStorageKey);
    return stored === 'light' || stored === 'dark' ? stored : 'light';
  });
  const [accentThemeId, setAccentThemeId] = useState(() => {
    if (typeof window === 'undefined') return accentThemes[0].id;
    const stored = window.localStorage.getItem(accentStorageKey);
    return accentThemes.some(themeItem => themeItem.id === stored) ? stored : accentThemes[0].id;
  });
  const activeAccentTheme = useMemo(
    () => accentThemes.find(themeItem => themeItem.id === accentThemeId) ?? accentThemes[0],
    [accentThemeId]
  );
  const [backgroundThemeId] = useState(backgroundThemes[0].id);
  const activeBackgroundTheme = useMemo(
    () => backgroundThemes.find(themeItem => themeItem.id === backgroundThemeId) ?? backgroundThemes[0],
    [backgroundThemeId]
  );
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [notifications, setNotifications] = useState<StudyNotification[]>([]);
  const [notifyOpen, setNotifyOpen] = useState(false);
  const [desktopThemeOpen, setDesktopThemeOpen] = useState(false);
  const [mobileThemeOpen, setMobileThemeOpen] = useState(false);
  const [logoPreviewOpen, setLogoPreviewOpen] = useState(false);
  const [webToasts, setWebToasts] = useState<InAppToast[]>([]);
  const [notifyLoading, setNotifyLoading] = useState(false);
  const [browserNotifyEnabled, setBrowserNotifyEnabled] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(browserNotifyEnabledStorageKey) !== '0';
  });
  const [browserNotifyPermission, setBrowserNotifyPermission] = useState<NotificationPermission | 'unsupported'>(
    () => {
      if (typeof window === 'undefined' || typeof window.Notification === 'undefined') return 'unsupported';
      return window.Notification.permission;
    }
  );
  const [now, setNow] = useState(() => new Date());
  const [fontScale] = useState(() => {
    if (typeof window === 'undefined') return 1;
    const stored = window.localStorage.getItem(fontScaleStorageKey);
    const parsed = stored ? Number.parseFloat(stored) : 1;
    if (!Number.isFinite(parsed)) return 1;
    return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, parsed));
  });
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const mobileDropdownRef = useRef<HTMLDivElement | null>(null);
  const mobileMenuRef = useRef<HTMLDivElement | null>(null);
  const desktopThemeRef = useRef<HTMLDivElement | null>(null);
  const mobileThemeRef = useRef<HTMLDivElement | null>(null);
  const notifiedKeysRef = useRef<Set<string>>(new Set());
  const toastTimersRef = useRef<Map<string, number>>(new Map());
  const requestedBrowserPermissionRef = useRef(false);
  const hasLoadedNotificationsRef = useRef(false);

  const unreadCount = useMemo(
    () => (Array.isArray(notifications) ? notifications.filter(n => !n.is_read).length : 0),
    [notifications]
  );
  const browserNotifySupported = browserNotifyPermission !== 'unsupported';

  const tryDesktopNotify = (title: string, body: string, id: number) => {
    if (!browserNotifyEnabled || !browserNotifySupported) return;
    if (typeof window === 'undefined' || typeof window.Notification === 'undefined') return;
    if (window.Notification.permission !== 'granted') return;

    const notification = new window.Notification(title, {
      body,
      tag: `slt-notification-${id}`,
      icon: logoUrl,
      badge: logoUrl,
    });
    notification.onclick = () => {
      window.focus();
      navigate('/notifications');
      notification.close();
    };
  };

  const dismissWebToast = (key: string) => {
    const timerId = toastTimersRef.current.get(key);
    if (timerId) {
      window.clearTimeout(timerId);
      toastTimersRef.current.delete(key);
    }
    setWebToasts(prev => prev.filter(item => item.key !== key));
  };

  const pushWebToast = (key: string, title: string, message: string) => {
    setWebToasts(prev => {
      if (prev.some(item => item.key === key)) return prev;
      return [{ key, title, message }, ...prev].slice(0, 4);
    });

    const currentTimer = toastTimersRef.current.get(key);
    if (currentTimer) window.clearTimeout(currentTimer);
    const timeoutId = window.setTimeout(() => {
      setWebToasts(prev => prev.filter(item => item.key !== key));
      toastTimersRef.current.delete(key);
    }, 9000);
    toastTimersRef.current.set(key, timeoutId);
  };

  const triggerDueNotification = (item: StudyNotification) => {
    const key = `${item.id}:${item.notify_at}`;
    if (notifiedKeysRef.current.has(key) || hasSeenNotificationKey(user?.id, key)) return;
    notifiedKeysRef.current.add(key);
    persistSeenNotificationKey(user?.id, key);
    pushWebToast(key, item.title, item.message);
    tryDesktopNotify(item.title, item.message, item.id);
    setNotifyOpen(true);
  };

  const isDueNotification = (notifyAt: string, nowMs = Date.now()) => {
    const parsed = parseNotificationDate(notifyAt);
    if (!parsed) return false;
    const notifyMs = parsed.getTime();
    return notifyMs <= nowMs;
  };

  const requestBrowserNotificationPermission = async () => {
    if (!browserNotifySupported || typeof window === 'undefined' || typeof window.Notification === 'undefined') return;
    const permission = await window.Notification.requestPermission();
    setBrowserNotifyPermission(permission);
    const enabled = permission === 'granted';
    setBrowserNotifyEnabled(enabled);
    window.localStorage.setItem(browserNotifyEnabledStorageKey, enabled ? '1' : '0');
  };

  const toggleBrowserNotification = async () => {
    if (!browserNotifySupported) return;
    if (!browserNotifyEnabled) {
      await requestBrowserNotificationPermission();
      return;
    }
    setBrowserNotifyEnabled(false);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(browserNotifyEnabledStorageKey, '0');
    }
  };

  useEffect(() => {
    if (!browserNotifySupported || typeof window === 'undefined' || typeof window.Notification === 'undefined') return;
    if (!browserNotifyEnabled) return;
    if (window.Notification.permission !== 'default') return;
    if (requestedBrowserPermissionRef.current) return;

    requestedBrowserPermissionRef.current = true;
    void requestBrowserNotificationPermission();
  }, [browserNotifyEnabled, browserNotifySupported]);

  useEffect(() => {
    const timerId = window.setInterval(() => {
      setNow(new Date());
    }, 1000);
    return () => window.clearInterval(timerId);
  }, []);

  useEffect(() => {
    if (!browserNotifySupported || typeof document === 'undefined' || typeof window.Notification === 'undefined') return;
    const syncPermission = () => setBrowserNotifyPermission(window.Notification.permission);
    document.addEventListener('visibilitychange', syncPermission);
    window.addEventListener('focus', syncPermission);
    return () => {
      document.removeEventListener('visibilitychange', syncPermission);
      window.removeEventListener('focus', syncPermission);
    };
  }, [browserNotifySupported]);

  useEffect(() => {
    let alive = true;

    const sortByNotifyAtDesc = (items: StudyNotification[]) =>
      items
        .slice()
        .sort((a, b) => {
          const at = parseNotificationDate(a.notify_at)?.getTime() ?? 0;
          const bt = parseNotificationDate(b.notify_at)?.getTime() ?? 0;
          return bt - at;
        });

    const toTypeSlug = (value: unknown) =>
      String(value ?? '')
        .toLowerCase()
        .replace(/[^a-z]/g, '')
        .trim();

    const isVoiceSummaryNotification = (n: StudyNotification) => toTypeSlug(n.type) === 'voicesummary';

    const loadNotifications = async () => {
      const localItems = readLocalNotifications(user?.id).filter(n => !isVoiceSummaryNotification(n));
      try {
        if (!hasLoadedNotificationsRef.current) {
          setNotifyLoading(true);
        }
        const res = await api.get<StudyNotification[] | { data?: StudyNotification[] }>('/notifications');
        const remoteItems = normalizeNotifications(res.data).filter(n => !isVoiceSummaryNotification(n));
        const merged = sortByNotifyAtDesc([...localItems, ...remoteItems]);
        if (!alive) return;
        setNotifications(merged);

        // Notify only when due time has arrived.
        const nowMs = Date.now();
          merged
            .filter(item => !item.is_read && isDueNotification(item.notify_at, nowMs))
            .slice(0, 20)
            .forEach(item => {
              triggerDueNotification(item);
            });
      } catch (error) {
        if (!alive) return;
        setNotifications(sortByNotifyAtDesc(localItems));
      } finally {
        if (!alive) return;
        hasLoadedNotificationsRef.current = true;
        setNotifyLoading(false);
      }
    };

    void loadNotifications();

    const intervalId = window.setInterval(() => void loadNotifications(), 5000);
    const handleArchiveRefresh = () => void loadNotifications();
    const handleLocalRefresh = () => void loadNotifications();
    const handleRemoteRefresh = () => void loadNotifications();
    window.addEventListener('slt:archive-refresh', handleArchiveRefresh as EventListener);
    window.addEventListener(LOCAL_NOTIFICATIONS_EVENT, handleLocalRefresh as EventListener);
    window.addEventListener(REMOTE_NOTIFICATIONS_EVENT, handleRemoteRefresh as EventListener);
    return () => {
      alive = false;
      window.clearInterval(intervalId);
      window.removeEventListener('slt:archive-refresh', handleArchiveRefresh as EventListener);
      window.removeEventListener(LOCAL_NOTIFICATIONS_EVENT, handleLocalRefresh as EventListener);
      window.removeEventListener(REMOTE_NOTIFICATIONS_EVENT, handleRemoteRefresh as EventListener);
    };
  }, [browserNotifyEnabled, browserNotifySupported, logoUrl, navigate, user?.id]);

  useEffect(() => {
    if (!Array.isArray(notifications) || notifications.length === 0) return;
    const nowMs = now.getTime();
    notifications
      .filter(item => !item.is_read && isDueNotification(item.notify_at, nowMs))
      .slice(0, 20)
      .forEach(item => {
        triggerDueNotification(item);
      });
  }, [notifications, now]);

  useEffect(() => {
    return () => {
      toastTimersRef.current.forEach(timerId => window.clearTimeout(timerId));
      toastTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const search = window.location.search;
    const params = new URLSearchParams(search);
    const hasOAuthParams = Boolean(params.get('code') && params.get('state'));
    const hasError = Boolean(params.get('error'));

    if ((hasOAuthParams || hasError) && location.pathname !== '/notifications') {
      navigate(`/notifications${search}`, { replace: true });
    }
  }, [location.pathname, navigate]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const resetScrollPosition = () => {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    };

    resetScrollPosition();
    const frame = window.requestAnimationFrame(resetScrollPosition);

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [location.pathname]);

  useEffect(() => {
    const handler = (ev: MouseEvent) => {
      const target = ev.target as Node;
      const clickedNotify =
        (dropdownRef.current && dropdownRef.current.contains(target)) ||
        (mobileDropdownRef.current && mobileDropdownRef.current.contains(target));
      if (!clickedNotify) {
        setNotifyOpen(false);
      }
      if (mobileMenuRef.current && !mobileMenuRef.current.contains(target)) {
        setMobileMenuOpen(false);
      }
      if (desktopThemeRef.current && !desktopThemeRef.current.contains(target)) {
        setDesktopThemeOpen(false);
      }
      if (mobileThemeRef.current && !mobileThemeRef.current.contains(target)) {
        setMobileThemeOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.style.setProperty('--accent', activeAccentTheme.accent);
    root.style.setProperty('--accent-strong', activeAccentTheme.accentStrong);
    root.style.setProperty('--accent-soft', activeAccentTheme.accentSoft);
    root.style.setProperty('--accent-rgb', activeAccentTheme.accentRgb);
    root.style.setProperty('--on-accent', activeAccentTheme.onAccent);
    root.style.setProperty('--on-accent-rgb', activeAccentTheme.onAccentRgb);
    root.dataset.accent = activeAccentTheme.id;
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(accentStorageKey, activeAccentTheme.id);
    }
  }, [activeAccentTheme]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const isDark = theme === 'dark';
    const base = isDark ? activeBackgroundTheme.darkBase : activeBackgroundTheme.lightBase;
    const gradient = isDark ? activeBackgroundTheme.darkGradient : activeBackgroundTheme.lightGradient;
    const panel = isDark ? activeBackgroundTheme.darkPanel : activeBackgroundTheme.lightPanel;
    const sidebar = isDark ? activeBackgroundTheme.darkSidebar : activeBackgroundTheme.lightSidebar;
    root.style.setProperty('--bg', base);
    root.style.setProperty('--bg-gradient', gradient);
    root.style.setProperty('--panel-bg', panel);
    root.style.setProperty('--sidebar-bg', sidebar);
    root.dataset.background = activeBackgroundTheme.id;
  }, [activeAccentTheme, activeBackgroundTheme, theme]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const nextScale = Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, fontScale));
    root.style.fontSize = `${16 * nextScale}px`;
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(fontScaleStorageKey, String(nextScale));
    }
  }, [fontScale]);

  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    root.classList.toggle('theme-dark', theme === 'dark');
    root.classList.toggle('theme-light', theme === 'light');
    body.classList.toggle('theme-dark', theme === 'dark');
    body.classList.toggle('theme-light', theme === 'light');
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(themeStorageKey, theme);
    }

    return () => {
      root.classList.remove('theme-dark', 'theme-light');
      body.classList.remove('theme-dark', 'theme-light');
    };
  }, [theme]);

  const markAsRead = async (id: number) => {
    if (id < 0) {
      markLocalNotificationAsRead(user?.id, id);
      setNotifications(prev => prev.map(n => (n.id === id ? { ...n, is_read: true } : n)));
      return;
    }
    try {
      await api.patch(`/notifications/${id}/read`);
      setNotifications(prev => prev.map(n => (n.id === id ? { ...n, is_read: true } : n)));
    } catch (error) {
      try {
        await api.post(`/notifications/${id}/read`);
        setNotifications(prev => prev.map(n => (n.id === id ? { ...n, is_read: true } : n)));
      } catch (fallbackError) {
        // ignore
      }
    }
  };

  const deleteNotification = async (id: number) => {
    if (id < 0) {
      deleteLocalNotification(user?.id, id);
      setNotifications(prev => prev.filter(n => n.id !== id));
      return;
    }
    try {
      await api.delete(`/notifications/${id}`);
      setNotifications(prev => prev.filter(n => n.id !== id));
    } catch (error) {
      try {
        await api.post(`/notifications/${id}/delete`);
        setNotifications(prev => prev.filter(n => n.id !== id));
      } catch (fallbackError) {
        // ignore
      }
    }
  };

  const navItems: NavItem[] = useMemo(
    () => [
      { to: '/ai-assistant', label: 'หน้าหลัก', icon: 'assistant', accent: activeAccentTheme.accent },
      { to: '/overview', label: 'ตารางเรียน', icon: 'subjects', accent: activeAccentTheme.accent },
      { to: '/subjects', label: 'วิชาเรียน', icon: 'subjects', accent: activeAccentTheme.accent },
      { to: '/document-summary', label: 'สรุปด้วย AI', icon: 'documentSummary', accent: activeAccentTheme.accent },
      { to: '/calendar', label: 'ปฏิทิน', icon: 'calendar', accent: activeAccentTheme.accent },
      { to: '/quizzes', label: 'แบบฝึกหัด', icon: 'quizzes', accent: activeAccentTheme.accent },
      { to: '/profile', label: 'โปรไฟล์', icon: 'profile', accent: activeAccentTheme.accent },
      { to: '/career-advisor', label: 'อาชีพแนะนำ', icon: 'careerAdvisor', accent: activeAccentTheme.accent }
      ],
      [activeAccentTheme.accent]
    );

  const latestNotifications = useMemo(() => notifications.slice(0, 3), [notifications]);
  const thaiDateTimeLabel = useMemo(() => {
    const thaiWeekdays = ['วันอาทิตย์', 'วันจันทร์', 'วันอังคาร', 'วันพุธ', 'วันพฤหัสบดี', 'วันศุกร์', 'วันเสาร์'];
    const thaiMonths = [
      'มกราคม',
      'กุมภาพันธ์',
      'มีนาคม',
      'เมษายน',
      'พฤษภาคม',
      'มิถุนายน',
      'กรกฎาคม',
      'สิงหาคม',
      'กันยายน',
      'ตุลาคม',
      'พฤศจิกายน',
      'ธันวาคม',
    ];
    const dayName = thaiWeekdays[now.getDay()] ?? '';
    const day = String(now.getDate()).padStart(2, '0');
    const monthName = thaiMonths[now.getMonth()] ?? '';
    const year = now.getFullYear() + 543;
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    return `${dayName}ที่ ${day} ${monthName} ${year} เวลา ${hh}:${mm}:${ss} น.`;
  }, [now]);
  const mobileNavItems = navItems.filter(item => item.showOnMobile !== false);
  const primaryNavItems = navItems.filter(item => item.to !== '/profile' && item.to !== '/career-advisor');
  const mobileQuickActionRoutes = useMemo(
    () => new Set(['/subjects', '/quizzes', '/career-advisor']),
    []
  );
  const bottomNavItems = [
    mobileNavItems.find(item => item.to === '/ai-assistant')
      ? {
          ...mobileNavItems.find(item => item.to === '/ai-assistant')!,
          label: 'หน้าหลัก',
          icon: 'overview' as IconName,
        }
      : null,
    mobileNavItems.find(item => item.to === '/overview')
      ? {
          ...mobileNavItems.find(item => item.to === '/overview')!,
          label: 'ตารางเรียน',
          icon: 'subjects' as IconName,
        }
      : null,
    mobileNavItems.find(item => item.to === '/calendar')
      ? { ...mobileNavItems.find(item => item.to === '/calendar')!, label: 'ปฏิทิน' }
      : null,
    mobileNavItems.find(item => item.to === '/quizzes')
      ? { ...mobileNavItems.find(item => item.to === '/quizzes')!, label: 'แบบฝึกหัด' }
      : null,
    mobileNavItems.find(item => item.to === '/profile') ? { ...mobileNavItems.find(item => item.to === '/profile')!, label: 'ฉัน' } : null,
  ].filter((item): item is NavItem => Boolean(item));
  const topNavItems = mobileNavItems.filter(
      item =>
      item.to !== '/overview' &&
      item.to !== '/ai-assistant' &&
      item.to !== '/calendar' &&
      item.to !== '/profile' &&
      !mobileQuickActionRoutes.has(item.to)
  );
  const pageTitle = useMemo(() => {
    if (location.pathname === '/' || location.pathname === '/overview' || location.pathname.startsWith('/overview/')) return 'ตารางเรียน';
    if (location.pathname === '/ai-assistant' || location.pathname.startsWith('/ai-assistant/')) return 'หน้าหลัก';
    if (location.pathname === '/notifications' || location.pathname.startsWith('/notifications/')) return 'การแจ้งเตือน';
    if (location.pathname === '/study-capture' || location.pathname.startsWith('/study-capture/')) return 'บันทึกการเรียน';
    if (location.pathname === '/study-digest' || location.pathname.startsWith('/study-digest/')) return 'สรุปการเรียน';
    if (location.pathname === '/study-storage' || location.pathname.startsWith('/study-storage/')) return 'กระเป๋าเก็บไฟล์';
    const match = navItems.find(item => location.pathname === item.to || location.pathname.startsWith(`${item.to}/`));
    return match?.label ?? 'Home';
  }, [location.pathname, navItems]);
  const isAiPage = location.pathname.startsWith('/ai-assistant');
  const profileImageUrl = useMemo(
    () => resolveProfileUrl(user?.profile_pic ?? user?.avatar, assetBaseURL || api.defaults.baseURL),
    [user?.profile_pic, user?.avatar]
  );
  const renderAccentPicker = ({
    onPick,
    variant = 'default',
  }: {
    onPick?: () => void;
    variant?: 'default' | 'mobileMenu';
  } = {}) => (
    <div className={`grid grid-cols-3 ${
      variant === 'mobileMenu'
        ? 'mt-4 gap-x-4 gap-y-5 px-2'
        : 'mt-2 gap-x-1 gap-y-2.5 sm:mt-4 sm:gap-x-3 sm:gap-y-4'
    }`}>
      {accentThemes.map(option => {
        const isActive = option.id === activeAccentTheme.id;
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => {
              setAccentThemeId(option.id);
              onPick?.();
            }}
            className="group flex flex-col items-center text-center"
            aria-label={`เลือกสี ${option.label}`}
            aria-pressed={isActive}
          >
            <span
              className={`relative block rounded-full border transition ${
                variant === 'mobileMenu' ? 'h-14 w-14' : 'h-10 w-10 sm:h-16 sm:w-16'
              } ${
                isActive
                  ? variant === 'mobileMenu'
                    ? 'scale-105 border-white ring-4 ring-offset-2 ring-[color:rgb(var(--accent-rgb))] shadow-[0_12px_22px_rgba(15,23,42,0.14)]'
                    : 'scale-[1.03] border-white ring-2 ring-white shadow-[0_8px_20px_rgba(37,99,235,0.24)] sm:ring-4 sm:shadow-[0_10px_24px_rgba(37,99,235,0.28)]'
                  : theme === 'dark'
                    ? 'border-white/20 group-hover:scale-[1.03]'
                    : 'border-white/70 group-hover:scale-[1.03]'
              }`}
              style={{ background: option.preview ?? option.accent }}
            >
              {isActive ? (
                <span className={`absolute inset-0 flex items-center justify-center font-bold leading-none text-white ${
                  variant === 'mobileMenu' ? 'text-2xl' : 'text-xl sm:text-[32px]'
                }`}>
                  ✓
                </span>
              ) : null}
              <span className="pointer-events-none absolute inset-0 rounded-full bg-gradient-to-tr from-black/10 to-white/20" />
            </span>
            <span
              className={`font-bold leading-none ${
                variant === 'mobileMenu' ? 'mt-2 text-[13px]' : 'mt-1 text-[10px] sm:mt-1.5 sm:text-sm'
              } ${
                isActive
                  ? variant === 'mobileMenu'
                    ? 'text-[color:rgb(var(--accent-rgb))]'
                    : theme === 'dark'
                      ? 'text-white'
                      : 'text-slate-700'
                  : theme === 'dark'
                    ? 'text-white/85'
                    : 'text-slate-500'
              }`}
            >
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div
      className={`relative min-h-screen overflow-x-hidden lg:h-screen ${
        theme === 'dark' ? 'text-slate-100' : 'text-slate-900'
      }`}
      style={{ background: theme === 'dark' ? 'var(--bg-gradient)' : '#f8fafc' }}
    >
      <div className="relative flex min-h-screen w-full flex-col lg:h-screen lg:flex-row lg:overflow-hidden">
        <aside
          className={`hidden w-full max-w-[256px] flex-col gap-6 border-r pb-6 pt-8 lg:sticky lg:top-0 lg:flex lg:h-screen lg:shrink-0 lg:overflow-y-auto ${
            theme === 'dark'
              ? 'border-white/10 bg-slate-950/70 text-white'
              : 'border-slate-200 bg-white text-slate-800'
          }`}
        >
            <div className={`px-6 pb-5 ${theme === 'dark' ? 'border-b border-white/10' : 'border-b border-slate-100'}`}>
              <Link to="/" className="flex items-center gap-3 text-lg font-semibold">
                <button
                  type="button"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setLogoPreviewOpen(true);
                  }}
	                  className={`flex h-11 w-11 items-center justify-center rounded-xl border transition ${
	                    theme === 'dark'
	                      ? 'border-white/10 bg-slate-950/40 hover:border-white/20 hover:bg-slate-900/60'
	                      : 'border-slate-200 text-[color:var(--accent)] hover:bg-[color:rgba(var(--accent-rgb),0.14)]'
	                  }`}
	                  style={
	                    theme === 'dark'
	                      ? undefined
	                      : { backgroundColor: 'rgba(var(--accent-rgb), 0.10)' }
	                  }
	                  aria-label="ดูรูปโลโก้"
	                >
                  <img
                    src={logoUrl}
                    alt="Smart Room"
                    className="h-11 w-11 rounded-xl object-cover"
                    onError={handleLogoImageError}
                  />
                </button>
                <span className={theme === 'dark' ? 'text-white' : 'text-slate-900'}>Smart Room</span>
              </Link>
          </div>
          <nav className="mt-4 space-y-1.5 px-4">
            {primaryNavItems.map((item, index) => {
              const itemAccentRgb = sidebarDarkPalette[index % sidebarDarkPalette.length];
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                    className={({ isActive }) =>
                      `group flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium transition ${
                        theme === 'dark'
                          ? isActive
                            ? 'text-white shadow-soft'
                            : 'text-white/85 hover:text-white'
                          : isActive
                            ? 'text-[color:var(--accent)] shadow-sm'
                            : 'text-slate-500 hover:bg-[color:rgba(var(--accent-rgb),0.06)] hover:text-[color:var(--accent)]'
                      }`
                    }
                    style={({ isActive }) => {
                      if (theme === 'dark') {
                        return isActive
                          ? {
                              background:
                                `linear-gradient(135deg, rgba(${itemAccentRgb}, 0.34), rgba(${itemAccentRgb}, 0.14))`,
                              boxShadow: `0 12px 28px rgba(${itemAccentRgb}, 0.26)`,
                              border: `1px solid rgba(${itemAccentRgb}, 0.62)`,
                            }
                          : {
                              background: `rgba(${itemAccentRgb}, 0.08)`,
                              border: `1px solid rgba(${itemAccentRgb}, 0.24)`,
                            };
                      }
                      return isActive ? { backgroundColor: 'rgba(var(--accent-rgb), 0.10)' } : undefined;
                    }}
                  >
                  {({ isActive }) => (
                    <>
                      <span
                        className={`relative flex h-10 w-10 items-center justify-center rounded-xl transition ${
                          theme === 'dark'
                            ? isActive
                              ? 'bg-slate-900/45 text-white shadow-[0_10px_22px_rgba(0,0,0,0.26)]'
                              : 'bg-transparent text-white/90'
                            : isActive
                              ? 'border text-[color:var(--accent)]'
                              : 'border border-slate-200 bg-slate-50 text-slate-500'
                        }`}
                        style={
                          theme === 'dark'
                            ? isActive
                              ? {
                                  borderColor: `rgba(${itemAccentRgb}, 0.98)`,
                                  boxShadow: `0 0 0 1px rgba(${itemAccentRgb}, 0.5), 0 10px 22px rgba(${itemAccentRgb}, 0.30)`,
                                }
                              : {
                                  borderColor: `rgba(${itemAccentRgb}, 0.62)`,
                                }
                            : isActive
                              ? {
                                borderColor: 'rgba(var(--accent-rgb), 0.14)',
                                backgroundColor: 'rgba(var(--accent-rgb), 0.10)'
                              }
                            : undefined
                        }
                      >
                        <MobileIcon
                          name={item.icon}
                          active={isActive}
                          accent={theme === 'dark' ? '#ffffff' : activeAccentTheme.accent}
                          className="h-[18px] w-[18px]"
                        />
                      </span>
	                      <span
	                        className="text-[0.96rem]"
	                        style={
	                          theme === 'dark'
                              ? isActive
                                ? { color: '#ffffff', textShadow: '0 1px 2px rgba(0,0,0,0.45)' }
                                : { color: 'rgba(255,255,255,0.96)', textShadow: '0 1px 1px rgba(0,0,0,0.35)' }
	                            : theme === 'light' && isActive
	                              ? { color: 'var(--accent)' }
	                              : undefined
	                        }
	                      >
	                        {item.label}
	                      </span>
                    </>
                  )}
                </NavLink>
              );
            })}
          </nav>
          <div className={`mt-auto px-4 pt-4 ${theme === 'dark' ? 'border-t border-white/10' : 'border-t border-slate-100'}`}>
            <Link
              to="/profile"
              className={`flex items-center gap-3 rounded-2xl border px-3 py-3 transition ${
                  theme === 'dark'
                    ? 'border-white/10 bg-slate-950/40 hover:bg-slate-900/60'
                    : 'border-slate-100 bg-white shadow-sm hover:bg-white'
              }`}
            >
              <span
                className={`flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full ${
                  theme === 'dark' ? 'bg-slate-900/60' : 'bg-slate-100'
                }`}
              >
                {profileImageUrl ? (
                  <img
                    src={profileImageUrl}
                    alt="โปรไฟล์"
                    className="h-full w-full object-cover"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <span className={`text-sm font-semibold ${theme === 'dark' ? 'text-white/85' : 'text-slate-700'}`}>
                    {user?.name?.charAt(0) ?? 'U'}
                  </span>
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{user?.name ?? 'ผู้ใช้งาน'}</span>
                <span className={`block truncate text-xs ${theme === 'dark' ? 'text-white/55' : 'text-slate-500'}`}>
                  {user?.email ?? 'ดูโปรไฟล์'}
                </span>
              </span>
            </Link>
            <div className="mt-3">
              <button
                type="button"
                onClick={logout}
                className={`flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors ${
                  theme === 'dark'
                      ? 'border border-orange-300/60 bg-gradient-to-b from-orange-500 via-orange-500 to-amber-400 text-white hover:from-orange-600 hover:via-orange-600 hover:to-amber-500'
                        : 'border border-orange-500 bg-gradient-to-b from-orange-500 via-orange-500 to-amber-400 text-white hover:from-orange-600 hover:via-orange-600 hover:to-amber-500'
                }`}
              >
                <LogOut size={18} />
                ออกจากระบบ
              </button>
            </div>
          </div>
        </aside>

        <div
          className={`mobile-app-shell relative flex-1 px-0 pb-0 pt-0 ${isAiPage ? 'sm:px-0' : 'sm:px-6'} lg:h-screen lg:px-10 ${
            isAiPage ? 'lg:overflow-hidden lg:pb-0' : 'lg:overflow-y-auto lg:pb-20'
          }`}
          style={{
            paddingBottom: 'env(safe-area-inset-bottom, 0px)',
            paddingTop: 'env(safe-area-inset-top, 0px)'
          }}
        >
          <header
            className={`relative z-30 ml-auto hidden h-20 items-center justify-end overflow-visible px-2 lg:flex ${
              theme === 'dark'
                ? 'text-white'
                : 'text-slate-900'
            }`}
          >
            <div className="relative z-10 flex w-full items-center justify-end">
              <div className="flex flex-wrap items-center justify-end gap-3">
                <div
                  className={`inline-flex items-center rounded-full border px-4 py-2 text-sm font-semibold shadow-sm ${
                    theme === 'dark'
                      ? 'border-sky-400/35 bg-sky-400/10 text-sky-100'
                      : 'border-sky-200 bg-[linear-gradient(180deg,#eaf4ff_0%,#dcecff_100%)] text-[#24407a]'
                  }`}
                >
                  <span className="whitespace-nowrap">{thaiDateTimeLabel}</span>
                </div>
                <ThemeModeSwitch theme={theme} onChange={nextTheme => setTheme(nextTheme)} />
                  <div className="relative" ref={desktopThemeRef}>
                    <button
                      type="button"
                      onClick={() => {
                        setDesktopThemeOpen(prev => !prev);
                      }}
                      className={`flex h-10 w-10 items-center justify-center rounded-full border transition ${
                        theme === 'dark'
                          ? 'border-white/10 text-slate-200 hover:border-white/20 hover:bg-slate-950/30'
                          : 'border-slate-200 bg-white text-slate-600 shadow-sm hover:text-slate-900'
                      }`}
                      aria-label="เลือกสีธีม"
                      aria-expanded={desktopThemeOpen}
                      aria-haspopup="dialog"
                    >
                      <span
                        className="h-5 w-5 rounded-full border border-white/40 shadow-sm"
                        style={{
                          background:
                            activeAccentTheme.preview ?? activeAccentTheme.accent
                        }}
                      />
                    </button>
                    {desktopThemeOpen && (
                      <div
                        className={`absolute right-0 top-full z-40 mt-3 w-[min(78vw,19rem)] rounded-3xl border p-3 shadow-[0_18px_45px_rgba(0,0,0,0.35)] sm:w-[min(88vw,22rem)] sm:p-4 ${
                          theme === 'dark'
                            ? 'border-white/10 bg-slate-900/80 text-white'
                            : 'border-[color:var(--border)] bg-[color:var(--surface)] text-[color:var(--text)]'
                        }`}
                        role="dialog"
                      >
                        <p className={`text-lg font-extrabold tracking-tight sm:text-2xl ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>
                          สีธีม
                        </p>
                        {renderAccentPicker({ onPick: () => setDesktopThemeOpen(false) })}
                      </div>
                    )}
                  </div>
                  <div className="relative" ref={dropdownRef}>
                <button
                  onClick={() => setNotifyOpen(v => !v)}
                  className={`relative flex h-11 w-11 items-center justify-center rounded-full border transition ${
                      theme === 'dark'
                        ? 'border-white/15 bg-slate-950/40 text-white'
                        : 'border-slate-200 bg-white text-slate-600 shadow-sm hover:text-slate-900'
                    }`}
                  title="การแจ้งเตือน"
                >
                  <MobileIcon name="notifications" accent={activeAccentTheme.accent} className="h-6 w-6" active />
                  {unreadCount > 0 && (
                    <span className="absolute -right-1 -top-1 rounded-full bg-rose-500 px-2 text-[11px] font-semibold text-white">
                      {unreadCount}
                    </span>
                  )}
                </button>
                {notifyOpen && (
                  <div
                    className={`absolute right-0 z-40 mt-2 w-[360px] max-w-[80vw] rounded-2xl border p-3 text-sm ${
                      theme === 'dark'
                        ? 'border-white/10 bg-slate-900/80 text-white'
                        : 'border-slate-100 bg-[color:var(--panel-bg)]'
                    }`}
                  >
                    <div className="mb-2 flex items-center justify-between">
                      <div className="flex items-center gap-2 font-semibold text-[color:var(--text)]">
                        <MobileIcon name="notifications" accent={activeAccentTheme.accent} className="h-5 w-5" active />
                        แจ้งเตือนเรียน
                      </div>
                      <div className="flex items-center gap-2">
                        {browserNotifySupported ? (
                          <button
                            type="button"
                            onClick={() => void toggleBrowserNotification()}
                            className="rounded-full border border-muted px-2 py-[2px] text-[10px] font-semibold text-accent hover:opacity-90"
                            title={
                              browserNotifyPermission === 'granted'
                                ? 'ปิดการแจ้งเตือนผ่านเบราว์เซอร์'
                                : 'เปิดการแจ้งเตือนผ่านเบราว์เซอร์'
                            }
                          >
                            {browserNotifyEnabled && browserNotifyPermission === 'granted'
                              ? 'เด้งผ่านเบราว์เซอร์: เปิด'
                              : 'เด้งผ่านเบราว์เซอร์: ปิด'}
                          </button>
                        ) : null}
                            {notifyLoading && <span className="text-[11px] text-primary/70">กำลังโหลด...</span>}
                          </div>
                        </div>
                    {notifications.length === 0 ? (
                      <p className="rounded-xl surface-2 px-3 py-3 text-muted">ยังไม่มีการแจ้งเตือน</p>
                    ) : (
                      <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                        {latestNotifications.map(n => (
                          <div
                            key={n.id}
                            className={`rounded-xl border px-3 py-2 ${n.is_read ? 'border-muted surface' : 'border-muted surface-2'}`}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div>
                                <p className="text-[13px] font-semibold text-[color:var(--text)]">{n.title}</p>
                                <p className="text-[11px] text-muted">
                                  แจ้งเมื่อ {(parseNotificationDate(n.notify_at) ?? new Date()).toLocaleString('th-TH')}
                                </p>
                                {n.delivered_at ? (
                                  <p className="text-[11px] text-emerald-200">
                                    ส่งไปที่ Gmail แล้ว: {new Date(n.delivered_at).toLocaleString('th-TH')}
                                  </p>
                                ) : null}
                              </div>
                              <div className="flex gap-1">
                                {!n.is_read && (
                                  <button
                                    onClick={() => markAsRead(n.id)}
                                    className="rounded-full border border-muted px-2 py-[2px] text-[11px] font-semibold text-accent hover:opacity-90"
                                  >
                                    อ่านแล้ว
                                  </button>
                                )}
                                <button
                                  onClick={() => deleteNotification(n.id)}
                                  className="rounded-full border border-muted px-2 py-[2px] text-[11px] font-semibold text-muted hover:opacity-90"
                                >
                                  ลบ
                                </button>
                              </div>
                            </div>
                            <p className="mt-1 text-[13px] text-muted">{n.message}</p>
                            <p className="mt-1 text-[10px] uppercase tracking-wider text-muted">ประเภท: {n.type}</p>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="mt-3 flex justify-center">
                      <Link
                        to="/notifications"
                        onClick={() => setNotifyOpen(false)}
                        className="rounded-full border border-muted px-4 py-1.5 text-[11px] font-semibold text-accent transition hover:opacity-90"
                      >
                        ดูทั้งหมด
                      </Link>
                    </div>
                  </div>
                )}
                  </div>
              </div>
            </div>
          </header>

          <div
            className="mobile-topbar sticky top-0 z-40 mb-2 px-0 text-[color:var(--text)] backdrop-blur-xl lg:hidden"
            style={{
              borderColor: 'var(--border)',
              background: 'color-mix(in srgb, var(--surface) 94%, transparent)',
              boxShadow: 'var(--shadow-soft)'
            }}
          >
              <div className="relative mx-auto max-w-4xl px-5 pb-4 pt-10" ref={mobileMenuRef}>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-full bg-[color:var(--accent)] text-sm font-bold text-white shadow-sm">
                      {profileImageUrl ? (
                        <img
                          src={profileImageUrl}
                          alt="โปรไฟล์"
                          className="h-full w-full object-cover"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <span>{user?.name?.charAt(0) ?? 'U'}</span>
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-[color:var(--muted)]">
                        สวัสดี, {user?.name?.split(' ')[0] ?? 'ผู้ใช้'} 👋
                      </p>
                      <p className="truncate text-sm font-bold text-[color:var(--text)]">Smart Room</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <div className="relative" ref={mobileDropdownRef}>
                      <button
                        type="button"
                        onClick={() => {
                          setNotifyOpen(v => !v);
                          setMobileThemeOpen(false);
                          setMobileMenuOpen(false);
                        }}
                        className="relative flex h-10 w-10 items-center justify-center rounded-full border shadow-sm transition hover:opacity-90"
                        style={{ borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--muted)' }}
                        aria-label="การแจ้งเตือน"
                        aria-expanded={notifyOpen}
                        aria-haspopup="dialog"
                      >
                        <MobileIcon
                          name="notifications"
                          accent={activeAccentTheme.accent}
                          className="h-[18px] w-[18px]"
                          active
                        />
                        {unreadCount > 0 && (
                          <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-rose-500 ring-2" style={{ boxShadow: '0 0 0 2px var(--surface)' }} />
                        )}
                      </button>
                      {notifyOpen && (
                        <div className="fixed left-1/2 top-[5.35rem] z-50 w-[min(320px,calc(100vw-1.5rem))] -translate-x-1/2 rounded-2xl border p-3 text-sm shadow-[0_18px_45px_rgba(15,23,42,0.14)]" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
                          <div className="mb-2 flex items-center justify-between">
                            <div className="flex items-center gap-2 font-semibold text-[color:var(--text)]">
                              <MobileIcon
                                name="notifications"
                                accent={activeAccentTheme.accent}
                                className="h-5 w-5"
                                active
                              />
                              แจ้งเตือนเรียน
                            </div>
                            <div className="flex items-center gap-2">
                              {browserNotifySupported ? (
                                <button
                                  type="button"
                                  onClick={() => void toggleBrowserNotification()}
                                  className="rounded-full border px-2 py-[2px] text-[10px] font-semibold text-[color:var(--accent)] hover:opacity-90"
                                  style={{ borderColor: 'var(--border)' }}
                                >
                                  {browserNotifyEnabled && browserNotifyPermission === 'granted' ? 'แจ้งเตือน: เปิด' : 'แจ้งเตือน: ปิด'}
                                </button>
                              ) : null}
                              {notifyLoading && <span className="text-[11px] text-[color:var(--muted)]">กำลังโหลด...</span>}
                            </div>
                          </div>
                          {notifications.length === 0 ? (
                            <p className="rounded-xl px-3 py-3 text-[color:var(--muted)]" style={{ background: 'var(--surface-2)' }}>ยังไม่มีการแจ้งเตือน</p>
                          ) : (
                            <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                              {latestNotifications.map(n => (
                                <div
                                  key={n.id}
                                  className="rounded-xl border px-3 py-2"
                                  style={{ borderColor: 'var(--border)', background: n.is_read ? 'var(--surface)' : 'var(--surface-2)' }}
                                >
                                  <div className="flex items-start justify-between gap-2">
                                    <div>
                                      <p className="text-[13px] font-semibold text-[color:var(--text)]">{n.title}</p>
                                      <p className="text-[11px] text-[color:var(--muted)]">
                                        แจ้งเมื่อ {(parseNotificationDate(n.notify_at) ?? new Date()).toLocaleString('th-TH')}
                                      </p>
                                    </div>
                                    <div className="flex gap-1">
                                      {!n.is_read && (
                                        <button
                                          onClick={() => markAsRead(n.id)}
                                          className="rounded-full border px-2 py-[2px] text-[11px] font-semibold text-[color:var(--accent)]"
                                          style={{ borderColor: 'var(--border)' }}
                                        >
                                          อ่านแล้ว
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                  <p className="mt-1 text-[13px] text-[color:var(--muted)]">{n.message}</p>
                                </div>
                              ))}
                            </div>
                          )}
                          <div className="mt-3 flex justify-center">
                            <Link
                              to="/notifications"
                              onClick={() => {
                                setNotifyOpen(false);
                                setMobileMenuOpen(false);
                              }}
                              className="rounded-full border px-4 py-1.5 text-[11px] font-semibold text-[color:var(--accent)] transition hover:opacity-90"
                              style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
                            >
                              ดูทั้งหมด
                            </Link>
                          </div>
                        </div>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        setMobileMenuOpen(v => !v);
                        setMobileThemeOpen(false);
                        setNotifyOpen(false);
                      }}
                      className="flex h-10 w-10 items-center justify-center rounded-full border shadow-sm transition hover:opacity-90"
                      style={{ borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--muted)' }}
                      aria-label="เมนู"
                      aria-expanded={mobileMenuOpen}
                      aria-haspopup="menu"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        className="h-[18px] w-[18px]"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.1"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M5 7h14" />
                        <path d="M5 12h14" />
                        <path d="M5 17h14" />
                      </svg>
                    </button>
                  </div>
                </div>

                <div
                  className={`fixed inset-0 z-50 transition-all duration-200 ease-out ${
                    mobileMenuOpen
                      ? 'pointer-events-auto opacity-100'
                      : 'pointer-events-none opacity-0'
                  }`}
                >
                  <button
                    type="button"
                    aria-label="ปิดเมนู"
                    onClick={() => setMobileMenuOpen(false)}
                    className="absolute inset-0 bg-slate-950/30 backdrop-blur-[2px]"
                  />
                  <div
                    className={`absolute left-1/2 top-[5.4rem] w-[min(400px,calc(100vw-1.5rem))] -translate-x-1/2 rounded-[2rem] border p-5 shadow-[0_28px_70px_rgba(15,23,42,0.18)] transition-all duration-200 ${
                      mobileMenuOpen ? 'translate-y-0 scale-100' : '-translate-y-2 scale-[0.98]'
                    } ${
                      theme === 'dark'
                        ? 'border-white/10 bg-[#0f172a] text-white'
                        : 'border-slate-200/80 bg-white text-slate-900'
                    }`}
                  >
                    <div className="mb-5 flex items-start justify-between gap-4">
                      <div>
                        <p className={`text-2xl font-extrabold tracking-tight ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>เมนูเพิ่มเติม</p>
                        <p className={`mt-1 text-sm ${theme === 'dark' ? 'text-white/55' : 'text-slate-500'}`}>ตั้งค่าธีมและเมนูเสริม</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setMobileMenuOpen(false)}
                        className={`flex h-11 w-11 items-center justify-center rounded-full border transition ${
                          theme === 'dark'
                            ? 'border-white/10 bg-white/5 text-white/80 hover:bg-white/10'
                            : 'border-slate-200 bg-slate-50 text-slate-400 hover:bg-slate-100 hover:text-slate-600'
                        }`}
                        aria-label="ปิดเมนู"
                      >
                        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M18 6 6 18" />
                          <path d="m6 6 12 12" />
                        </svg>
                      </button>
                    </div>

                    <div className="space-y-4">
                    <div
                      className={`rounded-[1.6rem] border p-5 ${
                        theme === 'dark' ? 'border-white/10 bg-white/5' : 'border-slate-100 bg-slate-50/90'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className={`text-base font-semibold ${theme === 'dark' ? 'text-white' : 'text-slate-800'}`}>โหมดการแสดงผล</p>
                          <p className={`mt-1 text-xs ${theme === 'dark' ? 'text-white/55' : 'text-slate-500'}`}>สลับโหมดสว่างและโหมดมืด</p>
                        </div>
                        <ThemeModeSwitch theme={theme} onChange={nextTheme => setTheme(nextTheme)} size="sm" />
                      </div>
                    </div>

                    <div
                      className={`rounded-[1.6rem] border p-5 ${
                        theme === 'dark' ? 'border-white/10 bg-white/5' : 'border-slate-100 bg-slate-50/90'
                      }`}
                      ref={mobileThemeRef}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className={`text-base font-semibold ${theme === 'dark' ? 'text-white' : 'text-slate-800'}`}>เลือกสีธีม</p>
                          <p className={`mt-1 text-xs ${theme === 'dark' ? 'text-white/55' : 'text-slate-500'}`}>แตะสีเพื่อเปลี่ยนธีมทันที</p>
                        </div>
                        <span
                          className="h-5 w-5 shrink-0 rounded-full border border-white/50 shadow-sm"
                          style={{ background: activeAccentTheme.preview ?? activeAccentTheme.accent }}
                        />
                      </div>
                      {renderAccentPicker({ variant: 'mobileMenu' })}
                    </div>

                    <nav className="space-y-3">
                      {topNavItems.map(item => (
                        <NavLink
                          key={item.to}
                          to={item.to}
                          onClick={() => setMobileMenuOpen(false)}
                          className={({ isActive }) =>
                            `flex items-center gap-3 rounded-[1.25rem] px-4 py-3.5 text-sm font-semibold transition ${
                              isActive
                                ? 'border border-[color:rgba(var(--accent-rgb),0.18)] bg-[color:rgba(var(--accent-rgb),0.10)] text-[color:var(--accent)]'
                                : theme === 'dark'
                                  ? 'border border-white/10 bg-white/[0.03] text-white/75 hover:bg-white/5 hover:text-white'
                                  : 'border border-slate-100 bg-slate-50/75 text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                            }`
                          }
                        >
                          {({ isActive }) => (
                            <>
                              <span
                                className={`flex h-10 w-10 items-center justify-center rounded-full ${
                                  isActive
                                    ? 'bg-white shadow-sm'
                                    : theme === 'dark'
                                      ? 'bg-white/5'
                                      : 'bg-white'
                                }`}
                              >
                                <MobileIcon name={item.icon} active={isActive} accent={item.accent} className="h-4 w-4" />
                              </span>
                              <span>{item.label}</span>
                            </>
                          )}
                        </NavLink>
                      ))}
                    </nav>

                    <button
                      type="button"
                      onClick={logout}
                      className={`flex w-full items-center justify-center gap-2.5 rounded-[1.25rem] px-4 py-4 text-sm font-semibold transition-colors ${
                        theme === 'dark'
                          ? 'border border-rose-300/60 bg-gradient-to-b from-rose-500 via-rose-500 to-pink-400 text-white hover:from-rose-600 hover:via-rose-600 hover:to-pink-500'
                          : 'border border-rose-500 bg-gradient-to-b from-rose-500 via-rose-500 to-pink-400 text-white hover:from-rose-600 hover:via-rose-600 hover:to-pink-500'
                      }`}
                    >
                      <LogOut size={18} />
                      ออกจากระบบ
                    </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

          <main className={`relative z-10 ${isAiPage ? 'mt-0 sm:mt-2 lg:h-[calc(100vh-5rem)] lg:overflow-hidden' : 'mt-0 sm:mt-6 lg:mt-0'}`}>
            <div className={`mx-auto w-full max-w-7xl px-0 pb-[calc(76px+env(safe-area-inset-bottom,0px))] ${isAiPage ? 'sm:px-0' : 'sm:px-6'} lg:px-8 ${
              isAiPage ? 'lg:h-full lg:pb-0' : 'lg:pb-10'
            }`}>
              <div className={`lg:rounded-[32px] lg:border lg:p-8 ${
                isAiPage ? 'lg:h-full lg:overflow-hidden' : 'lg:min-h-[calc(100vh-7rem)]'
              } ${
                theme === 'dark'
                  ? 'lg:border-white/10 lg:bg-slate-900/75'
                  : 'lg:border-slate-200/70 lg:bg-white/80 lg:shadow-sm'
              }`}>
                <Outlet />
              </div>
            </div>
          </main>
        </div>
      </div>

      <div
        className="pointer-events-none fixed inset-x-0 bottom-0 z-50 px-4 lg:hidden"
        style={{ paddingBottom: `calc(env(safe-area-inset-bottom, 0px) + 14px)` }}
      >
          {(() => {
            const itemCount = bottomNavItems.length;
            const slotPct = 100 / itemCount;
            const activeIndex = Math.max(
              bottomNavItems.findIndex(
                item => location.pathname === item.to || location.pathname.startsWith(`${item.to}/`)
              ),
              0
            );
            const accent = activeAccentTheme.accent;
            const accentRgb = activeAccentTheme.accentRgb;
            // build colors straight from the user's accent (no gradient):
            // the pill is a deep, darker tint of the accent; the raised circle is the full accent.
            const toRgb = (hex: string) => {
              const n = parseInt(hex.replace('#', ''), 16);
              return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
            };
            const toHex = (arr: number[]) =>
              '#' + arr.map(c => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('');
            const [ar, ag, ab] = toRgb(accent);
            const pillColor = toHex([ar * 0.34, ag * 0.34, ab * 0.34]); // darker than the circle
            const inactiveIcon = toHex([ar + (255 - ar) * 0.5, ag + (255 - ag) * 0.5, ab + (255 - ab) * 0.5]);
            const notchColor = theme === 'dark' ? '#020617' : '#f8fafc';
            const pillHeight = 64;
            const wrapperHeight = 100;
            const pillTop = wrapperHeight - pillHeight; // 36px headroom for the raised icon

            return (
              <nav className="mobile-bottom-nav pointer-events-auto mx-auto w-full max-w-[460px]">
                <div className="relative overflow-visible" style={{ height: `${wrapperHeight}px` }}>
                  {/* floating pill body */}
                  <div
                    className="absolute inset-x-0 bottom-0"
                    style={{
                      height: `${pillHeight}px`,
                      borderRadius: '30px',
                      backgroundColor: pillColor,
                      boxShadow:
                        theme === 'dark'
                          ? '0 14px 32px rgba(2, 6, 23, 0.45), inset 0 0 0 1px rgba(255,255,255,0.05)'
                          : '0 14px 34px rgba(42, 49, 64, 0.22), inset 0 0 0 1px rgba(255,255,255,0.06)'
                    }}
                  />

                  {/* sliding notch carved out of the pill top */}
                  <div
                    className="pointer-events-none absolute left-0 top-0 h-full transition-transform duration-[450ms] ease-[cubic-bezier(0.34,1.56,0.64,1)]"
                    style={{ width: `${slotPct}%`, transform: `translateX(${activeIndex * 100}%)` }}
                  >
                    <div
                      className="absolute left-1/2 h-[34px] w-[108px] -translate-x-1/2"
                      style={{ top: `${pillTop}px`, color: notchColor }}
                    >
                      <svg width="100%" height="100%" viewBox="0 0 108 34" fill="currentColor" preserveAspectRatio="none">
                        <path d="M0 0 C 28 0, 27 34, 54 34 C 81 34, 80 0, 108 0 Z" />
                      </svg>
                    </div>
                  </div>

                  {/* nav items */}
                  <div className="relative z-10 flex h-full w-full">
                    {bottomNavItems.map(item => (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        aria-label={item.label}
                        className="relative h-full outline-none"
                        style={{ width: `${slotPct}%` }}
                        onClick={() => {
                          if (item.to === '/ai-assistant' && typeof window !== 'undefined') {
                            window.dispatchEvent(new Event('smartroom:home-menu-pressed'));
                          }
                        }}
                      >
                        {({ isActive }) => (
                          <span className="relative flex h-full w-full items-end justify-center">
                            <span
                              className="absolute left-1/2 flex items-center justify-center rounded-full transition-all duration-[450ms] ease-[cubic-bezier(0.34,1.56,0.64,1)]"
                              style={{
                                transform: 'translateX(-50%)',
                                top: isActive ? `${pillTop - 20}px` : `${pillTop + 6}px`,
                                height: isActive ? '50px' : '26px',
                                width: isActive ? '50px' : '26px',
                                backgroundColor: isActive ? accent : 'transparent',
                                boxShadow: isActive
                                  ? `0 6px 18px rgba(${accentRgb}, 0.45)`
                                  : 'none'
                              }}
                            >
                              <MobileIcon
                                name={item.icon}
                                active={false}
                                accent={isActive ? '#ffffff' : inactiveIcon}
                                className={isActive ? 'h-6 w-6' : 'h-[22px] w-[22px]'}
                              />
                              {item.to === '/profile' && !isActive ? (
                                <span
                                  className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-rose-500"
                                  style={{ border: `2px solid ${pillColor}` }}
                                />
                              ) : null}
                            </span>

                            <span
                              className="pointer-events-none absolute inset-x-0 truncate px-1 text-center text-[9px] font-semibold leading-none transition-colors duration-300"
                              style={{ top: `${pillTop + 36}px`, color: isActive ? '#ffffff' : inactiveIcon }}
                            >
                              {item.label}
                            </span>
                          </span>
                        )}
                      </NavLink>
                    ))}
                  </div>
                </div>
              </nav>
            );
          })()}
        </div>

      {logoPreviewOpen && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 px-6 py-10 backdrop-blur-sm"
          onClick={() => setLogoPreviewOpen(false)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="w-[min(88vw,720px)] rounded-3xl bg-slate-900/80 p-4 sm:p-6 shadow-[0_25px_50px_rgba(0,0,0,0.45)]"
            onClick={event => event.stopPropagation()}
          >
            <img
              src={logoUrl}
              alt="Smart Room"
              className="mx-auto h-auto max-h-[78vh] w-full rounded-2xl object-contain"
              onError={handleLogoImageError}
            />
          </div>
        </div>
      )}

      {webToasts.length > 0 && (
        <div className="pointer-events-none fixed right-3 top-20 z-[90] flex w-[min(92vw,380px)] flex-col gap-2 lg:right-4 lg:top-24">
          {webToasts.map(toast => (
            <div
              key={toast.key}
              className={`pointer-events-auto rounded-2xl border border-[color:rgba(var(--accent-rgb),0.25)] ${
                theme === 'dark' ? 'bg-slate-900/80' : 'bg-[color:var(--panel-bg)]'
              } p-3 shadow-[0_14px_35px_rgba(15,23,42,0.35)] backdrop-blur`}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-[color:var(--text)]">{toast.title}</p>
                  <p className="mt-1 text-xs text-muted">{toast.message}</p>
                </div>
                <button
                  type="button"
                  onClick={() => dismissWebToast(toast.key)}
                  className="rounded-full border border-muted px-2 py-0.5 text-[11px] font-semibold text-muted hover:text-[color:var(--text)]"
                >
                  ปิด
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default DashboardLayout;
