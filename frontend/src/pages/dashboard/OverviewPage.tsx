import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { format, isValid, parseISO } from 'date-fns';
import { api, apiFallbackClients } from '../../services/api';
import { useAppAlert } from '../../context/AppAlertContext';
import { useAuth } from '../../context/AuthContext';
import { getLastQuizResultKey } from '../../constants/storage';
import { useSemesterOptions } from '../../hooks/useSemesterOptions';
import { filterBySemester, toNumberOrNull } from '../../utils/semester';
import { emitSubjectsUpdated } from '../../utils/subjectSync';
import { subscribeSubjectsUpdated } from '../../utils/subjectSync';

interface OverviewStats {
  subjects: number;
  study_logs: number;
  quizzes: number;
  quiz_attempts: number;
}

interface TrendPoint {
  period: string;
  total_minutes?: number;
  average_score?: number;
}

type ScheduleSlot = {
  id: number;
  subject: string;
  color?: string | null;
  room?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  originalStartTime?: string | null;
  originalEndTime?: string | null;
  allDay?: boolean;
  date: string;
  period: number;
  source?: string | null;
  eventId?: number | null;
  subjectId?: number | null;
  ownerUserId?: number | null;
  hourSegment?: number;
  hourSegmentsTotal?: number;
};

type CalendarEvent = {
  id: number;
  title: string;
  start_time: string;
  end_time?: string | null;
  room?: string | null;
  all_day?: boolean;
  subject_id?: number | null;
  source?: string | null;
  subject?: { id: number; name: string } | null;
  metadata?: Record<string, any>;
};

interface LastQuizResult {
  quizId: number;
  title: string;
  score: number;
  total: number;
  percentage: number;
  answered_at: string;
}

type StudyNotification = {
  id: number;
  title: string;
  message: string;
  notify_at: string;
  is_read: boolean;
  type: string;
};

type SubjectSummary = {
  id: number;
  user_id?: number | null;
  name: string;
  semester_id?: number | null;
  semester?: number | null;
  academic_year?: number | null;
  color?: string | null;
  room?: string | null;
  classroom?: string | null;
  study_log_count?: number;
  start_date?: string | null;
  start_time?: string | null;
  end_time?: string | null;
};

type SemesterChoice = {
  semester_id: number;
  label: string;
  semester?: number | null;
  academic_year?: number | null;
};

type SemesterCreateForm = {
  semester: string;
  academic_year: string;
};

type SubjectColorOption = {
  value: string;
  label: string;
};

type ScheduleWarning = {
  level: 'warning';
  message: string;
};

type DraggingSlotState = {
  key: string;
  day: string;
  index: number;
};

const subjectCardColorOptions = ['#2563eb', '#38bdf8', '#f59e0b', '#f97316', '#ec4899', '#a855f7'];
const subjectCardGreenPalette = new Set(['#10b981', '#22c55e', '#16a34a', '#34d399', '#86efac']);

const resolveSubjectColor = (color?: string | null) => {
  const trimmed = color?.trim();
  if (!trimmed) return subjectCardColorOptions[0];
  return subjectCardGreenPalette.has(trimmed.toLowerCase()) ? '#f97316' : trimmed;
};

const isIsoDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

const toIsoDate = (value?: string | null) => {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (isIsoDate(trimmed)) return trimmed;

  const match = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const rawYear = match[3];
  const parsedYear = rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear);
  const year = parsedYear >= 2400 ? parsedYear - 543 : parsedYear;

  if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(year)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const check = new Date(year, month - 1, day);
  if (Number.isNaN(check.getTime())) return null;
  if (check.getFullYear() !== year || check.getMonth() !== month - 1 || check.getDate() !== day) {
    return null;
  }

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

const toDisplayDate = (value?: string | null) => {
  const iso = toIsoDate(value);
  if (!iso) return null;
  const [year, month, day] = iso.split('-');
  const buddhistYear = Number(year) + 543;
  return `${day}/${month}/${String(buddhistYear).padStart(4, '0')}`;
};

const toDisplayDateGregorian = (value?: string | null) => {
  const iso = toIsoDate(value);
  if (!iso) return null;
  const [year, month, day] = iso.split('-');
  return `${day}/${month}/${year}`;
};

const formatSubjectDate = (value?: string | null) => {
  if (!value) return null;
  return toDisplayDate(value) ?? value;
};

const formatSubjectTime = (value?: string | null) => {
  if (!value) return null;
  const trimmed = value.trim();
  let timePart = trimmed;
  if (trimmed.includes('T')) timePart = trimmed.split('T')[1] ?? trimmed;
  else if (trimmed.includes(' ')) timePart = trimmed.split(' ')[1] ?? trimmed;

  const segments = timePart.replace(/\./g, ':').split(':');
  if (segments.length < 2) return null;
  const hour = segments[0]?.padStart(2, '0') ?? '00';
  const minute = segments[1]?.padStart(2, '0') ?? '00';
  return `${hour}:${minute}`;
};

const formatSubjectTimeRange = (start?: string | null, end?: string | null) => {
  const startLabel = formatSubjectTime(start);
  const endLabel = formatSubjectTime(end);
  if (!startLabel && !endLabel) return null;
  if (startLabel && endLabel) return `${startLabel} - ${endLabel}`;
  return startLabel ?? endLabel;
};

const thaiWeekdays = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
const getThaiWeekday = (value?: string | null) => {
  const iso = toIsoDate(value);
  if (!iso) return null;
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  return thaiWeekdays[date.getDay()] ?? null;
};

const formatSubjectDayLabel = (value?: string | null) => {
  const formattedDate = formatSubjectDate(value);
  if (!formattedDate) return null;
  const weekday = getThaiWeekday(value);
  return weekday ? `วัน${weekday} ${formattedDate}` : formattedDate;
};

const formatSemesterLabel = (semester?: number | null, academicYear?: number | null) => {
  if (!semester || !academicYear) return null;
  return `${semester}-${academicYear}`;
};

const getHideScheduleKey = (userId?: number) => `slt::hideScheduleOverview::${userId ?? 'guest'}`;
const unscheduledDayLabel = 'ไม่ระบุวัน';
const maxSchedulePeriods = 24;
const scheduleCardWidth = 208;
const scheduleCardHeight = 130;
const scheduleCardGap = 12;
const dragPreviewCursorOffsetX = scheduleCardWidth / 2;
const dragPreviewCursorOffsetY = scheduleCardHeight / 2;
const parseTimeToMinutes = (value?: string | null) => {
  if (!value) return Number.POSITIVE_INFINITY;
  const [hourValue, minuteValue] = value.split(':');
  const hour = Number(hourValue);
  const minute = Number(minuteValue);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return Number.POSITIVE_INFINITY;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return Number.POSITIVE_INFINITY;
  return hour * 60 + minute;
};
const toHourMinute = (value?: string | null) => {
  if (!value) return '--:--';
  const parts = value.split(':');
  if (parts.length < 2) return '--:--';
  return `${(parts[0] ?? '00').padStart(2, '0')}:${(parts[1] ?? '00').padStart(2, '0')}`;
};
const formatTimeRangeCompact = (startTime?: string | null, endTime?: string | null) => {
  if (!startTime && !endTime) return 'ไม่ระบุเวลา';
  return `${toHourMinute(startTime)}-${toHourMinute(endTime)}`;
};
const resolveDisplayStartTime = (slot: ScheduleSlot) => slot.originalStartTime ?? slot.startTime;
const resolveDisplayEndTime = (slot: ScheduleSlot) => slot.originalEndTime ?? slot.endTime;
const hexToRgba = (hex: string, alpha: number) => {
  const normalized = hex.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return `rgba(148, 163, 184, ${alpha})`;
  const value = Number.parseInt(normalized, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};
const schedulePalette = ['#60a5fa', '#34d399', '#c084fc', '#fb7185', '#f59e0b', '#38bdf8'];
const subjectColorOptions: SubjectColorOption[] = [
  { value: '#60a5fa', label: 'ฟ้า' },
  { value: '#34d399', label: 'เขียวมิ้นต์' },
  { value: '#c084fc', label: 'ม่วง' },
  { value: '#fb7185', label: 'ชมพู' },
  { value: '#f59e0b', label: 'ส้ม' },
  { value: '#38bdf8', label: 'ฟ้าใส' },
];
const resolveScheduleAccent = (slot: ScheduleSlot) => {
  if (slot.color && /^#[0-9a-fA-F]{6}$/.test(slot.color)) return slot.color;
  const hash = slot.subject.split('').reduce((total, char) => total + char.charCodeAt(0), 0);
  return schedulePalette[hash % schedulePalette.length] ?? schedulePalette[0];
};
const formatMinutesAsTime = (minutes: number) => {
  const bounded = Math.min(Math.max(minutes, 0), 23 * 60 + 59);
  const hour = Math.floor(bounded / 60);
  const minute = bounded % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
};
const periodToStartTime = (period: number) => formatMinutesAsTime((8 + Math.max(period - 1, 0)) * 60);
const periodToEndTime = (period: number) => formatMinutesAsTime((9 + Math.max(period - 1, 0)) * 60);
const resolveNextPeriod = (slots: ScheduleSlot[]) => {
  if (!slots.length) return 1;
  const latestEndMinutes = slots.reduce((max, slot) => {
    const end = parseTimeToMinutes(slot.endTime);
    if (Number.isFinite(end)) return Math.max(max, end);
    const start = parseTimeToMinutes(slot.startTime);
    return Number.isFinite(start) ? Math.max(max, start + 60) : max;
  }, 8 * 60);
  const normalized = Math.max(8 * 60, Math.min(23 * 60, latestEndMinutes));
  const period = Math.floor((normalized - 8 * 60) / 60) + 1;
  return Math.max(1, Math.min(maxSchedulePeriods, period));
};
const formatPeriodRange = (period: number) => formatTimeRangeCompact(periodToStartTime(period), periodToEndTime(period));
const normalizeLabelText = (value: string) =>
  value
    // remove common "invisible" characters that make strings look empty in the UI
    // (zero-width, bidi marks, word joiners, soft hyphen, etc.)
    .replace(/[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '')
    // collapse any whitespace (includes NBSP)
    .replace(/\s+/g, ' ')
    .trim();
const resolveSubjectLabel = (...candidates: Array<unknown>) => {
  const placeholder = 'ไม่ระบุวิชา';
  for (const candidate of candidates) {
    const raw =
      typeof candidate === 'number' && Number.isFinite(candidate)
        ? String(candidate)
        : typeof candidate === 'string'
          ? candidate
          : null;
    if (!raw) continue;
    const normalized = normalizeLabelText(raw);
    if (!normalized) continue;
    if (normalized === placeholder) continue;
    return normalized;
  }
  return placeholder;
};

const resolveSubjectId = (value: any) =>
  toNumberOrNull(value?.id ?? value?.subject_id ?? value?.subjectId ?? value?.subjectID);

const overviewCacheVersion = 1;
const buildOverviewCacheKey = (userId?: number | null) => `slt::overview-cache::user:${userId ?? 'guest'}::v${overviewCacheVersion}`;

const safeJsonParse = <T,>(raw: string | null): T | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};
const splitScheduleSlotByHour = (slot: ScheduleSlot) => {
  const originalStart = slot.originalStartTime ?? slot.startTime;
  const originalEnd = slot.originalEndTime ?? slot.endTime;
  const startMinutes = parseTimeToMinutes(slot.startTime);
  const endMinutes = parseTimeToMinutes(slot.endTime);

  if (slot.allDay || !Number.isFinite(startMinutes) || !Number.isFinite(endMinutes) || endMinutes <= startMinutes) {
    return [{
      ...slot,
      originalStartTime: originalStart,
      originalEndTime: originalEnd,
      hourSegment: 1,
      hourSegmentsTotal: 1,
    }];
  }

  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = startMinutes;
  while (cursor < endMinutes) {
    const nextHourBoundary = Math.ceil((cursor + 1) / 60) * 60;
    const next = Math.min(endMinutes, nextHourBoundary);
    if (next <= cursor) break;
    ranges.push({ start: cursor, end: next });
    cursor = next;
  }

  if (ranges.length === 0) {
    return [{
      ...slot,
      originalStartTime: originalStart,
      originalEndTime: originalEnd,
      hourSegment: 1,
      hourSegmentsTotal: 1,
    }];
  }

  return ranges.map((range, index) => ({
    ...slot,
    startTime: formatMinutesAsTime(range.start),
    endTime: formatMinutesAsTime(range.end),
    originalStartTime: originalStart,
    originalEndTime: originalEnd,
    hourSegment: index + 1,
    hourSegmentsTotal: ranges.length,
  }));
};
const countDistinctSubjects = (slots: ScheduleSlot[]) => {
  const keys = new Set(
    slots.map(slot => {
      if (slot.subjectId) return `subject:${slot.subjectId}`;
      if (slot.eventId) return `event:${slot.eventId}`;
      return `slot:${slot.id}:${slot.subject}:${slot.date}:${slot.startTime ?? ''}`;
    })
  );
  return keys.size;
};
const getSlotKey = (slot: ScheduleSlot) => {
  if (slot.eventId) {
    return `event:${slot.eventId}:${slot.date}:${slot.startTime ?? ''}:${slot.endTime ?? ''}:${slot.hourSegment ?? 1}`;
  }
  if (slot.subjectId) {
    return `subject:${slot.subjectId}:${slot.source ?? 'subject'}:${slot.date}:${slot.startTime ?? ''}:${slot.endTime ?? ''}:${slot.hourSegment ?? 1}`;
  }
  return `slot:${slot.id}:${slot.date}:${slot.startTime ?? ''}:${slot.endTime ?? ''}:${slot.source ?? 'manual'}:${slot.hourSegment ?? 1}`;
};
const getScheduleDedupKey = (slot: ScheduleSlot) => {
  const subjectKey = slot.subjectId ? `subject:${slot.subjectId}` : `title:${normalizeLabelText(slot.subject)}`;
  return [
    subjectKey,
    slot.date,
    slot.startTime ?? '',
    slot.endTime ?? '',
    normalizeLabelText(slot.room ?? ''),
  ].join('|');
};
const isSameSlotIdentity = (left: ScheduleSlot, right: ScheduleSlot) => {
  return getSlotKey(left) === getSlotKey(right);
};
const shouldIgnoreConflictSlot = (slot: ScheduleSlot, ignoreSlot?: ScheduleSlot | null) => {
  if (!ignoreSlot) return false;
  if (isSameSlotIdentity(slot, ignoreSlot)) return true;
  if (ignoreSlot.subjectId && slot.subjectId === ignoreSlot.subjectId) return true;
  if (ignoreSlot.eventId && slot.eventId === ignoreSlot.eventId) return true;
  return false;
};
const unwrapCollection = (payload: any) => {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.data)) return payload.data.data;
  return [];
};
const canFallbackStatus = (status?: number) => !status || status === 404 || status === 405 || status === 500;
const fetchSubjectsFromDatabase = async (includeAll = false) => {
  let lastError: unknown = null;
  for (const client of apiFallbackClients) {
    try {
      const response = await client.get('/subjects', {
        params: {
          include_study_logs: true,
          include_all: includeAll ? 1 : 0,
        },
      });
      return unwrapCollection(response.data);
    } catch (error: any) {
      lastError = error;
      const status = error?.response?.status;
      if (!canFallbackStatus(status)) {
        throw error;
      }
    }
  }
  throw lastError ?? new Error('โหลดรายวิชาไม่สำเร็จ');
};
const fetchCalendarEventsFromDatabase = async () => {
  let lastError: unknown = null;
  for (const client of apiFallbackClients) {
    try {
      const response = await client.get('/calendar-events');
      return unwrapCollection(response.data);
    } catch (error: any) {
      lastError = error;
      const status = error?.response?.status;
      if (!canFallbackStatus(status)) {
        throw error;
      }
    }
  }
  throw lastError ?? new Error('โหลดตารางเรียนไม่สำเร็จ');
};
const isDeleteFallbackStatus = (status?: number) => !status || status === 404 || status === 405 || status === 500;
const normalizeEventTypeValue = (value?: string | null) => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'class' || normalized === 'เรียน') return 'class';
  if (normalized === 'exam' || normalized === 'สอบ') return 'exam';
  if (normalized === 'other' || normalized === 'กิจกรรม') return 'other';
  return null;
};
const resolveCalendarEventType = (event: CalendarEvent) =>
  normalizeEventTypeValue((event as any).event_type)
  ?? normalizeEventTypeValue(event.source)
  ?? normalizeEventTypeValue((event as any).type)
  ?? normalizeEventTypeValue(event.metadata?.type)
  ?? normalizeEventTypeValue(event.metadata?.event_type)
  ?? null;
const buildSubjectDateTime = (date?: string | null, time?: string | null) => {
  if (!date) return null;
  const normalizedTime = normalizeTimeInput(time) ?? '00:00:00';
  return `${date} ${normalizedTime}`;
};
const parseScheduleDate = (value?: string | null) => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const datePart = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/) ?? trimmed.match(/^(\d{4})\/(\d{2})\/(\d{2})/);
  if (datePart) {
    const year = Number(datePart[1]);
    const month = Number(datePart[2]);
    const day = Number(datePart[3]);
    const parsed = new Date(year, month - 1, day);
    if (isValid(parsed)) return parsed;
  }
  const normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  const parsed = parseISO(normalized);
  if (isValid(parsed)) return parsed;
  const fallback = new Date(trimmed);
  return isValid(fallback) ? fallback : null;
};
const formatScheduleTime = (value?: string | null) => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const timeMatch = trimmed.match(/(?:T|\s)(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (timeMatch) {
    const hour = timeMatch[1] ?? '00';
    const minute = timeMatch[2] ?? '00';
    const second = timeMatch[3] ?? '00';
    return `${hour}:${minute}:${second}`;
  }
  const plainTimeMatch = trimmed.match(/^(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (plainTimeMatch) {
    const hour = plainTimeMatch[1] ?? '00';
    const minute = plainTimeMatch[2] ?? '00';
    const second = plainTimeMatch[3] ?? '00';
    return `${hour}:${minute}:${second}`;
  }
  const parsed = parseISO(trimmed);
  if (isValid(parsed)) return format(parsed, 'HH:mm:ss');
  return value;
};
const normalizeTimeInput = (value?: string | null) => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let normalized = trimmed.replace(/\./g, ':');
  if (normalized.includes('T')) {
    normalized = normalized.split('T')[1] ?? normalized;
  } else if (normalized.includes(' ')) {
    normalized = normalized.split(' ')[1] ?? normalized;
  }
  normalized = normalized.split('+')[0] ?? normalized;
  const segments = normalized.split(':');
  if (segments.length < 2) return null;
  const hour = (segments[0] ?? '00').padStart(2, '0');
  const minute = (segments[1] ?? '00').padStart(2, '0');
  const second = (segments[2] ?? '00').padStart(2, '0');
  return `${hour}:${minute}:${second}`;
};
const normalizeTimeForInput = (value?: string | null) => {
  if (!value) return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  const timeChunk = trimmed.includes('T')
    ? (trimmed.split('T')[1] ?? '')
    : trimmed.includes(' ')
      ? (trimmed.split(' ')[1] ?? '')
      : trimmed;
  const withoutOffset = timeChunk.split('+')[0] ?? timeChunk;
  const segments = withoutOffset.replace(/\./g, ':').split(':');
  if (segments.length < 2) return '';
  const hour = (segments[0] ?? '00').padStart(2, '0');
  const minute = (segments[1] ?? '00').padStart(2, '0');
  return `${hour}:${minute}`;
};

export const OverviewPage = () => {
  const { user } = useAuth();
  const { success, error } = useAppAlert();
  const lastQuizResultKey = useMemo(() => getLastQuizResultKey(user?.id), [user?.id]);
  const showAllSubjects = user?.role === 'admin';

  const [, setStats] = useState<OverviewStats | null>(null);
  const [, setStudyTrend] = useState<TrendPoint[]>([]);
  const [, setQuizTrend] = useState<TrendPoint[]>([]);
  const [schedule, setSchedule] = useState<Record<string, ScheduleSlot[]>>({});
  const [subjects, setSubjects] = useState<SubjectSummary[]>([]);
  const [selectedSemesterKey, setSelectedSemesterKey] = useState('all');
  const [, setLastQuizResult] = useState<LastQuizResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [, setNotifications] = useState<StudyNotification[]>([]);
  const [deletingSlotKey, setDeletingSlotKey] = useState<string | null>(null);
  const [scheduleEditingSlot, setScheduleEditingSlot] = useState<ScheduleSlot | null>(null);
  const [scheduleEditForm, setScheduleEditForm] = useState({
    subjectId: '',
    date: '',
    startTime: '',
    endTime: '',
    room: '',
    allDay: false,
    color: subjectColorOptions[0].value,
  });
  const [scheduleEditError, setScheduleEditError] = useState<string | null>(null);
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [subjectRefreshKey, setSubjectRefreshKey] = useState(0);
  const [semesterChoices, setSemesterChoices] = useState<SemesterChoice[]>([]);
  const [isCreatingSemester, setIsCreatingSemester] = useState(false);
  const [newSemester, setNewSemester] = useState<SemesterCreateForm>({ semester: '1', academic_year: '' });
  const [createSemesterError, setCreateSemesterError] = useState<string>('');
  const [subjectEditorOpen, setSubjectEditorOpen] = useState(false);
  const [subjectEditorSaving, setSubjectEditorSaving] = useState(false);
  const [subjectCatalogOpen, setSubjectCatalogOpen] = useState(false);
  const [deletingSubjectId, setDeletingSubjectId] = useState<number | null>(null);
  const [subjectEditorError, setSubjectEditorError] = useState<string | null>(null);
  const [activeDay, setActiveDay] = useState('จันทร์');
  const [pendingDeleteDialog, setPendingDeleteDialog] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    action: () => Promise<void> | void;
  } | null>(null);
  const [pendingDeleteBusy, setPendingDeleteBusy] = useState(false);
  const [subjectEditor, setSubjectEditor] = useState({
    subjectId: null as number | null,
    sourceSubjectId: '' as string,
    name: '',
    semesterId: '',
    date: format(new Date(), 'yyyy-MM-dd'),
    startTime: '',
    endTime: '',
    room: '',
    allDay: false,
    color: subjectColorOptions[0].value,
  });
  const [draggingSlot, setDraggingSlot] = useState<DraggingSlotState | null>(null);
  const [dropPreview, setDropPreview] = useState<{ day: string; index: number } | null>(null);
  const [dragPointer, setDragPointer] = useState<{ x: number; y: number } | null>(null);
  const draggingSlotKey = draggingSlot?.key ?? null;
  const draggingSlotRef = useRef<DraggingSlotState | null>(null);
  const draggingSlotDataRef = useRef<ScheduleSlot | null>(null);
  const dropPreviewRef = useRef<{ day: string; index: number } | null>(null);
  const dropCommittingRef = useRef(false);
  const daySectionRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const subjectEditorDatePickerRef = useRef<HTMLInputElement | null>(null);

  const hideKey = useMemo(() => getHideScheduleKey(user?.id), [user?.id]);
  const semesterOptions = useSemesterOptions();
  const subjectNameById = useMemo(() => {
    const map = new Map<number, string>();
    subjects.forEach(subject => {
      const id = resolveSubjectId(subject);
      const name = resolveSubjectLabel(
        (subject as any)?.name,
        (subject as any)?.subject_name,
        (subject as any)?.title,
        (subject as any)?.subject?.name
      );

      if (!Number.isFinite(Number(id))) return;
      if (!name || name === 'ไม่ระบุวิชา') return;
      map.set(Number(id), name);
    });
    return map;
  }, [subjects]);
  const filteredSubjects = useMemo(() => filterBySemester(subjects, selectedSemesterKey), [subjects, selectedSemesterKey]);
  const filteredSubjectIdSet = useMemo(() => new Set(filteredSubjects.map(subject => subject.id)), [filteredSubjects]);
  const scheduleBySemester = useMemo(() => {
    if (selectedSemesterKey === 'all') return schedule;
    return Object.fromEntries(
      Object.entries(schedule).map(([day, slots]) => [
        day,
        slots.filter(slot => !slot.subjectId || filteredSubjectIdSet.has(slot.subjectId)),
      ])
    );
  }, [filteredSubjectIdSet, schedule, selectedSemesterKey]);

  useEffect(() => {
    const userId = Number(user?.id);
    if (!Number.isFinite(userId) || userId <= 0) return;
    const cacheKey = buildOverviewCacheKey(userId);
    type OverviewCache = {
      v: number;
      savedAt: number;
      stats: OverviewStats | null;
      studyTrend: TrendPoint[];
      quizTrend: TrendPoint[];
      schedule: Record<string, ScheduleSlot[]>;
      subjects: any[];
      notifications: StudyNotification[];
      semesterChoices: SemesterChoice[];
    };
    const cached = safeJsonParse<OverviewCache>(localStorage.getItem(cacheKey));
    if (!cached || cached.v !== overviewCacheVersion) return;

    // Hydrate minimal UI quickly; refresh in background.
    if (cached.stats) setStats(cached.stats);
    if (Array.isArray(cached.studyTrend)) setStudyTrend(cached.studyTrend);
    if (Array.isArray(cached.quizTrend)) setQuizTrend(cached.quizTrend);
    if (cached.schedule && typeof cached.schedule === 'object') setSchedule(cached.schedule);
    if (Array.isArray(cached.subjects)) setSubjects(cached.subjects as any);
    if (Array.isArray(cached.notifications)) setNotifications(cached.notifications);
    if (Array.isArray(cached.semesterChoices)) setSemesterChoices(cached.semesterChoices);

    setLoading(false);
  }, [user?.id]);

  // ✅ แยกสถานะซ่อน/ล้างตารางตาม user
  const [scheduleHidden, setScheduleHidden] = useState<boolean>(true);

  // ✅ กัน race: request เก่าตอบกลับมาทับ state ใหม่
  const reqIdRef = useRef(0);

  // ✅ สำคัญ: เมื่อ user เปลี่ยน ต้องรีเซ็ตตารางทันที
  useEffect(() => {
    setSchedule({});
    setScheduleHidden(localStorage.getItem(hideKey) === '1');
  }, [hideKey]);

  useEffect(() => subscribeSubjectsUpdated(() => {
    setSubjectRefreshKey(prev => prev + 1);
  }), []);

  useEffect(() => {
    dropPreviewRef.current = dropPreview;
  }, [dropPreview]);

  useEffect(() => {
    const loadSemesters = async () => {
      for (const client of apiFallbackClients) {
        try {
          const response = await client.get('/semesters');
          const rows = unwrapCollection(response.data);
          const nextChoices = rows
            .map((item: any) => ({
              semester_id: toNumberOrNull(item?.semester_id) ?? 0,
              semester: toNumberOrNull(item?.semester),
              academic_year: toNumberOrNull(item?.academic_year),
              label: `เทอม ${toNumberOrNull(item?.semester) ?? '-'} / ${toNumberOrNull(item?.academic_year) ?? '-'}`
            }))
            .filter((item: SemesterChoice) => Number.isFinite(item.semester_id) && item.semester_id > 0);
          setSemesterChoices(nextChoices);
          return;
        } catch (error: any) {
          const status = error?.response?.status;
          if (status && status !== 404 && status !== 405 && status !== 500) break;
        }
      }
      setSemesterChoices([]);
    };

    void loadSemesters();
  }, []);
  const displayWeekOrder = useMemo(() => {
    const hasUnscheduled = (scheduleBySemester[unscheduledDayLabel] ?? []).length > 0;
    return hasUnscheduled ? [...weekOrder, unscheduledDayLabel] : weekOrder;
  }, [scheduleBySemester]);
  const scheduleDisplayByDay = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(scheduleBySemester).map(([day, slots]) => [
          day,
          slots
            .sort((a, b) => {
              const periodDelta = (a.period ?? 0) - (b.period ?? 0);
              if (periodDelta !== 0) return periodDelta;
              return parseTimeToMinutes(a.startTime) - parseTimeToMinutes(b.startTime);
            }),
        ])
      ) as Record<string, ScheduleSlot[]>,
    [scheduleBySemester]
  );
  const scheduleDisplaySlotMap = useMemo(
    () => new Map(Object.values(scheduleDisplayByDay).flat().map(slot => [getSlotKey(slot), slot] as const)),
    [scheduleDisplayByDay]
  );
  const scheduleWarnings = useMemo(() => {
    const warningMap = new Map<string, ScheduleWarning>();

    Object.values(scheduleDisplayByDay).forEach(slots => {
      let previousSlot: ScheduleSlot | null = null;

      slots.forEach(slot => {
        const slotKey = getSlotKey(slot);
        const startMinutes = parseTimeToMinutes(slot.startTime);
        const endMinutes = parseTimeToMinutes(slot.endTime);

        if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes)) {
          warningMap.set(slotKey, { level: 'warning', message: 'รูปแบบเวลาไม่ถูกต้อง' });
          previousSlot = slot;
          return;
        }

        if (endMinutes <= startMinutes) {
          warningMap.set(slotKey, { level: 'warning', message: 'เวลาเลิกควรหลังเวลาเริ่ม' });
        }

        if (previousSlot) {
          const previousKey = getSlotKey(previousSlot);
          const previousStart = parseTimeToMinutes(previousSlot.startTime);
          const previousEnd = parseTimeToMinutes(previousSlot.endTime);

          if (Number.isFinite(previousEnd) && previousEnd > startMinutes) {
            warningMap.set(previousKey, {
              level: 'warning',
              message: warningMap.get(previousKey)?.message ?? 'เวลาซ้อนกับวิชาอื่น',
            });
            warningMap.set(slotKey, { level: 'warning', message: 'เวลาซ้อนกับวิชาอื่น' });
          } else if (Number.isFinite(previousStart) && previousStart > startMinutes && !warningMap.has(slotKey)) {
            warningMap.set(slotKey, { level: 'warning', message: 'ลำดับการ์ดไม่ตรงกับเวลา' });
          }
        }

        previousSlot = slot;
      });
    });

    return warningMap;
  }, [scheduleDisplayByDay]);

  const dayNavigationItems = useMemo(() => {
    const shortNameMap: Record<string, string> = {
      จันทร์: 'จ',
      อังคาร: 'อ',
      พุธ: 'พ',
      พฤหัสบดี: 'พฤ',
      ศุกร์: 'ศ',
      เสาร์: 'ส',
      อาทิตย์: 'อา',
      [unscheduledDayLabel]: '?',
    };

    return displayWeekOrder.map(day => ({
      day,
      shortName: shortNameMap[day] ?? day.slice(0, 1),
      accent: scheduleDayToneMap[day]?.accent ?? 'var(--accent)',
    }));
  }, [displayWeekOrder]);

  const showScheduleView = () => {
    setScheduleHidden(false);
    localStorage.removeItem(hideKey);
  };

  const scrollToDay = (day: string) => {
    setActiveDay(day);
    daySectionRefs.current[day]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const createSemester = async () => {
    const semester = Number(newSemester.semester);
    const academicYear = Number(newSemester.academic_year);

    if (!Number.isFinite(semester) || semester < 1 || semester > 3) {
      setCreateSemesterError('กรุณาเลือกเทอม 1, 2 หรือ 3');
      return;
    }

    if (!Number.isFinite(academicYear) || academicYear < 2000 || academicYear > 3000) {
      setCreateSemesterError('กรุณากรอกปีการศึกษา 4 หลัก');
      return;
    }

    setCreateSemesterError('');
    setIsCreatingSemester(true);

    try {
      const response = await api.post('/semesters', {
        semester,
        academic_year: academicYear,
      });

      const created = response.data?.data && typeof response.data.data === 'object'
        ? response.data.data
        : response.data;

      const nextChoice: SemesterChoice | null = created?.semester_id
        ? {
            semester_id: Number(created.semester_id),
            semester: toNumberOrNull(created.semester),
            academic_year: toNumberOrNull(created.academic_year),
            label: `เทอม ${toNumberOrNull(created.semester) ?? '-'} / ${toNumberOrNull(created.academic_year) ?? '-'}`,
          }
        : null;

      setSemesterChoices(prev => {
        const merged = nextChoice
          ? [...prev.filter(item => item.semester_id !== nextChoice.semester_id), nextChoice]
          : prev;
        return merged.sort((a, b) => {
          if ((a.academic_year ?? 0) !== (b.academic_year ?? 0)) {
            return (a.academic_year ?? 0) - (b.academic_year ?? 0);
          }
          return (a.semester ?? 0) - (b.semester ?? 0);
        });
      });

      if (nextChoice?.semester_id) {
        setSubjectEditor(prev => ({ ...prev, semesterId: String(nextChoice.semester_id) }));
      }

      success('เพิ่มภาคเรียนเรียบร้อยแล้ว');
    } catch (err: any) {
      setCreateSemesterError(err?.response?.data?.message || err?.message || 'เพิ่มภาคเรียนไม่สำเร็จ');
    } finally {
      setIsCreatingSemester(false);
    }
  };

  useEffect(() => {
    if (!user?.id) return;

    const myReqId = ++reqIdRef.current;

    setLoading(true);
    setSchedule({}); // ✅ เคลียร์ก่อนโหลด กันค้าง

    Promise.allSettled([
      api.get('/dashboard/overview'),
      api.get('/dashboard/progress'),
      fetchSubjectsFromDatabase(showAllSubjects),
      fetchCalendarEventsFromDatabase(),
    ])
      .then(([overviewRes, progressRes, subjectsRes, eventsRes]) => {
        // ✅ ถ้ามี request ใหม่กว่าแล้ว ไม่ต้อง setState
        if (reqIdRef.current !== myReqId) return;

        if (overviewRes.status === 'fulfilled') {
          setStats(overviewRes.value.data?.data ?? overviewRes.value.data);
        } else {
          setStats(null);
        }

        if (progressRes.status === 'fulfilled') {
          const progressPayload = progressRes.value.data?.data ?? progressRes.value.data;
          setStudyTrend(progressPayload?.study_trend ?? []);
          setQuizTrend(progressPayload?.quiz_trend ?? []);
        } else {
          setStudyTrend([]);
          setQuizTrend([]);
        }

        const subjectsPayload = subjectsRes.status === 'fulfilled' ? subjectsRes.value : [];
        const hasRealSubjects = Array.isArray(subjectsPayload) && subjectsPayload.length > 0;
        const normalizedSubjects = hasRealSubjects
          ? subjectsPayload
              .map((subject: any) => {
                const id = resolveSubjectId(subject);
                const name = resolveSubjectLabel(subject?.name, subject?.subject_name, subject?.title);
                if (!id || !Number.isFinite(id)) return null;
                return {
                  ...subject,
                  id,
                  name,
                  semester_id: toNumberOrNull(subject?.semester_id),
                  semester: toNumberOrNull(subject?.semester),
                  academic_year: toNumberOrNull(subject?.academic_year),
                };
              })
              .filter(Boolean)
          : [];
        setSubjects(normalizedSubjects as any[]);
        const subjectMap = new Map<number, any>((normalizedSubjects as any[]).map(subject => [Number(subject.id), subject] as const));

        if (scheduleHidden) {
          setSchedule({});
          return;
        }

        const map: Record<string, ScheduleSlot[]> = {};
        const seenScheduleSlots = new Set<string>();
        const eventsPayload = eventsRes.status === 'fulfilled' ? eventsRes.value : [];

        const pushSlot = (slot: ScheduleSlot) => {
          const dedupKey = getScheduleDedupKey(slot);
          if (seenScheduleSlots.has(dedupKey)) return;
          seenScheduleSlots.add(dedupKey);

          const dayLabel = resolveScheduleDayLabel(slot.date);
          if (!map[dayLabel]) map[dayLabel] = [];
          map[dayLabel].push(...splitScheduleSlotByHour(slot));
        };

        if (Array.isArray(eventsPayload)) {
          eventsPayload.forEach((event: any) => {
            const eventType = resolveCalendarEventType(event);
            const linkedSubjectId = toNumberOrNull(
              event?.subject?.id ??
                event?.subject_id ??
                event?.subjectId ??
                event?.subjectID ??
                event?.metadata?.subject_id ??
                event?.metadata?.subjectId
            );
            const eventSource = normalizeEventTypeValue(event?.source) ? event?.source : event?.metadata?.source;
            const normalizedSource = String(eventSource ?? '').trim().toLowerCase();
            const linkedStudyLogId = toNumberOrNull(event?.study_log_id ?? event?.studyLogId ?? event?.metadata?.study_log_id);
            if (normalizedSource === 'study_log' || linkedStudyLogId) return;
            if (eventType && eventType !== 'class' && !linkedSubjectId) return;

            const parsedDate = parseScheduleDate(event?.start_time);
            if (!parsedDate) return;

            const subject = linkedSubjectId ? subjectMap.get(linkedSubjectId) : null;
            const allDay = Boolean(event?.all_day ?? event?.metadata?.all_day);
            const slot: ScheduleSlot = {
              id: Number(event?.id) || Date.now(),
              subject: resolveSubjectLabel(
                subject?.name,
                subject?.subject_name,
                subject?.title,
                event?.subject?.name,
                event?.subject_name,
                event?.title,
                event?.name,
                event?.metadata?.title,
                event?.metadata?.subject_name
              ),
              color: subject?.color ?? null,
              startTime: allDay ? null : formatScheduleTime(event?.start_time),
              endTime: allDay ? null : formatScheduleTime(event?.end_time),
              room:
                typeof event?.room === 'string'
                  ? event.room
                  : (typeof event?.metadata?.room === 'string'
                      ? event.metadata.room
                      : (typeof subject?.classroom === 'string'
                          ? subject.classroom
                          : (typeof subject?.room === 'string' ? subject.room : null))),
              allDay,
              date: format(parsedDate, 'yyyy-MM-dd'),
              period: 0,
              source: linkedSubjectId ? (String(eventSource ?? '').trim().toLowerCase() === 'subject' ? 'subject' : 'subject-event') : 'manual',
              eventId: Number(event?.id) > 0 ? Number(event.id) : null,
              subjectId: linkedSubjectId,
              ownerUserId: Number.isFinite(Number(subject?.user_id)) ? Number(subject.user_id) : null,
            };
            pushSlot(slot);
          });
        }

        Object.keys(map).forEach(key => {
          map[key] = map[key]
            .sort((a, b) => {
              const timeDelta = parseTimeToMinutes(a.startTime) - parseTimeToMinutes(b.startTime);
              if (timeDelta !== 0) return timeDelta;
              return a.subject.localeCompare(b.subject, 'th', { sensitivity: 'base' });
            })
            .slice(0, maxSchedulePeriods)
            .map((slot, idx) => ({ ...slot, period: idx + 1 }));
        });

        setSchedule(map);
      })
      .finally(() => {
        if (reqIdRef.current !== myReqId) return;
        setLoading(false);
      });
  }, [user?.id, scheduleHidden, showAllSubjects, subjectRefreshKey]);

  useEffect(() => {
    if (displayWeekOrder.length === 0) return;
    setActiveDay(prev => (displayWeekOrder.includes(prev) ? prev : displayWeekOrder[0]));
  }, [displayWeekOrder]);

  useEffect(() => {
    const currentAcademicYear = new Date().getFullYear() + 543;
    setNewSemester(prev => ({
      ...prev,
      academic_year: prev.academic_year || String(currentAcademicYear),
    }));
  }, []);

  useEffect(() => {
    if (scheduleHidden || displayWeekOrder.length === 0) return;

    const observer = new IntersectionObserver(
      entries => {
        const visibleEntry = entries
          .filter(entry => entry.isIntersecting)
          .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
        const day = visibleEntry?.target.getAttribute('data-day');
        if (day) setActiveDay(day);
      },
      {
        root: null,
        rootMargin: '-15% 0px -65% 0px',
        threshold: [0, 0.2, 0.45, 0.7],
      }
    );

    displayWeekOrder.forEach(day => {
      const element = daySectionRefs.current[day];
      if (element) observer.observe(element);
    });

    return () => observer.disconnect();
  }, [displayWeekOrder, scheduleHidden, scheduleDisplayByDay]);

  const reindexScheduleSlots = (slots: ScheduleSlot[]) =>
    slots
      .slice()
      .slice(0, maxSchedulePeriods)
      .map((slot, idx) => ({ ...slot, period: idx + 1 }));

  const resolveScheduleDayLabel = (date: string | null) => {
    const parsed = parseScheduleDate(date);
    if (!parsed) return unscheduledDayLabel;
    const dayKey = format(parsed, 'EEEE');
    return dayMap[dayKey] ?? dayKey;
  };

  const resolveNextDateForDayLabel = (dayLabel: string) => {
    if (dayLabel === unscheduledDayLabel) return format(new Date(), 'yyyy-MM-dd');
    const targetIndex = weekOrder.indexOf(dayLabel);
    if (targetIndex < 0) return format(new Date(), 'yyyy-MM-dd');
    const now = new Date();
    const currentIndex = (now.getDay() + 6) % 7;
    const delta = (targetIndex - currentIndex + 7) % 7;
    const nextDate = new Date(now);
    nextDate.setDate(now.getDate() + delta);
    return format(nextDate, 'yyyy-MM-dd');
  };

  const openScheduleEditor = (slot: ScheduleSlot) => {
    const fallbackDate = format(new Date(), 'yyyy-MM-dd');
    const nextDate = slot.date || fallbackDate;
    setScheduleEditingSlot(slot);
    setScheduleEditError(null);
    setScheduleEditForm({
      subjectId: slot.subjectId ? String(slot.subjectId) : '',
      date: nextDate,
      startTime: normalizeTimeForInput(slot.startTime),
      endTime: normalizeTimeForInput(slot.endTime),
      room: slot.room ?? '',
      allDay: slot.allDay ?? false,
      color: slot.color ?? resolveScheduleAccent(slot),
    });
  };

  const openScheduleEditorForCreate = (dayLabel?: string, period?: number) => {
    const nextDate = dayLabel ? resolveNextDateForDayLabel(dayLabel) : format(new Date(), 'yyyy-MM-dd');
    setScheduleEditingSlot({
      id: Date.now(),
      subject: '',
      date: nextDate,
      period: 0,
      source: 'draft',
      eventId: null,
      subjectId: null,
      room: null,
      allDay: false,
    });
    setScheduleEditError(null);
    setScheduleEditForm({
      subjectId: '',
      date: nextDate,
      startTime: period ? toHourMinute(periodToStartTime(period)) : '',
      endTime: period ? toHourMinute(periodToEndTime(period)) : '',
      room: '',
      allDay: false,
      color: subjectColorOptions[0].value,
    });
  };

  const closeScheduleEditor = () => {
    setScheduleEditingSlot(null);
    setScheduleEditError(null);
  };

  const openSubjectEditorForSlot = (slot: ScheduleSlot) => {
    const linkedSubject = slot.subjectId ? subjects.find(subject => subject.id === slot.subjectId) ?? null : null;
    const nextDate = slot.date || format(new Date(), 'yyyy-MM-dd');
    setSubjectEditorError(null);
    setSubjectEditor({
      subjectId: slot.subjectId ?? null,
      sourceSubjectId: '',
      name: slot.subject,
      semesterId: linkedSubject?.semester_id ? String(linkedSubject.semester_id) : '',
      date: nextDate,
      startTime: normalizeTimeForInput(slot.startTime),
      endTime: normalizeTimeForInput(slot.endTime),
      room: slot.room ?? '',
      allDay: slot.allDay ?? false,
      color: slot.color ?? resolveScheduleAccent(slot),
    });
    setSubjectEditorOpen(true);
  };

  const openSubjectEditorForCreate = () => {
    const selectedOption = semesterOptions.find(option => option.key === selectedSemesterKey);
    const matchingSemester = selectedSemesterKey.startsWith('id:')
      ? semesterChoices.find(choice => choice.semester_id === Number(selectedSemesterKey.slice(3)))
      : semesterChoices.find(choice =>
          choice.semester === selectedOption?.semester &&
          choice.academic_year === selectedOption?.academic_year
        );
    const defaultSemester = matchingSemester ?? semesterChoices[0] ?? null;

    setSubjectEditorError(null);
    setSubjectEditor({
      subjectId: null,
      sourceSubjectId: '',
      name: '',
      semesterId: defaultSemester ? String(defaultSemester.semester_id) : '',
      date: format(new Date(), 'yyyy-MM-dd'),
      startTime: '',
      endTime: '',
      room: '',
      allDay: false,
      color: subjectColorOptions[subjects.length % subjectColorOptions.length]?.value ?? subjectColorOptions[0].value,
    });
    setSubjectEditorOpen(true);
  };

  const openSubjectEditorForSubject = (subject: SubjectSummary) => {
    setSubjectEditorError(null);
    setSubjectEditor({
      subjectId: subject.id,
      sourceSubjectId: '',
      name: subject.name ?? '',
      semesterId: subject.semester_id ? String(subject.semester_id) : '',
      date: toIsoDate(subject.start_date ?? null) ?? format(new Date(), 'yyyy-MM-dd'),
      startTime: normalizeTimeForInput(subject.start_time ?? null),
      endTime: normalizeTimeForInput(subject.end_time ?? null),
      room: subject.room ?? subject.classroom ?? '',
      allDay: false,
      color: subject.color ?? subjectColorOptions[0].value,
    });
    setSubjectEditorOpen(true);
  };

  const closeSubjectEditor = () => {
    setSubjectEditorOpen(false);
    setSubjectEditorError(null);
  };

  const closeSubjectCatalog = () => {
    setSubjectCatalogOpen(false);
  };

  const closePendingDeleteDialog = () => {
    if (pendingDeleteBusy) return;
    setPendingDeleteDialog(null);
  };

  const deleteSubjectById = async (id: number) => {
    const clients = apiFallbackClients;
    let lastError: any = null;

    for (const client of clients) {
      try {
        const form = new URLSearchParams();
        form.set('subject_id', String(id));
        form.set('id', String(id));
        await client.post('/subjects/delete', form, {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        return;
      } catch (err: any) {
        lastError = err;
        const status = err?.response?.status;
        if (!isDeleteFallbackStatus(status)) throw err;
      }

      try {
        const form = new URLSearchParams();
        form.set('subject_id', String(id));
        await client.post(`/subjects/${id}/delete`, form, {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        return;
      } catch (err: any) {
        lastError = err;
        const status = err?.response?.status;
        if (!isDeleteFallbackStatus(status)) throw err;
      }

      try {
        const form = new URLSearchParams();
        form.set('_method', 'DELETE');
        form.set('subject_id', String(id));
        await client.post(`/subjects/${id}`, form, {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-HTTP-Method-Override': 'DELETE' },
        });
        return;
      } catch (err: any) {
        lastError = err;
        const status = err?.response?.status;
        if (!isDeleteFallbackStatus(status)) throw err;
      }

      try {
        await client.delete(`/subjects/${id}`);
        return;
      } catch (err: any) {
        lastError = err;
        const status = err?.response?.status;
        if (!isDeleteFallbackStatus(status)) throw err;
      }
    }

    throw lastError ?? new Error('ลบวิชาไม่สำเร็จ');
  };

  const requestDeleteSubject = (subject: SubjectSummary) => {
    setPendingDeleteDialog({
      title: 'ยืนยันการลบ',
      message: `ต้องการลบวิชา "${subject.name}" ใช่หรือไม่?`,
      confirmLabel: 'ลบวิชา',
      action: async () => {
        setDeletingSubjectId(subject.id);
        try {
          await deleteSubjectById(subject.id);
          setSubjects(prev => prev.filter(item => item.id !== subject.id));
          setSchedule(prev =>
            Object.fromEntries(
              Object.entries(prev)
                .map(([day, slots]) => [day, slots.filter(slot => slot.subjectId !== subject.id)] as const)
                .filter(([, slots]) => slots.length > 0)
            )
          );
          emitSubjectsUpdated();
          success('ลบรายวิชาเรียบร้อยแล้ว');
        } catch (err: any) {
          error(err?.response?.data?.message || err?.message || 'ลบวิชาไม่สำเร็จ');
          return;
        } finally {
          setDeletingSubjectId(null);
        }
      },
    });
  };

  const runPendingDeleteAction = async () => {
    if (!pendingDeleteDialog) return;
    setPendingDeleteBusy(true);
    try {
      await pendingDeleteDialog.action();
      setPendingDeleteDialog(null);
    } finally {
      setPendingDeleteBusy(false);
    }
  };

  const getTargetDateForDay = (dayLabel: string, currentDate?: string | null) => {
    if (dayLabel === unscheduledDayLabel) return currentDate ?? format(new Date(), 'yyyy-MM-dd');
    const parsedCurrent = parseScheduleDate(currentDate ?? null);
    if (!parsedCurrent) return resolveNextDateForDayLabel(dayLabel);
    const currentIndex = weekOrder.indexOf(resolveScheduleDayLabel(format(parsedCurrent, 'yyyy-MM-dd')));
    const targetIndex = weekOrder.indexOf(dayLabel);
    if (currentIndex < 0 || targetIndex < 0) return resolveNextDateForDayLabel(dayLabel);
    const shifted = new Date(parsedCurrent);
    shifted.setDate(parsedCurrent.getDate() + (targetIndex - currentIndex));
    return format(shifted, 'yyyy-MM-dd');
  };

  const hasScheduleConflict = (
    dayLabel: string,
    candidate: { startTime?: string | null; endTime?: string | null; allDay?: boolean },
    ignoreSlot?: ScheduleSlot | null
  ) => {
    const slots = scheduleDisplayByDay[dayLabel] ?? [];
    if (candidate.allDay) return slots.some(slot => !shouldIgnoreConflictSlot(slot, ignoreSlot));

    const candidateStart = parseTimeToMinutes(candidate.startTime);
    if (!Number.isFinite(candidateStart)) return false;
    const candidateEndRaw = parseTimeToMinutes(candidate.endTime);
    const candidateEnd = Number.isFinite(candidateEndRaw) && candidateEndRaw > candidateStart ? candidateEndRaw : candidateStart + 60;

    return slots.some(slot => {
      if (shouldIgnoreConflictSlot(slot, ignoreSlot)) return false;
      if (slot.allDay) return true;
      const slotStart = parseTimeToMinutes(slot.startTime);
      if (!Number.isFinite(slotStart)) return false;
      const slotEndRaw = parseTimeToMinutes(slot.endTime);
      const slotEnd = Number.isFinite(slotEndRaw) && slotEndRaw > slotStart ? slotEndRaw : slotStart + 60;
      return candidateStart < slotEnd && candidateEnd > slotStart;
    });
  };

  const resolveDropIndexForPersist = (
    targetDay: string,
    targetIndex: number,
    sourceDraggingSlot?: DraggingSlotState | null
  ) => {
    const source = sourceDraggingSlot ?? draggingSlotRef.current ?? draggingSlot;
    if (!source || source.day !== targetDay) return targetIndex;
    if (targetIndex <= source.index) return targetIndex;
    return Math.max(targetIndex - 1, 0);
  };

  const updateDropPreviewFromPointer = (
    dayLabel: string,
    clientX: number,
    container: HTMLDivElement,
    slotCount: number
  ) => {
    const rect = container.getBoundingClientRect();
    const relativeX = clientX - rect.left + container.scrollLeft;
    const step = scheduleCardWidth + scheduleCardGap;
    const nextIndex = Math.max(0, Math.min(slotCount, Math.floor((relativeX + scheduleCardGap / 2) / step)));
    setDropPreview(prev => (prev?.day === dayLabel && prev.index === nextIndex ? prev : { day: dayLabel, index: nextIndex }));
  };

  const resetDragState = () => {
    dropCommittingRef.current = false;
    draggingSlotRef.current = null;
    draggingSlotDataRef.current = null;
    dropPreviewRef.current = null;
    setDragPointer(null);
    setDropPreview(null);
    setDraggingSlot(null);
  };

  const replaceScheduleSlot = (
    slot: ScheduleSlot,
    patch: Partial<ScheduleSlot>,
    placement?: { day: string; index: number }
  ) => {
    const updatedSlot: ScheduleSlot = { ...slot, ...patch };
    setSchedule(prev => {
      const next: Record<string, ScheduleSlot[]> = {};
      Object.entries(prev).forEach(([day, slots]) => {
        const filtered = slots.filter(item => !isSameSlotIdentity(item, slot));
        if (filtered.length > 0) next[day] = filtered;
      });
      const nextDay = resolveScheduleDayLabel(updatedSlot.date);
      const nextDaySlots = [...(next[nextDay] ?? [])];
      const insertedSlots = splitScheduleSlotByHour(updatedSlot);
      const insertionIndex = placement?.day === nextDay
        ? Math.min(Math.max(placement.index, 0), nextDaySlots.length)
        : nextDaySlots.length;
      nextDaySlots.splice(insertionIndex, 0, ...insertedSlots);
      next[nextDay] = reindexScheduleSlots(nextDaySlots);
      Object.keys(next).forEach(day => {
        next[day] = reindexScheduleSlots(next[day]);
      });
      return next;
    });
  };

  const persistScheduleSlotUpdate = async (
    slot: ScheduleSlot,
    patch: {
      date: string;
      startTime?: string | null;
      endTime?: string | null;
      room?: string | null;
      subjectId?: number | null;
      subject?: string | null;
      allDay: boolean;
      color?: string | null;
    },
    placement?: { day: string; index: number }
  ) => {
    const startTime = patch.allDay ? '00:00:00' : normalizeTimeInput(patch.startTime);
    const endTime = patch.allDay ? null : normalizeTimeInput(patch.endTime);
    const startDateTime = `${patch.date} ${startTime ?? '00:00:00'}`;
    const endDateTime = endTime ? `${patch.date} ${endTime}` : null;

    let nextEventId = slot.eventId ?? null;
    if (slot.subjectId && slot.source === 'subject' && !slot.eventId) {
      await updateSubjectSchedule(
        slot.subjectId,
        slot.subject,
        patch.date,
        patch.allDay ? null : startTime,
        patch.allDay ? null : endTime,
        patch.room ?? slot.room ?? null,
        patch.color ?? slot.color ?? null
      );
    } else if (slot.eventId) {
      await api.put(`/calendar-events/${slot.eventId}`, {
        title: patch.subject ?? slot.subject,
        subject_id: patch.subjectId ?? slot.subjectId ?? null,
        start_time: startDateTime,
        end_time: endDateTime,
        all_day: patch.allDay,
        room: patch.room ?? slot.room ?? null,
      });
    } else {
      const response = await api.post('/calendar-events', {
        title: patch.subject ?? slot.subject,
        subject_id: patch.subjectId ?? slot.subjectId ?? null,
        source: 'manual',
        type: 'class',
        all_day: patch.allDay,
        start_time: startDateTime,
        end_time: endDateTime,
        status: 'planned',
        room: patch.room ?? slot.room ?? null,
      });
      const created = response.data?.data ?? response.data;
      if (created?.id) nextEventId = Number(created.id);
    }

    replaceScheduleSlot(
      slot,
      {
        subject: patch.subject ?? slot.subject,
        subjectId: patch.subjectId ?? slot.subjectId ?? null,
        date: patch.date,
        startTime: patch.allDay ? null : startTime,
        endTime: patch.allDay ? null : endTime,
        room: patch.room ?? slot.room ?? null,
        allDay: patch.allDay,
        color: patch.color ?? slot.color ?? null,
        eventId: nextEventId,
        source: slot.subjectId && !nextEventId ? 'subject' : slot.source ?? 'manual',
      },
      placement
    );
  };

  const handleDropSlot = async (
    slot: ScheduleSlot,
    targetDay: string,
    targetIndex: number,
    sourceDraggingSlot?: DraggingSlotState | null
  ) => {
    const targetDate = getTargetDateForDay(targetDay, slot.date);
    const resolvedIndex = resolveDropIndexForPersist(targetDay, targetIndex, sourceDraggingSlot);
    const isSameDayMove = targetDay === resolveScheduleDayLabel(slot.date) && targetDate === slot.date;

    try {
      if (isSameDayMove) {
        replaceScheduleSlot(
          slot,
          {
            date: targetDate,
            startTime: slot.startTime,
            endTime: slot.endTime,
            allDay: slot.allDay ?? false,
          },
          { day: targetDay, index: resolvedIndex }
        );
      } else {
        await persistScheduleSlotUpdate(slot, {
          date: targetDate,
          startTime: slot.startTime,
          endTime: slot.endTime,
          room: slot.room ?? null,
          allDay: slot.allDay ?? false,
        }, { day: targetDay, index: resolvedIndex });
        success('ย้ายวิชาเรียบร้อยแล้ว');
      }
    } catch {
      error('ย้ายวิชาไม่สำเร็จ');
    } finally {
      resetDragState();
    }
  };

  useEffect(() => {
    if (!draggingSlot) return;

    const handleWindowMouseMove = (event: MouseEvent) => {
      setDragPointer(prev => (
        prev
          ? { ...prev, x: event.clientX, y: event.clientY }
          : prev
      ));
    };

    const handleWindowMouseUp = () => {
      if (dropCommittingRef.current) return;
      const draggedSlot = draggingSlotDataRef.current;
      const preview = dropPreviewRef.current;

      if (!draggedSlot || !preview) {
        resetDragState();
        return;
      }

      dropCommittingRef.current = true;
      void handleDropSlot(draggedSlot, preview.day, preview.index, draggingSlotRef.current);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') resetDragState();
    };

    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleWindowMouseUp);
    window.addEventListener('keydown', handleEscape);

    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [draggingSlot, handleDropSlot]);

  const updateSubjectSchedule = async (
    subjectId: number,
    name: string,
    startDate: string | null,
    startTime: string | null,
    endTime: string | null,
    room: string | null,
    color?: string | null,
    semesterId?: string | number | null
  ) => {
    const payload = {
      name,
      semester_id: semesterId ? Number(semesterId) : null,
      start_date: startDate,
      start_time: startTime,
      end_time: endTime,
      room,
      classroom: room,
      color: color ?? null,
    };

    const form = new URLSearchParams();
    form.set('_method', 'PUT');
    form.set('name', name);
    form.set('semester_id', semesterId ? String(semesterId) : '');
    form.set('start_date', startDate ?? '');
    form.set('start_time', startTime ?? '');
    form.set('end_time', endTime ?? '');
    form.set('room', room ?? '');
    form.set('classroom', room ?? '');
    form.set('color', color ?? '');

    const updateWithClient = async (client: typeof api) => {
      try {
        return await client.put(`/subjects/${subjectId}`, payload);
      } catch (err: any) {
        const status = err?.response?.status;
        if (status && status !== 404 && status !== 405) {
          throw err;
        }
        return client.post(`/subjects/${subjectId}`, form, {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
      }
    };

    const clients = apiFallbackClients;
    let lastError: any = null;

    for (const client of clients) {
      try {
        await updateWithClient(client);
        return;
      } catch (err: any) {
        lastError = err;
        const status = err?.response?.status;
        if (status && status !== 404 && status !== 405) {
          throw err;
        }
      }
    }

    throw lastError ?? new Error('บันทึกวันเวลาไม่สำเร็จ');
  };

const deleteCalendarEventWithFallback = async (eventId: number) => {
  // ลองตามลำดับที่ปลอดภัยและเป็นมาตรฐานก่อน
  const tryDelete = async (client: typeof api) => {
    // 1) DELETE /calendar-events/{id}
    try {
      await client.delete(`/calendar-events/${eventId}`);
      return true;
    } catch (err: any) {
      const status = err?.response?.status;
      // ถ้าไม่ใช่ 404/405 ถือว่า error จริง โยนออก
      if (status && status !== 404 && status !== 405) throw err;
    }

    // 2) POST /calendar-events/{id} + _method=DELETE (รองรับบาง backend)
    try {
      const form = new URLSearchParams();
      form.set('_method', 'DELETE');
      await client.post(`/calendar-events/${eventId}`, form, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      return true;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status !== 404 && status !== 405) throw err;
    }

    // 3) POST /calendar-events/{id}/delete
    try {
      await client.post(`/calendar-events/${eventId}/delete`);
      return true;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status !== 404 && status !== 405) throw err;
    }

    // 4) POST /calendar-events/delete {id}
    await client.post('/calendar-events/delete', { id: eventId });
    return true;
  };

  let lastError: any = null;

  for (const client of apiFallbackClients) {
    try {
      await tryDelete(client as any);
      return;
    } catch (err: any) {
      lastError = err;
    }
  }

  throw lastError ?? new Error('ลบรายการไม่สำเร็จ');
};

  const saveScheduleEdit = async () => {
    if (!scheduleEditingSlot) return;
    const selectedSubject = subjects.find(subject => String(subject.id) === scheduleEditForm.subjectId) ?? null;
    const activeSubjectId = selectedSubject?.id ?? scheduleEditingSlot.subjectId ?? null;
    const activeSubjectName = selectedSubject?.name ?? scheduleEditingSlot.subject;
    const activeColor = selectedSubject?.color ?? scheduleEditForm.color;

    if (!activeSubjectId || !activeSubjectName?.trim()) {
      setScheduleEditError('กรุณาเลือกวิชา');
      return;
    }

    const effectiveDate = scheduleEditForm.date || scheduleEditingSlot.date || format(new Date(), 'yyyy-MM-dd');
    if (!effectiveDate) {
      setScheduleEditError('กรุณาเลือกวันที่');
      return;
    }

    const startTime = normalizeTimeInput(scheduleEditForm.startTime);
    if (!startTime) {
      setScheduleEditError('กรุณาระบุเวลาเริ่ม');
      return;
    }
    const endTime = normalizeTimeInput(scheduleEditForm.endTime);
    const nextDay = resolveScheduleDayLabel(effectiveDate);
    const editingSlot = {
      ...scheduleEditingSlot,
      subjectId: activeSubjectId,
      subject: activeSubjectName,
    };
    if (hasScheduleConflict(nextDay, { startTime, endTime, allDay: false }, editingSlot)) {
      setScheduleEditError('มีวิชาอื่นซ้อนในวันเดียวกัน กรุณาเลือกเวลาใหม่');
      return;
    }

    setScheduleSaving(true);
    setScheduleEditError(null);

    try {
      await persistScheduleSlotUpdate(editingSlot, {
        date: effectiveDate,
        startTime,
        endTime,
        room: scheduleEditForm.room.trim() || null,
        subjectId: activeSubjectId,
        subject: activeSubjectName,
        allDay: false,
        color: activeColor,
      });

      closeScheduleEditor();
    } catch (err: any) {
      setScheduleEditError(err?.response?.data?.message ?? 'บันทึกวันเวลาไม่สำเร็จ');
    } finally {
      setScheduleSaving(false);
    }
  };

  const deleteScheduleEvent = async (eventId: number) => {
    try {
      await deleteCalendarEventWithFallback(eventId);

      setSchedule(prev => {
        let removed = false;
        const next: Record<string, ScheduleSlot[]> = {};

        Object.entries(prev).forEach(([day, slots]) => {
          const filtered = slots.filter(slot => slot.eventId !== eventId);
          if (filtered.length !== slots.length) {
            removed = true;
          }
          if (filtered.length > 0) {
            next[day] = reindexScheduleSlots(filtered);
          }
        });

        return removed ? next : prev;
      });
    } catch {
      error('ลบรายการไม่สำเร็จ');
    }
  };

  const deleteScheduleSlot = (slot: ScheduleSlot) => {
    setPendingDeleteDialog({
      title: 'ยืนยันการลบ',
      message: `ต้องการลบคาบ "${slot.subject}" ใช่หรือไม่?`,
      confirmLabel: 'ลบคาบ',
      action: async () => {
        const slotKey = getSlotKey(slot);
        setDeletingSlotKey(slotKey);

        try {
          if (slot.eventId) {
            await deleteScheduleEvent(slot.eventId);
            return;
          }

          if (slot.subjectId && slot.source === 'subject') {
            await updateSubjectSchedule(slot.subjectId, slot.subject, null, null, null, null, slot.color ?? null);
            setSchedule(prev => {
              const next: Record<string, ScheduleSlot[]> = {};
              Object.entries(prev).forEach(([day, slots]) => {
                const filtered = slots.filter(item => !(item.subjectId === slot.subjectId && item.source === 'subject'));
                if (filtered.length > 0) next[day] = reindexScheduleSlots(filtered);
              });
              return next;
            });
          }
        } catch {
          error('ลบคาบไม่สำเร็จ');
        } finally {
          setDeletingSlotKey(null);
        }
      },
    });
  };

  const saveSubjectEditor = async () => {
    const name = subjectEditor.name.trim();
    if (!name) {
      setSubjectEditorError('กรุณากรอกชื่อวิชา');
      return;
    }

    if (!subjectEditor.semesterId) {
      setSubjectEditorError('กรุณาเลือกภาคเรียน');
      return;
    }

    const startDate = subjectEditor.date?.trim() || null;
    const startTime = subjectEditor.startTime?.trim() ? normalizeTimeInput(subjectEditor.startTime) : null;
    const endTime = subjectEditor.endTime?.trim() ? normalizeTimeInput(subjectEditor.endTime) : null;

    if ((startTime || endTime) && !startDate) {
      setSubjectEditorError('กรุณาเลือกวันที่เริ่มเรียน');
      return;
    }

    if (endTime && !startTime) {
      setSubjectEditorError('กรุณาระบุเวลาเริ่ม');
      return;
    }

    if (startTime && endTime && parseTimeToMinutes(endTime) <= parseTimeToMinutes(startTime)) {
      setSubjectEditorError('เวลาเลิกต้องช้ากว่าเวลาเริ่ม');
      return;
    }

    setSubjectEditorSaving(true);
    setSubjectEditorError(null);

    try {
      if (subjectEditor.subjectId) {
        const editingSubjectId = subjectEditor.subjectId;
        const semesterId = Number(subjectEditor.semesterId);
        const semesterChoice = semesterChoices.find(choice => choice.semester_id === semesterId);
        const room = subjectEditor.room.trim() || null;
        await updateSubjectSchedule(editingSubjectId, name, startDate, startTime, endTime, room, subjectEditor.color, semesterId);

        setSubjects(prev => prev.map(subject => (
          subject.id === editingSubjectId
            ? {
                ...subject,
                name,
                room,
                classroom: room,
                color: subjectEditor.color,
                semester_id: semesterId,
                semester: semesterChoice?.semester ?? subject.semester ?? null,
                academic_year: semesterChoice?.academic_year ?? subject.academic_year ?? null,
                start_date: startDate,
                start_time: startTime,
                end_time: endTime,
              }
            : subject
        )));
        emitSubjectsUpdated();
        setSchedule(prev => {
          const next: Record<string, ScheduleSlot[]> = {};
          Object.entries(prev).forEach(([day, slots]) => {
            const mapped = slots.map(slot => (
              slot.subjectId === editingSubjectId
                ? { ...slot, subject: name, color: subjectEditor.color }
                : slot
            ));
            if (mapped.length > 0) next[day] = reindexScheduleSlots(mapped);
          });
          return next;
        });
      } else {
        const semesterId = Number(subjectEditor.semesterId);
        const room = subjectEditor.room.trim() || null;
        const response = await api.post('/subjects', {
          semester_id: semesterId,
          name,
          description: null,
          start_date: startDate,
          start_time: startTime,
          end_time: endTime,
          room,
          classroom: room,
          color: subjectEditor.color,
          target_hours: null,
        });
        const created = response.data?.data ?? response.data;
        const createdId = Number(created?.id);
        const semesterChoice = semesterChoices.find(choice => choice.semester_id === semesterId);
        const createdSemester = toNumberOrNull(created?.semester) ?? semesterChoice?.semester ?? null;
        const createdAcademicYear = toNumberOrNull(created?.academic_year) ?? semesterChoice?.academic_year ?? null;

        if (Number.isFinite(createdId)) {
          setSubjects(prev => [
            {
              id: createdId,
              name,
              room,
              classroom: room,
              semester_id: semesterId,
              semester: createdSemester,
              academic_year: createdAcademicYear,
              color: subjectEditor.color,
              start_date: startDate,
              start_time: startTime,
              end_time: endTime,
            },
            ...prev
          ]);
          emitSubjectsUpdated();
        }
      }

      closeSubjectEditor();
    } catch (error: any) {
      setSubjectEditorError(error?.response?.data?.message ?? 'บันทึกวิชาไม่สำเร็จ');
    } finally {
      setSubjectEditorSaving(false);
    }
  };

  useEffect(() => {
    if (!user?.id) return;

    const myReqId = ++reqIdRef.current;

    api
      .get<StudyNotification[]>('/notifications')
      .then(res => {
        if (reqIdRef.current !== myReqId) return;
        setNotifications(res.data ?? []);
      })
      .catch(() => {
        if (reqIdRef.current !== myReqId) return;
      });
  }, [user?.id]);

  useEffect(() => {
    const raw = localStorage.getItem(lastQuizResultKey);
    if (raw) {
      try {
        setLastQuizResult(JSON.parse(raw));
      } catch {
        setLastQuizResult(null);
      }
    }
  }, [lastQuizResultKey]);

  const selectedSemesterOption = semesterOptions.find(option => option.key === selectedSemesterKey) ?? semesterOptions[0];

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center rounded-3xl surface-2 text-muted">
        กำลังโหลดข้อมูล...
      </div>
    );
  }

  return (
    <div className="space-y-6 sm:space-y-8">
      {/* ... ส่วนบนเหมือนเดิมของคุณทั้งหมด ... */}

      <section
        className="timetable-shell rounded-none border-0 bg-transparent text-[color:var(--text)] shadow-none sm:rounded-[28px] sm:border sm:border-slate-200 sm:bg-white sm:shadow-none"
      >
        <div className="border-b border-slate-100 px-5 py-5 sm:px-6 sm:py-6 md:px-8">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h2 className="timetable-title text-[2.1rem] font-extrabold tracking-tight text-slate-900 sm:text-3xl">ตารางเรียน</h2>
              <p className="mt-1 text-xs font-medium text-slate-500 sm:text-sm">{selectedSemesterOption?.label ?? 'ทุกเทอม'}</p>
            </div>

            <div className="flex flex-wrap items-center gap-3 lg:justify-end">
              <div className="timetable-select rounded-full border border-slate-200 bg-slate-50 px-1.5 py-0.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
                <select
                  value={selectedSemesterKey}
                  onChange={event => setSelectedSemesterKey(event.target.value)}
                  className="bg-transparent px-4 py-2.5 text-sm font-semibold text-slate-800 outline-none"
                >
                  {semesterOptions.map(option => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="timetable-print hidden h-11 w-11 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-slate-600 shadow-none transition hover:bg-slate-100 hover:text-slate-900 md:flex"
                  title="พิมพ์"
                  aria-label="พิมพ์ตารางเรียน"
                >
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M7 8V4h10v4" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M7 14h10v6H7z" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>

                {scheduleHidden ? (
                  <button
                    type="button"
                    onClick={showScheduleView}
                    className="rounded-full border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-100"
                  >
                    แสดงตาราง
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        <div className="px-5 py-5 sm:px-6 md:px-8">
          <div
            className="rounded-[1.25rem] border p-4 sm:p-5"
            style={{
              borderColor: 'rgba(var(--accent-rgb), 0.22)',
              background: `linear-gradient(180deg, rgba(var(--accent-rgb), 0.07) 0%, rgba(var(--accent-rgb), 0.035) 100%)`,
            }}
          >
            <div className="relative">
              <div className={`min-w-0 ${filteredSubjects.length > 0 ? 'pr-36' : 'pr-14'}`}>
                <h3 className="text-base font-bold text-[color:var(--text)] sm:text-lg">จัดการรายวิชาในระบบ</h3>
                <p className="mt-1 text-xs text-[color:var(--muted)] sm:text-sm">รายวิชาที่พร้อมนำไปจัดตารางเรียน</p>
              </div>
              <div className="absolute right-0 top-0 flex items-center gap-2">
                {filteredSubjects.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => setSubjectCatalogOpen(true)}
                    className="inline-flex h-10 items-center justify-center rounded-xl border px-3 text-xs font-semibold shadow-sm transition hover:opacity-80 sm:px-3.5 sm:text-sm"
                    style={{ borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
                  >
                    ดูทั้งหมด
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={openSubjectEditorForCreate}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
                  style={{
                    background: 'var(--accent)',
                    color: 'var(--on-accent)',
                    WebkitTextFillColor: 'var(--on-accent)',
                  }}
                  title="เพิ่มวิชา"
                  aria-label="เพิ่มวิชา"
                >
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
                    <path d="M12 5v14M5 12h14" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            </div>

            <div className="mt-4">
              {filteredSubjects.length > 0 ? (
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {filteredSubjects.map(subject => {
                    return (
                      <article
                        key={subject.id}
                        className="min-w-[210px] max-w-[240px] shrink-0 rounded-[1.25rem] border border-white/80 bg-white/90 px-4 py-3.5 shadow-sm"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-bold text-slate-800">{subject.name}</p>
                            <p className="mt-1 text-xs text-slate-500">
                              {formatSemesterLabel(subject.semester, subject.academic_year)
                                ? `เทอม ${formatSemesterLabel(subject.semester, subject.academic_year)}`
                                : 'ยังไม่ระบุเทอม'}
                            </p>
                          </div>
                          <span
                            className="mt-0.5 inline-flex h-3 w-3 rounded-full"
                            style={{ backgroundColor: resolveSubjectColor(subject.color) }}
                          />
                        </div>
                        <div className="mt-3 space-y-1.5 text-xs text-slate-500">
                          <p>พร้อมนำไปจัดลงตารางเรียน</p>
                          <p>{subject.study_log_count ?? 0} บันทึกการเรียน</p>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div
                  className="flex flex-col items-center rounded-2xl border border-dashed px-4 py-6 text-center text-sm text-[color:var(--muted)]"
                  style={{ borderColor: 'rgba(var(--accent-rgb), 0.22)', background: 'var(--surface)' }}
                >
                  <span>ยังไม่มีรายวิชาในภาคเรียนนี้</span>
                  <button
                    type="button"
                    onClick={openSubjectEditorForCreate}
                    className="mt-3 inline-flex h-10 w-10 items-center justify-center rounded-full shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
                    style={{
                      background: 'var(--accent)',
                      color: 'var(--on-accent)',
                      WebkitTextFillColor: 'var(--on-accent)',
                    }}
                    title="เพิ่มวิชาแรก"
                    aria-label="เพิ่มวิชาแรก"
                  >
                    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
                      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {scheduleHidden ? (
          <div className="mx-5 mb-5 rounded-2xl border border-dashed px-5 py-5 text-center text-sm text-[color:var(--muted)] sm:mx-6 md:mx-8" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
            ตารางสอนถูกล้าง/ซ่อนไว้แล้ว (กด “แสดงตาราง” เพื่อดูอีกครั้ง)
          </div>
        ) : (
          <div className="bg-transparent px-5 pb-32 sm:px-6 md:px-8 md:pb-16">
            <div className="space-y-8">
              {displayWeekOrder.map(day => {
                  const daySlots = scheduleDisplayByDay[day] ?? [];
                  const dayDistinctSubjects = countDistinctSubjects(daySlots);
                  const dayTone = scheduleDayToneMap[day] ?? scheduleDayToneMap.default;
                  const nextPeriod = resolveNextPeriod(daySlots);

                  return (
                    <div
                      key={`schedule-day-${day}`}
                      data-day={day}
                      ref={element => {
                        daySectionRefs.current[day] = element;
                      }}
                      className="relative scroll-mt-28"
                    >
                      <div className="mb-3 flex items-center gap-3">
                        <h3 className="text-[1.9rem] font-extrabold tracking-tight sm:text-[2.1rem]" style={{ color: dayTone.accent }}>
                          {day}
                        </h3>
                        <span
                          className="inline-flex items-center rounded-md px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.16em]"
                          style={{
                            backgroundColor: hexToRgba(dayTone.accent, 0.14),
                            color: dayTone.accent,
                          }}
                        >
                          {dayDistinctSubjects} classes
                        </span>
                      </div>

                      <div className="space-y-3 pl-1">
                        {daySlots.length > 0 ? daySlots.map((slot, slotIndex) => {
                          const accent = resolveScheduleAccent(slot);
                          const isContinuationSegment = (slot.hourSegment ?? 1) > 1;
                          const isOwner = Number(slot.ownerUserId ?? user?.id) === Number(user?.id);
                          const canManage = user?.role === 'admin' || isOwner;
                          const canManagePrimary = canManage && !isContinuationSegment;
                          const slotKey = getSlotKey(slot);
                          const warning = scheduleWarnings.get(slotKey);
                          const subjectFromMap = slot.subjectId
                            ? subjectNameById.get(Number(slot.subjectId)) ?? null
                            : null;
                          const displaySubject = resolveSubjectLabel(subjectFromMap, slot.subject);
                          const roomLabel = slot.room?.trim() || 'ไม่ระบุห้อง';

                          return (
                            <div
                              key={`schedule-stack-${day}-${slotKey}-${slotIndex}`}
                              className="group rounded-[1.35rem] border border-slate-100 bg-white p-4 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.05)] transition-all hover:border-slate-200"
                            >
                              <div className="flex gap-4">
                                <div className="flex min-w-[68px] flex-col items-center justify-center border-r border-slate-100 pr-3">
                                  <span className="text-[14px] font-extrabold leading-none text-slate-700 sm:text-[15px]">
                                    {slot.allDay ? 'ทั้งวัน' : normalizeTimeForInput(slot.startTime) || '--:--'}
                                  </span>
                                  <span className="mt-1 text-[10px] font-medium text-slate-400 sm:text-[11px]">
                                    {slot.allDay ? 'ไม่มีเวลาเลิก' : normalizeTimeForInput(slot.endTime) || '--:--'}
                                  </span>
                                </div>

                                <div className="min-w-0 flex-1 py-0.5">
                                  <div className="mb-1.5 flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <div className="flex items-center gap-2">
                                        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: warning ? '#f43f5e' : accent }} />
                                        <h4 className="truncate text-sm font-bold leading-none text-slate-800">{displaySubject || 'ไม่ระบุวิชา'}</h4>
                                      </div>
                                      <div className="ml-4 mt-2 flex items-center gap-1.5 text-[10px] text-slate-500">
                                        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-slate-400" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                          <path d="M12 21s-6-4.35-6-10a6 6 0 1 1 12 0c0 5.65-6 10-6 10Z" />
                                          <circle cx="12" cy="11" r="2.5" />
                                        </svg>
                                        <span>{roomLabel}</span>
                                      </div>
                                      <div className="ml-4 mt-1.5 flex items-center gap-2 text-[10px] text-slate-400">
                                        <span>{slot.subjectId ? 'เชื่อมกับวิชาในระบบ' : 'รายการทั่วไป'}</span>
                                      </div>
                                    </div>

                                    {canManagePrimary ? (
                                      <div className="flex items-center gap-1">
                                        <button
                                          type="button"
                                          onClick={() => openScheduleEditor(slot)}
                                          className="rounded-lg p-1.5 text-amber-500 transition-colors hover:bg-amber-50 hover:text-amber-600"
                                          title="แก้ไขวิชา"
                                        >
                                          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                            <path d="M12 20h9" />
                                            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                                          </svg>
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => deleteScheduleSlot(slot)}
                                          disabled={deletingSlotKey === slotKey}
                                          className="rounded-lg p-1.5 text-red-500 transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                                          title="ลบวิชา"
                                        >
                                          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                            <path d="M3 6h18" />
                                            <path d="M8 6V4h8v2" />
                                            <path d="m19 6-1 14H6L5 6" />
                                            <path d="M10 11v6" />
                                            <path d="M14 11v6" />
                                          </svg>
                                        </button>
                                      </div>
                                    ) : null}
                                  </div>

                                  {warning ? (
                                    <div className="ml-4 mt-2 rounded-xl border border-rose-200 bg-rose-50 px-2.5 py-2 text-[11px] font-semibold text-rose-500">
                                      {warning.message}
                                    </div>
                                  ) : null}
                                </div>
                              </div>
                            </div>
                          );
                        }) : (
                          <div className="mb-3 mt-1 h-0.5 w-8 rounded-full bg-slate-200" />
                        )}

                        <button
                          type="button"
                          onClick={() => openScheduleEditorForCreate(day, nextPeriod)}
                          className="flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed py-3 text-xs font-bold text-[color:var(--muted)] transition-colors hover:text-[color:var(--text)]"
                          style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
                        >
                          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M12 5v14" strokeLinecap="round" />
                            <path d="M5 12h14" strokeLinecap="round" />
                          </svg>
                          เพิ่มวิชาเรียน
                        </button>
                      </div>
                    </div>
                  );
                })}
            </div>

            <div className="fixed bottom-[5.75rem] left-0 right-0 z-30 flex px-1 md:hidden">
              <div
                className="flex w-full items-center justify-between gap-3 overflow-x-auto border-t px-4 py-4 shadow-[0_-4px_20px_rgba(0,0,0,0.06)] backdrop-blur-md"
                style={{ borderColor: 'var(--border)', background: 'color-mix(in srgb, var(--surface) 96%, transparent)' }}
              >
                {dayNavigationItems.map(item => {
                  const isActive = activeDay === item.day;
                  return (
                    <button
                      key={`schedule-nav-${item.day}`}
                      type="button"
                      onClick={() => scrollToDay(item.day)}
                      className={`relative flex h-10 w-10 flex-shrink-0 select-none items-center justify-center rounded-full outline-none transition-all duration-300 ease-[cubic-bezier(0.175,0.885,0.32,1.275)] ${
                        isActive
                          ? 'scale-110 -translate-y-1.5 text-white shadow-md active:scale-90'
                          : 'hover:-translate-y-0.5 hover:scale-110 active:scale-75'
                      }`}
                      style={
                        isActive
                          ? { backgroundColor: item.accent, color: 'var(--on-accent)' }
                          : { backgroundColor: 'var(--surface-2)', color: 'var(--text)' }
                      }
                      title={`ไปวัน${item.day}`}
                    >
                      <span className={isActive ? 'text-[14px] font-bold' : 'text-[13px] font-medium'}>
                        {item.shortName}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* ... ส่วนอื่นของไฟล์เดิมคุณต่อได้เหมือนเดิม ... */}
      {subjectCatalogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 py-6">
          <div className="surface w-full max-w-2xl rounded-3xl border border-slate-200 bg-white p-5 shadow-glow">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.35em] text-emerald-600">Subjects</p>
                <h3 className="mt-2 text-lg font-semibold text-slate-900">รายวิชาทั้งหมด</h3>
               
              </div>
              <button
                type="button"
                onClick={closeSubjectCatalog}
                className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-500 hover:text-slate-800"
              >
                ปิด
              </button>
            </div>

            <div className="mt-4 max-h-[68vh] overflow-y-auto pr-1">
              <div className="grid grid-cols-2 gap-3">
                {filteredSubjects.map(subject => (
                  <article
                    key={`subject-catalog-${subject.id}`}
                    className="rounded-[1.25rem] border border-slate-100 bg-[linear-gradient(180deg,#ffffff_0%,#f8fbff_100%)] px-4 py-4 shadow-sm"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-bold text-slate-800">{subject.name}</p>
                        <p className="mt-1 text-xs text-slate-500">
                          {formatSemesterLabel(subject.semester, subject.academic_year)
                            ? `เทอม ${formatSemesterLabel(subject.semester, subject.academic_year)}`
                            : 'ยังไม่ระบุเทอม'}
                        </p>
                      </div>
                      <span
                        className="mt-0.5 inline-flex h-3.5 w-3.5 shrink-0 rounded-full"
                        style={{ backgroundColor: resolveSubjectColor(subject.color) }}
                      />
                    </div>
                    <div className="mt-3 space-y-1.5 text-xs text-slate-500">
                      <p>พร้อมนำไปจัดลงตารางเรียน</p>
                      <p>{subject.study_log_count ?? 0} บันทึกการเรียน</p>
                    </div>
                    <div className="mt-4 flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={event => {
                          event.stopPropagation();
                          openSubjectEditorForSubject(subject);
                        }}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
                        title="แก้ไขวิชา"
                        aria-label={`แก้ไขวิชา ${subject.name}`}
                      >
                        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M12 20h9" />
                          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                        </svg>
                        <span>แก้ไข</span>
                      </button>
                      <button
                        type="button"
                        onClick={event => {
                          event.stopPropagation();
                          requestDeleteSubject(subject);
                        }}
                        disabled={deletingSubjectId === subject.id || pendingDeleteBusy}
                        className="inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-600 transition hover:bg-rose-100 disabled:opacity-50"
                        title="ลบวิชา"
                        aria-label={`ลบวิชา ${subject.name}`}
                      >
                        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M3 6h18" />
                          <path d="M8 6V4h8v2" />
                          <path d="m19 6-1 14H6L5 6" />
                          <path d="M10 11v6" />
                          <path d="M14 11v6" />
                        </svg>
                        <span>{deletingSubjectId === subject.id && pendingDeleteBusy ? 'กำลังลบ...' : 'ลบวิชา'}</span>
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {subjectEditorOpen && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/55 px-4 py-2 backdrop-blur-sm sm:py-4">
          <div className="flex min-h-full items-start justify-center pt-1 sm:pt-2">
          <div
            className="surface my-2 w-full max-w-lg overflow-hidden rounded-[1.75rem] border p-0 shadow-[0_28px_80px_rgba(15,23,42,0.30)]"
            style={{ borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
          >
            <div
              className="h-1.5 w-full"
              style={{ background: 'linear-gradient(90deg, var(--accent), rgba(var(--accent-rgb),0.42))' }}
            />
            <div className="max-h-[calc(100dvh-4.5rem)] overflow-y-auto p-5 sm:max-h-[calc(100dvh-2rem)] sm:p-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <span
                  className="inline-flex rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-[0.2em]"
                  style={{ background: 'rgba(var(--accent-rgb),0.10)', color: 'var(--accent)' }}
                >
                  Subject
                </span>
                <h3 className="mt-3 text-xl font-bold text-[color:var(--text)]">{subjectEditor.subjectId ? 'แก้ไขวิชา' : 'เพิ่มวิชา'}</h3>
                <p className="mt-1 text-sm leading-6 text-[color:var(--muted)]">สร้างรายวิชาเพื่อใช้จัดตารางเรียนและบันทึกการเรียน</p>
              </div>
            </div>

            {subjectEditorError && (
              <div className="mt-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2.5 text-xs text-rose-500">
                {subjectEditorError}
              </div>
            )}

            <div className="mt-5 space-y-4 pb-28 text-sm sm:pb-20">
              <div>
                <label className="mb-2 block text-xs font-semibold text-[color:var(--muted)]">ภาคเรียน</label>
                <select
                  value={subjectEditor.semesterId}
                  onChange={event => setSubjectEditor(prev => ({ ...prev, semesterId: event.target.value }))}
                  className="w-full rounded-xl border px-3.5 py-3 text-[color:var(--text)] shadow-sm outline-none transition focus:ring-2"
                  style={{
                    borderColor: 'var(--border)',
                    background: 'var(--surface-2)',
                    ['--tw-ring-color' as string]: 'rgba(var(--accent-rgb),0.24)',
                  }}
                >
                  <option value="">เลือกภาคเรียน</option>
                  {semesterChoices.map(choice => (
                    <option key={choice.semester_id} value={choice.semester_id}>
                      {choice.label}
                    </option>
                  ))}
                </select>
                <div
                  className="mt-3 rounded-xl border p-3"
                  style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}
                >
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--muted)]">เพิ่มเทอมเอง</p>
                  <div className="mt-3 grid gap-2 sm:grid-cols-[120px,minmax(0,1fr),120px]">
                    <select
                      value={newSemester.semester}
                      onChange={event => setNewSemester(prev => ({ ...prev, semester: event.target.value }))}
                      className="w-full rounded-xl border px-3 py-3 text-[color:var(--text)] shadow-sm outline-none transition focus:ring-2"
                      style={{
                        borderColor: 'var(--border)',
                        background: 'var(--surface)',
                        ['--tw-ring-color' as string]: 'rgba(var(--accent-rgb),0.24)',
                      }}
                    >
                      <option value="1">เทอม 1</option>
                      <option value="2">เทอม 2</option>
                      <option value="3">เทอม 3</option>
                    </select>
                    <input
                      value={newSemester.academic_year}
                      onChange={event => setNewSemester(prev => ({ ...prev, academic_year: event.target.value }))}
                      inputMode="numeric"
                      placeholder="ปีการศึกษา เช่น 2568"
                      className="w-full rounded-xl border px-3 py-3 text-[color:var(--text)] shadow-sm outline-none transition placeholder:text-[color:var(--muted)] focus:ring-2"
                      style={{
                        borderColor: 'var(--border)',
                        background: 'var(--surface)',
                        ['--tw-ring-color' as string]: 'rgba(var(--accent-rgb),0.24)',
                      }}
                    />
                    <button
                      type="button"
                      onClick={createSemester}
                      disabled={isCreatingSemester}
                      className="rounded-xl border px-4 py-3 text-sm font-semibold transition hover:opacity-90 disabled:opacity-60"
                      style={{
                        borderColor: 'rgba(var(--accent-rgb),0.18)',
                        background: 'rgba(var(--accent-rgb),0.10)',
                        color: 'var(--accent)',
                      }}
                    >
                      {isCreatingSemester ? 'กำลังเพิ่ม...' : 'เพิ่มเทอม'}
                    </button>
                  </div>
                  {createSemesterError ? (
                    <p className="mt-2 text-xs text-rose-500">{createSemesterError}</p>
                  ) : (
                    <p className="mt-2 text-xs text-[color:var(--muted)]">สร้างแล้วระบบจะเลือกเทอมให้อัตโนมัติ</p>
                  )}
                </div>
              </div>

              <div>
                <label className="mb-2 block text-xs font-semibold text-[color:var(--muted)]">ชื่อวิชา</label>
                <input
                  type="text"
                  value={subjectEditor.name}
                  onChange={event => setSubjectEditor(prev => ({ ...prev, name: event.target.value }))}
                  placeholder="เช่น คณิตศาสตร์"
                  className="w-full rounded-xl border px-3.5 py-3 text-[color:var(--text)] shadow-sm outline-none transition placeholder:text-[color:var(--muted)] focus:ring-2"
                  style={{
                    borderColor: 'var(--border)',
                    background: 'var(--surface-2)',
                    ['--tw-ring-color' as string]: 'rgba(var(--accent-rgb),0.24)',
                  }}
                />
              </div>

              <div>
                <label className="mb-2 block text-xs font-semibold text-[color:var(--muted)]">ห้องเรียน</label>
                <input
                  type="text"
                  value={subjectEditor.room}
                  onChange={event => setSubjectEditor(prev => ({ ...prev, room: event.target.value }))}
                  placeholder="เช่น SCB 2401"
                  className="w-full rounded-xl border px-3.5 py-3 text-[color:var(--text)] shadow-sm outline-none transition placeholder:text-[color:var(--muted)] focus:ring-2"
                  style={{
                    borderColor: 'var(--border)',
                    background: 'var(--surface-2)',
                    ['--tw-ring-color' as string]: 'rgba(var(--accent-rgb),0.24)',
                  }}
                />
              </div>

              <div>
                <label className="mb-2 block text-xs font-semibold text-[color:var(--muted)]">วันที่เริ่มเรียน</label>
                <div className="relative">
                  <input
                    type="text"
                    inputMode="numeric"
                    placeholder="dd/mm/yyyy"
                    value={toDisplayDateGregorian(subjectEditor.date) ?? subjectEditor.date}
                    onChange={event => setSubjectEditor(prev => ({ ...prev, date: event.target.value }))}
                    className="w-full rounded-xl border px-3.5 py-3 pr-11 text-[color:var(--text)] shadow-sm outline-none transition placeholder:text-[color:var(--muted)] focus:ring-2"
                    style={{
                      borderColor: 'var(--border)',
                      background: 'var(--surface-2)',
                      ['--tw-ring-color' as string]: 'rgba(var(--accent-rgb),0.24)',
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const picker = subjectEditorDatePickerRef.current;
                      if (!picker) return;
                      if (typeof (picker as any).showPicker === 'function') (picker as any).showPicker();
                      else picker.click();
                    }}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[color:var(--muted)] hover:text-[color:var(--text)]"
                    aria-label="เลือกวันที่เริ่มเรียน"
                  >
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none">
                      <rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.6" />
                      <path d="M8 3v4M16 3v4M3 9h18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    </svg>
                  </button>
                  <input
                    ref={subjectEditorDatePickerRef}
                    type="date"
                    value={toIsoDate(subjectEditor.date) ?? ''}
                    onChange={event => {
                      const nextIso = event.target.value;
                      setSubjectEditor(prev => ({ ...prev, date: nextIso || prev.date }));
                    }}
                    className="absolute inset-0 opacity-0 pointer-events-none"
                    tabIndex={-1}
                    aria-hidden="true"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-2 block text-xs font-semibold text-[color:var(--muted)]">เวลาเริ่ม</label>
                  <input
                    type="time"
                    step={300}
                    value={subjectEditor.startTime}
                    onChange={event => setSubjectEditor(prev => ({ ...prev, startTime: event.target.value }))}
                    className="w-full rounded-xl border px-3.5 py-3 text-[color:var(--text)] shadow-sm outline-none transition focus:ring-2"
                    style={{
                      borderColor: 'var(--border)',
                      background: 'var(--surface-2)',
                      ['--tw-ring-color' as string]: 'rgba(var(--accent-rgb),0.24)',
                    }}
                  />
                </div>
                <div>
                  <label className="mb-2 block text-xs font-semibold text-[color:var(--muted)]">เวลาเลิก</label>
                  <input
                    type="time"
                    step={300}
                    value={subjectEditor.endTime}
                    onChange={event => setSubjectEditor(prev => ({ ...prev, endTime: event.target.value }))}
                    className="w-full rounded-xl border px-3.5 py-3 text-[color:var(--text)] shadow-sm outline-none transition focus:ring-2"
                    style={{
                      borderColor: 'var(--border)',
                      background: 'var(--surface-2)',
                      ['--tw-ring-color' as string]: 'rgba(var(--accent-rgb),0.24)',
                    }}
                  />
                </div>
              </div>

              <div>
                <label className="mb-2 block text-xs font-semibold text-[color:var(--muted)]">สีวิชา</label>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {subjectColorOptions.map(option => {
                    const active = subjectEditor.color === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => setSubjectEditor(prev => ({ ...prev, color: option.value }))}
                        className="rounded-xl border px-3 py-2.5 text-left text-xs font-semibold transition"
                        style={
                          active
                            ? {
                                borderColor: option.value,
                                background: `${option.value}18`,
                                color: 'var(--text)',
                                boxShadow: `0 0 0 1px ${option.value}40 inset`
                              }
                            : {
                                borderColor: 'var(--border)',
                                background: 'var(--surface-2)',
                                color: 'var(--muted)'
                              }
                        }
                      >
                        <span className="flex items-center gap-2">
                          <span className="h-3.5 w-3.5 rounded-full shadow-sm" style={{ backgroundColor: option.value }} />
                          {option.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div
              className="sticky bottom-0 -mx-5 mt-6 flex items-center justify-end gap-2 border-t px-5 py-4 sm:-mx-6 sm:px-6"
              style={{
                borderColor: 'var(--border)',
                background: 'color-mix(in srgb, var(--surface) 94%, transparent)',
                backdropFilter: 'blur(10px)',
                paddingBottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))',
              }}
            >
              <button
                type="button"
                onClick={closeSubjectEditor}
                className="rounded-xl border px-4 py-2.5 text-sm font-semibold transition hover:opacity-75"
                style={{ borderColor: 'var(--border)', background: 'var(--surface-2)', color: 'var(--text)' }}
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={saveSubjectEditor}
                disabled={subjectEditorSaving}
                className="rounded-xl px-5 py-2.5 text-sm font-bold shadow-sm transition hover:-translate-y-0.5 disabled:opacity-60"
                style={{
                  background: 'var(--accent)',
                  color: 'var(--on-accent)',
                  WebkitTextFillColor: 'var(--on-accent)',
                }}
              >
                {subjectEditorSaving ? 'กำลังบันทึก...' : subjectEditor.subjectId ? 'บันทึกวิชา' : 'เพิ่มวิชา'}
              </button>
            </div>
            </div>
          </div>
          </div>
        </div>
      )}

      {scheduleEditingSlot && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 px-4 py-6 backdrop-blur-sm">
          <div
            className="surface w-full max-w-lg overflow-hidden rounded-[1.75rem] border shadow-[0_28px_80px_rgba(15,23,42,0.30)]"
            style={{ borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
          >
            <div className="h-1.5 w-full" style={{ background: 'linear-gradient(90deg,var(--accent),rgba(var(--accent-rgb),0.38))' }} />
            <div className="p-5 sm:p-6">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <span className="inline-flex rounded-full bg-[color:rgba(var(--accent-rgb),0.10)] px-3 py-1 text-[10px] font-bold uppercase tracking-[0.22em] text-[color:var(--accent)]">
                  Schedule
                </span>
                <h3 className="mt-3 text-xl font-bold text-[color:var(--text)]">
                  {scheduleEditingSlot.source === 'draft' ? 'จัดตารางเรียน' : 'แก้ไขคาบเรียน'}
                </h3>
                <p className="mt-1 text-sm leading-6 text-[color:var(--muted)]">
                  {scheduleEditingSlot.source === 'draft'
                    ? 'เลือกวิชาที่มีในระบบมากำหนดเวลาเรียนในตาราง'
                    : scheduleEditingSlot.subject}
                </p>
              </div>
              <button
                type="button"
                onClick={closeScheduleEditor}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border transition hover:opacity-75"
                style={{ borderColor: 'var(--border)', background: 'var(--surface-2)', color: 'var(--muted)' }}
                aria-label="ปิด"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.1">
                  <path d="m6 6 12 12M18 6 6 18" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            {scheduleEditError && (
              <div className="mt-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2.5 text-xs text-rose-500">
                {scheduleEditError}
              </div>
            )}

            <div className="mt-5 space-y-4 text-sm">
              <div>
                <label className="mb-2 block text-xs font-semibold text-[color:var(--muted)]">เลือกวิชา</label>
                <select
                  value={scheduleEditForm.subjectId}
                  onChange={event => {
                    const nextId = event.target.value;
                    const selectedSubject = subjects.find(subject => String(subject.id) === nextId) ?? null;
                    setScheduleEditForm(prev => ({
                      ...prev,
                      subjectId: nextId,
                      color: selectedSubject?.color ?? prev.color,
                    }));
                  }}
                  className="w-full rounded-xl border px-4 py-3 text-[color:var(--text)] shadow-sm outline-none transition focus:border-[color:var(--accent)] focus:ring-4 focus:ring-[color:rgba(var(--accent-rgb),0.10)]"
                  style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}
                >
                  <option value="">-- เลือกวิชา --</option>
                  {subjects.map(subject => (
                    <option key={subject.id} value={subject.id}>
                      {subject.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-2 block text-xs font-semibold text-[color:var(--muted)]">ห้องเรียน</label>
                <input
                  type="text"
                  value={scheduleEditForm.room}
                  onChange={event => setScheduleEditForm(prev => ({ ...prev, room: event.target.value }))}
                  placeholder="เช่น อาคาร 3 ห้อง 305"
                  className="w-full rounded-xl border px-4 py-3 text-[color:var(--text)] shadow-sm outline-none transition placeholder:text-[color:var(--muted)] focus:border-[color:var(--accent)] focus:ring-4 focus:ring-[color:rgba(var(--accent-rgb),0.10)]"
                  style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-2 block text-xs font-semibold text-[color:var(--muted)]">เวลาเริ่ม</label>
                  <input
                    type="time"
                    step={300}
                    value={scheduleEditForm.startTime}
                    onChange={event => setScheduleEditForm(prev => ({ ...prev, startTime: event.target.value }))}
                    disabled={scheduleEditForm.allDay}
                    className="w-full rounded-xl border px-4 py-3 font-mono text-base tabular-nums text-[color:var(--text)] shadow-sm outline-none transition focus:border-[color:var(--accent)] focus:ring-4 focus:ring-[color:rgba(var(--accent-rgb),0.10)] disabled:opacity-50"
                    style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}
                  />
                </div>
                <div>
                  <label className="mb-2 block text-xs font-semibold text-[color:var(--muted)]">เวลาเลิก</label>
                  <input
                    type="time"
                    step={300}
                    value={scheduleEditForm.endTime}
                    onChange={event => setScheduleEditForm(prev => ({ ...prev, endTime: event.target.value }))}
                    disabled={scheduleEditForm.allDay}
                    className="w-full rounded-xl border px-4 py-3 font-mono text-base tabular-nums text-[color:var(--text)] shadow-sm outline-none transition focus:border-[color:var(--accent)] focus:ring-4 focus:ring-[color:rgba(var(--accent-rgb),0.10)] disabled:opacity-50"
                    style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}
                  />
                </div>
              </div>
            </div>

            <div className="mt-6 flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:justify-end" style={{ borderColor: 'var(--border)' }}>
              <button
                type="button"
                onClick={closeScheduleEditor}
                className="rounded-xl border px-5 py-3 text-sm font-semibold transition hover:opacity-75"
                style={{ borderColor: 'var(--border)', background: 'var(--surface-2)', color: 'var(--text)' }}
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={saveScheduleEdit}
                disabled={scheduleSaving}
                className="rounded-xl px-6 py-3 text-sm font-bold shadow-[0_12px_24px_rgba(var(--accent-rgb),0.24)] transition hover:-translate-y-0.5 hover:brightness-105 disabled:opacity-60"
                style={{ background: 'var(--accent)', color: 'var(--on-accent)', WebkitTextFillColor: 'var(--on-accent)' }}
              >
                {scheduleSaving ? 'กำลังบันทึก...' : 'บันทึกการเปลี่ยนแปลง'}
              </button>
            </div>
            </div>
          </div>
        </div>
      )}

      {pendingDeleteDialog ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 px-4 py-6">
          <div className="w-full max-w-md rounded-3xl border border-rose-100 bg-white p-5 shadow-[0_20px_80px_rgba(15,23,42,0.22)]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.35em] text-rose-500">Delete</p>
                <h3 className="mt-2 text-lg font-semibold text-slate-900">{pendingDeleteDialog.title}</h3>
                <p className="mt-1 text-sm text-slate-500">{pendingDeleteDialog.message}</p>
              </div>
              <button
                type="button"
                onClick={closePendingDeleteDialog}
                disabled={pendingDeleteBusy}
                className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-500 hover:text-slate-800 disabled:opacity-60"
              >
                ปิด
              </button>
            </div>

            <div className="mt-5 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={closePendingDeleteDialog}
                disabled={pendingDeleteBusy}
                className="rounded-full border border-slate-200 bg-slate-50 px-4 py-2 text-xs font-semibold text-slate-500 hover:text-slate-800 disabled:opacity-60"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={runPendingDeleteAction}
                disabled={pendingDeleteBusy}
                className="rounded-full bg-rose-500 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-rose-600 disabled:opacity-60"
              >
                {pendingDeleteBusy ? 'กำลังลบ...' : pendingDeleteDialog.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {draggingSlot && dragPointer && draggingSlotDataRef.current ? (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed left-0 top-0 z-[80] overflow-hidden rounded-[28px] border border-t-[8px] p-5 shadow-[0_20px_48px_rgba(15,23,42,0.22)]"
          style={{
            width: scheduleCardWidth,
            height: scheduleCardHeight,
            transform: `translate3d(${Math.round(dragPointer.x - dragPreviewCursorOffsetX)}px, ${Math.round(
              dragPointer.y - dragPreviewCursorOffsetY
            )}px, 0)`,
            backgroundColor: '#ffffff',
            borderTopColor: resolveScheduleAccent(draggingSlotDataRef.current),
            borderRightColor: hexToRgba(resolveScheduleAccent(draggingSlotDataRef.current), 0.12),
            borderBottomColor: hexToRgba(resolveScheduleAccent(draggingSlotDataRef.current), 0.12),
            borderLeftColor: hexToRgba(resolveScheduleAccent(draggingSlotDataRef.current), 0.12),
            color: '#0f172a',
            willChange: 'transform',
          }}
        >
          <div
            className="absolute inset-0 opacity-55"
            style={{ backgroundColor: hexToRgba(resolveScheduleAccent(draggingSlotDataRef.current), 0.08) }}
          />
          <div className="relative z-[1] flex h-full flex-col">
            <div className="flex items-start justify-between gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-2xl bg-slate-50 text-slate-400 shadow-inner">
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7v5l3 2" />
                </svg>
              </div>
              <span className="mt-1 text-[11px] font-extrabold tracking-tight text-slate-900">
                {formatTimeRangeCompact(resolveDisplayStartTime(draggingSlotDataRef.current), resolveDisplayEndTime(draggingSlotDataRef.current))}
              </span>
            </div>
            <h4
              className="mt-3 pr-2 text-[18px] font-extrabold leading-[1.15] tracking-[-0.02em] text-slate-900 line-clamp-3"
              style={{ textShadow: '0 14px 32px rgba(0,0,0,0.18)' }}
            >
              {resolveSubjectLabel(
                draggingSlotDataRef.current.subjectId
                  ? subjectNameById.get(Number(draggingSlotDataRef.current.subjectId)) ?? null
                  : null,
                draggingSlotDataRef.current.subject
              )}
            </h4>
          </div>
        </div>
      ) : null}

      <style>{`
        .timetable-shell {
          position: relative;
          overflow: hidden;
        }

        .theme-dark .timetable-shell {
          background: rgba(15, 23, 42, 0.65) !important;
          border-color: rgba(255, 255, 255, 0.06) !important;
        }

        .theme-dark .timetable-shell::before {
          content: '';
          position: absolute;
          inset: -45%;
          background:
            radial-gradient(circle at 50% 50%, rgba(30, 41, 59, 0.85) 0%, transparent 40%),
            radial-gradient(circle at 20% 30%, rgba(15, 23, 42, 0.9) 0%, transparent 35%),
            radial-gradient(circle at 80% 70%, rgba(30, 27, 75, 0.9) 0%, transparent 35%);
          animation: timetable-rotate 22s linear infinite;
          opacity: 0.85;
          pointer-events: none;
          z-index: 0;
        }

        @keyframes timetable-rotate {
          from {
            transform: rotate(0deg);
          }
          to {
            transform: rotate(360deg);
          }
        }

        .timetable-shell > * {
          position: relative;
          z-index: 1;
        }

        .theme-dark .timetable-title {
          background-image: linear-gradient(90deg, rgba(255, 255, 255, 0.95), rgba(148, 163, 184, 0.7));
          -webkit-background-clip: text;
          background-clip: text;
          color: transparent;
        }

        .theme-dark .timetable-select {
          background: rgba(255, 255, 255, 0.05) !important;
          border-color: rgba(255, 255, 255, 0.06) !important;
        }

        .theme-dark .timetable-select select {
          color: rgba(226, 232, 240, 0.75) !important;
        }

        .theme-dark .timetable-select select:hover {
          color: rgba(255, 255, 255, 0.92) !important;
        }

        .theme-dark .timetable-print {
          background: rgba(255, 255, 255, 0.05) !important;
          border-color: rgba(255, 255, 255, 0.06) !important;
          color: rgba(226, 232, 240, 0.75) !important;
          box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45) !important;
        }

        .theme-dark .timetable-print:hover {
          background: rgba(255, 255, 255, 0.1) !important;
          color: rgba(255, 255, 255, 0.92) !important;
        }

        .theme-dark .timetable-board {
          border-color: rgba(255, 255, 255, 0.06) !important;
          background: rgba(2, 6, 23, 0.3) !important;
        }

        .theme-dark .timetable-row {
          border-color: rgba(255, 255, 255, 0.04) !important;
        }

        .theme-dark .day-label-column {
          width: 176px;
          background: rgba(255, 255, 255, 0.02) !important;
          border-right-color: rgba(255, 255, 255, 0.06) !important;
        }

        .theme-dark .subject-card {
          isolation: isolate;
          background: rgba(255, 255, 255, 0.03) !important;
          border-color: rgba(255, 255, 255, 0.06) !important;
        }

        .theme-dark .subject-card::after {
          content: '';
          position: absolute;
          z-index: 0;
          pointer-events: none;
          top: -150%;
          left: -150%;
          width: 300%;
          height: 300%;
          background: linear-gradient(45deg, transparent, rgba(255, 255, 255, 0.04), transparent);
          transition: 0.85s;
          opacity: 0.85;
        }

        .theme-dark .subject-card:hover::after {
          top: 150%;
          left: 150%;
        }

        .theme-dark .subject-card::before {
          content: '';
          position: absolute;
          z-index: 0;
          pointer-events: none;
          top: 0;
          left: 0;
          width: 100%;
          height: 4px;
          background: var(--glow-color, rgba(56, 189, 248, 0.8));
          box-shadow: 0 0 20px var(--glow-color, rgba(56, 189, 248, 0.45));
          opacity: 0.95;
        }

        .subject-card-content {
          position: relative;
          z-index: 2;
        }

        .theme-dark .subject-card:hover {
          background: rgba(255, 255, 255, 0.07) !important;
          border-color: rgba(255, 255, 255, 0.14) !important;
          box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.55), 0 0 22px -8px var(--glow-color, rgba(56, 189, 248, 0.4)) !important;
        }

        .theme-light .subject-card {
          isolation: isolate;
          background: rgba(255, 255, 255, 0.96) !important;
          border-color: rgba(15, 23, 42, 0.08) !important;
          box-shadow: 0 18px 40px rgba(15, 23, 42, 0.08) !important;
        }

        .theme-light .subject-card::before {
          content: '';
          position: absolute;
          z-index: 0;
          pointer-events: none;
          top: 0;
          left: 0;
          width: 100%;
          height: 4px;
          background: var(--glow-color, rgba(56, 189, 248, 0.7));
          box-shadow: 0 0 18px rgba(56, 189, 248, 0.18);
          opacity: 0.9;
        }

        .theme-light .subject-card:hover {
          border-color: rgba(15, 23, 42, 0.14) !important;
          box-shadow: 0 24px 55px rgba(15, 23, 42, 0.12) !important;
          transform: translateY(-10px) scale(1.02);
        }

        .theme-dark .schedule-subject {
          color: rgba(241, 245, 249, 0.95) !important;
        }

        .theme-light .schedule-subject {
          color: rgba(15, 23, 42, 0.92) !important;
        }

        .schedule-subject {
          position: relative;
          z-index: 3;
        }

        .theme-dark .btn-add-circle {
          width: 80px;
          height: 80px;
          border-radius: 9999px;
          border: 1px solid rgba(255, 255, 255, 0.1);
          background: rgba(255, 255, 255, 0.02);
          color: rgba(255, 255, 255, 0.22);
          transition: all 0.45s cubic-bezier(0.4, 0, 0.2, 1);
          flex-shrink: 0;
        }

        .theme-dark .btn-add-circle:hover {
          border-color: rgba(56, 189, 248, 0.75);
          color: rgba(56, 189, 248, 0.95);
          box-shadow: 0 0 25px rgba(56, 189, 248, 0.18);
          transform: rotate(90deg) scale(1.08);
          background: rgba(56, 189, 248, 0.05);
        }

        .theme-light .btn-add-circle {
          width: 80px;
          height: 80px;
          border-radius: 9999px;
          border: 1px solid rgba(15, 23, 42, 0.12);
          background: rgba(255, 255, 255, 0.85);
          color: rgba(15, 23, 42, 0.35);
          transition: all 0.45s cubic-bezier(0.4, 0, 0.2, 1);
          flex-shrink: 0;
        }

        .theme-light .btn-add-circle:hover {
          border-color: rgba(37, 99, 235, 0.55);
          color: rgba(37, 99, 235, 0.9);
          box-shadow: 0 14px 34px rgba(37, 99, 235, 0.18);
          transform: rotate(90deg) scale(1.08);
          background: rgba(37, 99, 235, 0.06);
        }

        .schedule-card {
          transform: translate3d(var(--slot-shift, 0px), 0, 0);
          transition: transform 220ms cubic-bezier(0.2, 0.85, 0.25, 1), box-shadow 220ms ease, opacity 200ms ease;
          will-change: transform;
        }
        .schedule-card:not(.schedule-card-dragging):hover {
          transform: translate3d(var(--slot-shift, 0px), -12px, 0) scale(1.03);
        }
        .schedule-card-dragging {
          transform: translate3d(0, 0, 0) scale(0.92);
          filter: saturate(0.7);
        }
        .drop-slot-indicator {
          animation: drop-slot-pop 170ms ease-out;
        }
        @keyframes drop-slot-pop {
          0% {
            opacity: 0;
            transform: scale(0.92);
          }
          100% {
            opacity: 1;
            transform: scale(1);
          }
        }
        .schedule-scroll::-webkit-scrollbar {
          height: 10px;
        }
        .schedule-scroll::-webkit-scrollbar-track {
          background: rgba(226, 232, 240, 0.35);
          border-radius: 999px;
        }
        .schedule-scroll::-webkit-scrollbar-thumb {
          background: rgba(148, 163, 184, 0.75);
          border-radius: 999px;
        }
        .schedule-scroll:hover::-webkit-scrollbar-thumb {
          background: rgba(100, 116, 139, 0.85);
        }
        .schedule-scroll {
          scrollbar-color: rgba(148, 163, 184, 0.85) rgba(226, 232, 240, 0.35);
          scrollbar-width: thin;
        }
      `}</style>
    </div>
  );
};

const weekOrder = ['จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์', 'อาทิตย์'];

const scheduleDayToneMap: Record<string, { accent: string }> = {
  default: { accent: '#475569' },
  จันทร์: { accent: '#f59e0b' },
  อังคาร: { accent: '#f43f5e' },
  พุธ: { accent: '#10b981' },
  พฤหัสบดี: { accent: '#f97316' },
  ศุกร์: { accent: '#0ea5e9' },
  เสาร์: { accent: '#a855f7' },
  อาทิตย์: { accent: '#ef4444' },
  [unscheduledDayLabel]: { accent: '#64748b' }
};

const dayMap: Record<string, string> = {
  Monday: 'จันทร์',
  Tuesday: 'อังคาร',
  Wednesday: 'พุธ',
  Thursday: 'พฤหัสบดี',
  Friday: 'ศุกร์',
  Saturday: 'เสาร์',
  Sunday: 'อาทิตย์'
};
