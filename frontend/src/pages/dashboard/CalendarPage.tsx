import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { format, parseISO } from 'date-fns';
import { th } from 'date-fns/locale';
import { api, apiFallbackClients } from '../../services/api';
import { useSemesterOptions } from '../../hooks/useSemesterOptions';
import { filterBySemester, toNumberOrNull } from '../../utils/semester';
import { subscribeSubjectsUpdated } from '../../utils/subjectSync';

type SubjectOption = {
  id: number;
  name: string;
  semester_id?: number | null;
  semester?: number | null;
  academic_year?: number | null;
  start_date?: string | null;
  start_time?: string | null;
  end_time?: string | null;
};

type CalendarEvent = {
  id: number;
  title: string;
  description?: string | null;
  room?: string | null;
  subject_id?: number | null;
  start_time: string;
  end_time?: string | null;
  status?: string | null;
  type?: 'class' | 'exam' | 'other' | null;
  event_type?: 'class' | 'exam' | 'other' | null;
  all_day?: boolean;
  source?: string | null;
  subject?: SubjectOption | null;
  study_log_id?: number | null;
  metadata?: Record<string, any>;
};

type EventTypeKey = 'class' | 'exam' | 'other' | 'log';
type NormalizedEventType = Exclude<CalendarEvent['type'], null | undefined>;

const eventTypeConfig: Record<EventTypeKey, { label: string; className: string }> = {
  class: { label: 'เรียน', className: 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-600' },
  exam: { label: 'สอบ', className: 'border border-primary/30 bg-primary/10 text-primary' },
  other: { label: 'กิจกรรม', className: 'border border-muted surface-2 text-muted' },
  log: { label: 'บันทึกการเรียน', className: 'border border-sky-500/30 bg-sky-500/15 text-sky-200' }
};

const calendarChipClassByType = {
  class: 'bg-emerald-500 text-white',
  exam: 'bg-primary',
  other: 'bg-amber-400 text-white',
  log: 'bg-sky-500 text-white',
};

const Icon = ({
  children,
  size = 20,
  className
}: {
  children: ReactNode;
  size?: number;
  className?: string;
}) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    className={className}
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

const PlusIcon = ({ size = 20, className }: { size?: number; className?: string }) => (
  <Icon size={size} className={className}>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </Icon>
);

const ChevronLeftIcon = ({ size = 18, className }: { size?: number; className?: string }) => (
  <Icon size={size} className={className}>
    <path d="M15 18l-6-6 6-6" />
  </Icon>
);

const ChevronRightIcon = ({ size = 18, className }: { size?: number; className?: string }) => (
  <Icon size={size} className={className}>
    <path d="M9 18l6-6-6-6" />
  </Icon>
);

const BookOpenIcon = ({ size = 24, className }: { size?: number; className?: string }) => (
  <Icon size={size} className={className}>
    <path d="M2.5 6.5A2.5 2.5 0 0 1 5 4h6v16H5a2.5 2.5 0 0 0-2.5 2.5V6.5Z" />
    <path d="M21.5 6.5A2.5 2.5 0 0 0 19 4h-6v16h6a2.5 2.5 0 0 1 2.5 2.5V6.5Z" />
    <path d="M12 4v16" />
  </Icon>
);

const ClockIcon = ({ size = 24, className }: { size?: number; className?: string }) => (
  <Icon size={size} className={className}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Icon>
);

const buildTimeOptions = (stepMinutes = 5) => {
  const options: string[] = [];
  for (let hour = 0; hour < 24; hour += 1) {
    for (let minute = 0; minute < 60; minute += stepMinutes) {
      options.push(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`);
    }
  }
  return options;
};
const timeOptions = buildTimeOptions(5);
const formatTimeOptionLabel = (value: string) => {
  const [hour = '00', minute = '00'] = value.split(':');
  return `${hour}.${minute}`;
};

const unwrapCollection = (payload: any) => {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
};

const isFallbackStatus = (status?: number) => !status || status === 404 || status === 405 || status === 500;

const fetchCollectionWithFallback = async (path: string) => {
  let lastError: any = null;
  for (const client of apiFallbackClients) {
    try {
      const res = await client.get(path);
      return { ok: true, data: unwrapCollection(res.data) };
    } catch (err: any) {
      lastError = err;
      const status = err?.response?.status;
      if (!isFallbackStatus(status)) throw err;
    }
  }
  return { ok: false, data: [], error: lastError };
};

const normalizeDateValue = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!slashMatch) return trimmed;

  const day = Number(slashMatch[1]);
  const month = Number(slashMatch[2]);
  const year = Number(slashMatch[3]);
  if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(year)) return trimmed;
  if (month < 1 || month > 12 || day < 1 || day > 31) return trimmed;

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};
const formatDateDisplayValue = (value: string) => {
  const normalized = normalizeDateValue(value);
  const isoMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!isoMatch) return value;
  return `${isoMatch[3]}/${isoMatch[2]}/${isoMatch[1]}`;
};
const normalizeTimeValue = (value?: string | null) => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const timeChunk = trimmed.includes('T')
    ? (trimmed.split('T')[1] ?? trimmed)
    : (trimmed.includes(' ') ? (trimmed.split(' ').pop() ?? trimmed) : trimmed);
  const normalized = timeChunk.replace(/\./g, ':');
  const [hourRaw, minuteRaw, secondRaw] = normalized.split(':');
  if (!hourRaw || !minuteRaw) return null;
  const hour = hourRaw.padStart(2, '0');
  const minute = minuteRaw.padStart(2, '0');
  const second = (secondRaw ?? '00').padStart(2, '0');
  return `${hour}:${minute}:${second}`;
};
const buildDateTime = (date: string, time: string) => {
  const normalizedDate = normalizeDateValue(date);
  const normalizedTime = normalizeTimeValue(time) ?? '00:00:00';
  return `${normalizedDate} ${normalizedTime}`;
};
const addHoursToTime = (time: string, hours: number) => {
  const normalized = normalizeTimeValue(time);
  if (!normalized || !Number.isFinite(hours) || hours <= 0) return normalized ?? time;
  const [h, m, s] = normalized.split(':').map(part => Number(part));
  const startSeconds = (h * 3600) + (m * 60) + s;
  const endSeconds = startSeconds + Math.round(hours * 3600);
  const daySeconds = ((endSeconds % 86400) + 86400) % 86400;
  const endHour = Math.floor(daySeconds / 3600);
  const endMinute = Math.floor((daySeconds % 3600) / 60);
  const endSecond = daySeconds % 60;
  return `${String(endHour).padStart(2, '0')}:${String(endMinute).padStart(2, '0')}:${String(endSecond).padStart(2, '0')}`;
};
const buildSubjectDateTime = (date?: string | null, time?: string | null) => {
  if (!date) return null;
  const trimmedDate = date.trim();
  if (!trimmedDate) return null;

  const normalizedProvidedTime = normalizeTimeValue(time);
  const datePart = trimmedDate.includes('T')
    ? (trimmedDate.split('T')[0] ?? trimmedDate)
    : (trimmedDate.includes(' ') ? (trimmedDate.split(' ')[0] ?? trimmedDate) : trimmedDate);

  if (normalizedProvidedTime) {
    return `${datePart}T${normalizedProvidedTime}`;
  }

  if (trimmedDate.includes('T')) return trimmedDate;
  if (trimmedDate.includes(' ')) {
    const timePart = trimmedDate.split(' ').slice(1).join(' ').trim();
    const normalizedTime = normalizeTimeValue(timePart);
    return `${datePart}T${normalizedTime ?? '00:00:00'}`;
  }

  return `${datePart}T00:00:00`;
};
const normalizeEventTypeValue = (value: unknown): NormalizedEventType | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'exam' || normalized === 'สอบ' || normalized === 'test' || normalized === 'quiz') {
    return 'exam';
  }
  if (normalized === 'class' || normalized === 'เรียน' || normalized === 'study') {
    return 'class';
  }
  return null;
};

const parseExamDescription = (description?: string | null) => {
  const raw = (description ?? '').trim();
  if (!raw) {
    return {
      examTopic: '',
      examScope: '',
      examMethod: '',
      preparationNotes: '',
      generalNotes: ''
    };
  }

  const examScope = raw.match(/ขอบเขตสอบ:\s*(.+)/u)?.[1]?.trim() ?? '';
  const examMethod = raw.match(/รูปแบบการสอบ:\s*(.+)/u)?.[1]?.trim() ?? '';
  const preparationNotes = raw.match(/แผนเตรียมสอบ:\s*([\s\S]+?)(?:\n\n|$)/u)?.[1]?.trim() ?? '';
  const generalNotes = raw.match(/หมายเหตุเพิ่มเติม:\s*([\s\S]+)$/u)?.[1]?.trim() ?? '';
  const examTopic = examScope;

  return {
    examTopic,
    examScope,
    examMethod,
    preparationNotes,
    generalNotes
  };
};

const buildExamDescription = ({
  examScope,
  examHours,
  isAllDay,
  examMethod,
  preparationNotes,
  generalNotes
}: {
  examScope: string;
  examHours: number;
  isAllDay: boolean;
  examMethod: string;
  preparationNotes: string;
  generalNotes: string;
}) => (
  [
    examScope ? `ขอบเขตสอบ: ${examScope}` : '',
    !isAllDay ? `ระยะเวลาสอบ: ${examHours} ชั่วโมง` : '',
    examMethod ? `รูปแบบการสอบ: ${examMethod}` : '',
    preparationNotes ? `แผนเตรียมสอบ:\n${preparationNotes}` : '',
    generalNotes ? `หมายเหตุเพิ่มเติม:\n${generalNotes}` : ''
  ].filter(Boolean).join('\n\n')
);

const resolveEventType = (event: CalendarEvent) =>
  normalizeEventTypeValue(event.event_type)
  ?? normalizeEventTypeValue(event.type)
  ?? normalizeEventTypeValue(event.metadata?.type)
  ?? normalizeEventTypeValue(event.metadata?.event_type)
  ?? null;
const mergeSubjectSchedule = (events: CalendarEvent[], subjects: SubjectOption[]) => {
  if (!subjects.length) return events;
  const subjectBackedEvents = events.filter(event => {
    const subjectId = event.subject?.id ?? event.subject_id;
    return event.source === 'subject' && Boolean(subjectId);
  });
  const subjectBackedBySubjectId = new Map<number, CalendarEvent>();
  subjectBackedEvents.forEach(event => {
    const subjectId = event.subject?.id ?? event.subject_id;
    if (!subjectId || subjectBackedBySubjectId.has(subjectId)) return;
    subjectBackedBySubjectId.set(subjectId, event);
  });
  const nonSubjectBackedEvents = events.filter(event => !subjectBackedEvents.includes(event));

  const derived = subjects
    .filter(subject => subject.start_date)
    .map(subject => {
      const existingSubjectEvent = subjectBackedBySubjectId.get(subject.id);
      const resolvedType = existingSubjectEvent ? (resolveEventType(existingSubjectEvent) ?? 'class') : 'class';
      const startTime = buildSubjectDateTime(subject.start_date, subject.start_time);
      if (!startTime) return null;
      const endTime = subject.end_time ? buildSubjectDateTime(subject.start_date, subject.end_time) : null;
      const isAllDay = !subject.start_time;
      return {
        id: -subject.id,
        title: subject.name,
        description: null,
        start_time: startTime,
        end_time: isAllDay ? null : endTime,
        status: 'planned',
        type: resolvedType,
        event_type: resolvedType,
        all_day: isAllDay,
        source: 'subject',
        subject: { id: subject.id, name: subject.name },
        metadata: { source: 'subject', type: resolvedType, all_day: isAllDay }
      } as CalendarEvent;
    })
    .filter((event): event is CalendarEvent => Boolean(event));
  return [...nonSubjectBackedEvents, ...derived];
};

const filterEventsBySubjects = (events: CalendarEvent[], subjects: SubjectOption[]) => {
  if (!events.length) return events;
  if (!subjects.length) {
    return events.filter(event => !event.subject?.id && !event.subject_id);
  }
  const subjectIds = new Set(subjects.map(subject => subject.id));
  return events.filter(event => {
    const subjectId = event.subject?.id ?? event.subject_id;
    if (!subjectId) return true;
    return subjectIds.has(subjectId);
  });
};

const thaiMonthOptions = [
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

export const CalendarPage = ({ embedded = false }: { embedded?: boolean } = {}) => {
  const createDatePickerRef = useRef<HTMLInputElement | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [subjects, setSubjects] = useState<SubjectOption[]>([]);
  const [selectedSemesterKey, setSelectedSemesterKey] = useState('all');
  const [selectedDate, setSelectedDate] = useState<string>(() => format(new Date(), 'yyyy-MM-dd'));
  const [currentMonthDate, setCurrentMonthDate] = useState<Date>(() => new Date());
  const [isAddingEvent, setIsAddingEvent] = useState(false);
  const [subjectSearch] = useState('');
  const [form, setForm] = useState({
    title: '',
    examTopic: '',
    examMethod: '',
    examNotes: '',
    room: '',
    type: 'class',
    date: format(new Date(), 'yyyy-MM-dd'),
    startTime: '09:00:00',
    endTime: '10:00:00',
    examHours: '1',
    allDay: false,
    subjectId: '',
    description: ''
  });
  const [formDateDisplay, setFormDateDisplay] = useState(() => formatDateDisplayValue(format(new Date(), 'yyyy-MM-dd')));
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingSubjectId, setSavingSubjectId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [editingEventId, setEditingEventId] = useState<number | null>(null);
  const semesterOptions = useSemesterOptions();

  const openAddForm = () => {
    setEditingEventId(null);
    setIsAddingEvent(true);
    setForm(prev => ({ ...prev, date: selectedDate }));
    setFormDateDisplay(formatDateDisplayValue(selectedDate));
    document.getElementById('calendar-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [eventsRes, subjectsRes] = await Promise.all([
        fetchCollectionWithFallback('/calendar-events'),
        fetchCollectionWithFallback('/subjects')
      ]);

      let nextEvents: CalendarEvent[] = [];
      let nextSubjects: SubjectOption[] = [];
      const subjectsLoaded = subjectsRes.ok;

      if (subjectsRes.ok) {
        nextSubjects = (subjectsRes.data as any[]).map(subject => ({
          id: subject.id,
          name: subject.name,
          semester_id: toNumberOrNull(subject.semester_id),
          semester: toNumberOrNull(subject.semester),
          academic_year: toNumberOrNull(subject.academic_year),
          start_date: subject.start_date ?? null,
          start_time: subject.start_time ?? null,
          end_time: subject.end_time ?? null
        }));
      } else {
        nextSubjects = [];
      }

      if (eventsRes.ok) {
        nextEvents = eventsRes.data as CalendarEvent[];
      } else {
        const message = eventsRes.error?.response?.data?.message ?? 'โหลดข้อมูลปฏิทินไม่สำเร็จ';
        setError(message);
      }

      setSubjects(nextSubjects);
      const filteredEvents = subjectsLoaded
        ? filterEventsBySubjects(nextEvents, nextSubjects)
        : nextEvents;
      setEvents(mergeSubjectSchedule(filteredEvents, nextSubjects));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => subscribeSubjectsUpdated(() => {
    void loadData();
  }), []);

  useEffect(() => {
    setForm(prev => ({ ...prev, date: selectedDate }));
    setFormDateDisplay(formatDateDisplayValue(selectedDate));
  }, [selectedDate]);

  useEffect(() => {
    if (!form.date) return;
    const nextDisplay = formatDateDisplayValue(form.date);
    setFormDateDisplay(prev => (prev === nextDisplay ? prev : nextDisplay));
  }, [form.date]);

  useEffect(() => {
    const parsed = parseISO(selectedDate);
    if (Number.isNaN(parsed.getTime())) return;
    setCurrentMonthDate(prev => {
      if (prev.getFullYear() === parsed.getFullYear() && prev.getMonth() === parsed.getMonth()) {
        return prev;
      }
      return new Date(parsed.getFullYear(), parsed.getMonth(), 1);
    });
  }, [selectedDate]);

  useEffect(() => {
    if (form.type !== 'exam' || form.allDay || !form.startTime) return;
    const examHours = Number(form.examHours);
    if (!Number.isFinite(examHours) || examHours <= 0) return;
    const nextEndTime = addHoursToTime(form.startTime, examHours);
    setForm(prev => (prev.endTime === nextEndTime ? prev : { ...prev, endTime: nextEndTime }));
  }, [form.type, form.allDay, form.startTime, form.examHours]);

  const filteredSubjects = useMemo(() => filterBySemester(subjects, selectedSemesterKey), [subjects, selectedSemesterKey]);
  const filteredSubjectIdSet = useMemo(() => new Set(filteredSubjects.map(subject => subject.id)), [filteredSubjects]);
  const filteredEvents = useMemo(
    () =>
      selectedSemesterKey === 'all'
        ? events
        : events.filter(event => {
            const subjectId = event.subject?.id ?? event.subject_id;
            if (!subjectId) return true;
            return filteredSubjectIdSet.has(subjectId);
          }),
    [events, filteredSubjectIdSet, selectedSemesterKey]
  );
  const visibleEvents = useMemo(
    () =>
      filteredEvents.filter(event => {
        if (event.source === 'study_log' || event.study_log_id) return true;
        return resolveEventType(event) !== 'other';
      }),
    [filteredEvents]
  );

  useEffect(() => {
    if (form.subjectId && !filteredSubjects.some(subject => String(subject.id) === form.subjectId)) {
      setForm(prev => ({ ...prev, subjectId: '' }));
    }
  }, [filteredSubjects, form.subjectId]);

  const selectedEvents = useMemo(
    () => visibleEvents.filter(event => format(parseISO(event.start_time), 'yyyy-MM-dd') === selectedDate),
    [selectedDate, visibleEvents]
  );
  const currentYear = currentMonthDate.getFullYear();
  const currentMonth = currentMonthDate.getMonth();
  const yearOptions = useMemo(() => {
    const selectedYear = parseISO(selectedDate).getFullYear();
    const startYear = Math.min(currentYear, selectedYear) - 3;
    const endYear = Math.max(currentYear, selectedYear) + 3;
    return Array.from({ length: endYear - startYear + 1 }, (_, index) => startYear + index);
  }, [currentYear, selectedDate]);
  const firstDayOfMonth = new Date(currentYear, currentMonth, 1).getDay();
  const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
  const blankDays = Array.from({ length: firstDayOfMonth }, (_, index) => `blank-${index}`);
  const monthDays = Array.from({ length: daysInMonth }, (_, index) => index + 1);
  const dayHeaders = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
  const subjectStatuses = useMemo(() => {
    if (!filteredSubjects.length) return [];
    const bySubject = new Map<number, CalendarEvent[]>();
    visibleEvents.forEach(event => {
      const eventDate = format(parseISO(event.start_time), 'yyyy-MM-dd');
      if (eventDate !== selectedDate) return;
      const subjectId = event.subject?.id ?? event.subject_id;
      if (!subjectId) return;
      const list = bySubject.get(subjectId) ?? [];
      list.push(event);
      bySubject.set(subjectId, list);
    });

    return filteredSubjects.map(subject => {
      const subjectEvents = bySubject.get(subject.id) ?? [];
      const editableEvent = subjectEvents.find(
        event => event.id > 0 && event.source !== 'study_log' && !event.study_log_id
      );
      const hasLog = subjectEvents.some(event => event.source === 'study_log' || event.study_log_id);
      const hasExam = subjectEvents.some(event => resolveEventType(event) === 'exam');
      const hasClass = subjectEvents.some(event => resolveEventType(event) === 'class');
      let activity: 'exam' | 'class' | 'other' | 'none' = 'none';
      if (hasExam) activity = 'exam';
      else if (hasClass) activity = 'class';
      else if (subjectEvents.length) activity = 'other';

      return {
        id: subject.id,
        name: subject.name,
        start_time: subject.start_time ?? null,
        end_time: subject.end_time ?? null,
        studied: hasLog,
        activity,
        eventId: editableEvent?.id ?? null,
      };
    });
  }, [filteredSubjects, selectedDate, visibleEvents]);

  const filteredSubjectStatuses = useMemo(() => {
    const needle = subjectSearch.trim().toLowerCase();
    if (!needle) return subjectStatuses;
    return subjectStatuses.filter(subject => subject.name.toLowerCase().includes(needle));
  }, [subjectSearch, subjectStatuses]);

  const weeklySummary = useMemo(() => {
    const base = parseISO(selectedDate);
    if (Number.isNaN(base.getTime())) {
      return { values: [0, 0, 0, 0, 0, 0, 0], max: 1 };
    }

    const start = new Date(base);
    start.setDate(base.getDate() - base.getDay());

    const values = Array.from({ length: 7 }, (_, index) => {
      const day = new Date(start);
      day.setDate(start.getDate() + index);
      const key = format(day, 'yyyy-MM-dd');
      return visibleEvents.filter(event => format(parseISO(event.start_time), 'yyyy-MM-dd') === key).length;
    });

    const max = Math.max(1, ...values);
    return { values, max };
  }, [selectedDate, visibleEvents]);

  const resolveEventBadge = (event: CalendarEvent) => {
    if (event.source === 'study_log') {
      return eventTypeConfig.log;
    }
    const resolvedType = resolveEventType(event);
    const config = resolvedType ? eventTypeConfig[resolvedType] : null;
    return config ?? eventTypeConfig.other;
  };

  const formatEventTime = (event: CalendarEvent) => {
    if (event.all_day) return 'ทั้งวัน';
    const start = format(parseISO(event.start_time), 'HH:mm');
    if (event.end_time) {
      const end = format(parseISO(event.end_time), 'HH:mm');
      return `${start} - ${end}`;
    }
    return start;
  };

  const startEditEvent = (event: CalendarEvent) => {
    if (event.id <= 0 || event.source === 'study_log') return;
    const resolvedType = resolveEventType(event) ?? 'other';
    const startAt = parseISO(event.start_time);
    const endAt = event.end_time ? parseISO(event.end_time) : null;
    const examTopicFromTitle = (event.title ?? '').replace(/^สอบ:\s*/u, '').trim();
    const descriptionRaw = (event.description ?? '').trim();
    const parsedExam = parseExamDescription(descriptionRaw);
    const examHours =
      endAt && !Number.isNaN(endAt.getTime())
        ? Math.max(0.5, Math.round((((endAt.getTime() - startAt.getTime()) / 3600000) || 1) * 2) / 2).toString()
        : '1';

    const nextDate = format(startAt, 'yyyy-MM-dd');
    setSelectedDate(nextDate);
    setForm({
      title: resolvedType === 'exam' ? '' : (event.title ?? ''),
      examTopic: resolvedType === 'exam' ? (parsedExam.examTopic || examTopicFromTitle || '') : '',
      examMethod: resolvedType === 'exam' ? parsedExam.examMethod : '',
      examNotes: resolvedType === 'exam' ? [parsedExam.preparationNotes, parsedExam.generalNotes].filter(Boolean).join('\n\n') : '',
      room: String(event.room ?? event.metadata?.room ?? ''),
      type: resolvedType,
      date: nextDate,
      startTime: format(startAt, 'HH:mm:ss'),
      endTime: endAt && !Number.isNaN(endAt.getTime()) ? format(endAt, 'HH:mm:ss') : '10:00:00',
      examHours,
      allDay: Boolean(event.all_day),
      subjectId: String(event.subject?.id ?? event.subject_id ?? ''),
      description: resolvedType === 'exam' ? '' : descriptionRaw
    });
    setEditingEventId(event.id);
    setIsAddingEvent(true);
    document.getElementById('calendar-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const createEvent = async () => {
    if (!form.date) {
      setError('กรุณาเลือกวันที่');
      return;
    }
    if (form.type === 'exam' && !form.examTopic.trim()) {
      setError('กรุณากรอกเรื่องที่สอบ');
      return;
    }
    if (form.type === 'exam' && !form.subjectId) {
      setError('กรุณาเลือกรายวิชาที่สอบ');
      return;
    }

    const examHours = Number(form.examHours);
    if (form.type === 'exam' && !form.allDay && (!Number.isFinite(examHours) || examHours <= 0)) {
      setError('กรุณาระบุจำนวนชั่วโมงสอบ');
      return;
    }
    if (!form.allDay && (!form.startTime || !form.endTime)) {
      setError('กรุณาระบุเวลาเริ่มและเวลาเลิก');
      return;
    }

    const isAllDay = form.allDay || !form.startTime;
    const normalizedType = form.type === 'class' || form.type === 'exam' ? form.type : null;
    const trimmedDescription = form.description.trim();
    const examTopic = form.examTopic.trim();
    const examMethod = form.examMethod.trim();
    const examNotes = form.examNotes.trim();
    const room = form.room.trim();
    const title = form.type === 'exam' ? `สอบ: ${examTopic}` : form.title.trim();
    const computedExamEndTime = form.type === 'exam' && !isAllDay
      ? addHoursToTime(form.startTime || '00:00:00', examHours)
      : form.endTime;
    const description = form.type === 'exam'
      ? buildExamDescription({
          examScope: examTopic,
          examHours,
          isAllDay,
          examMethod,
          preparationNotes: examNotes,
          generalNotes: ''
        })
      : trimmedDescription;
    const payload = {
      title,
      description: description || null,
      room: room || null,
      subject_id: form.subjectId ? Number(form.subjectId) : null,
      type: form.type,
      ...(normalizedType ? { event_type: normalizedType } : {}),
      all_day: isAllDay,
      start_time: buildDateTime(form.date, isAllDay ? '00:00:00' : form.startTime || '00:00:00'),
      end_time: isAllDay || !computedExamEndTime ? null : buildDateTime(form.date, computedExamEndTime),
      status: 'planned'
    };

    setSaving(true);
    setError(null);
    try {
      if (editingEventId) {
        await api.patch(`/calendar-events/${editingEventId}`, payload);
      } else {
        await api.post('/calendar-events', payload);
      }
      setForm(prev => ({ ...prev, title: '', examTopic: '', examMethod: '', examNotes: '', room: '', description: '' }));
      setEditingEventId(null);
      setIsAddingEvent(false);
      await loadData();
    } catch (err: any) {
      setError(err.response?.data?.message ?? 'บันทึกตารางไม่สำเร็จ');
    } finally {
      setSaving(false);
    }
  };

  
  const upsertSubjectActivity = async (subjectId: number, nextType: 'class' | 'exam') => {
    const subject = subjects.find(item => item.id === subjectId);
    if (!subject) return;

    const status = subjectStatuses.find(item => item.id === subjectId);
    if (status?.activity === nextType) return;

    setSavingSubjectId(subjectId);
    setError(null);

    try {
      if (status?.eventId) {
        await api.patch(`/calendar-events/${status.eventId}`, { type: nextType, event_type: nextType });
      } else {
        const startTime = status?.start_time ?? '09:00:00';
        const endTime = status?.end_time ?? null;
        const allDay = !status?.start_time;
        await api.post('/calendar-events', {
          title: subject.name,
          description: null,
          subject_id: subjectId,
          type: nextType,
          event_type: nextType,
          all_day: allDay,
          start_time: buildDateTime(selectedDate, allDay ? '00:00:00' : startTime),
          end_time: allDay || !endTime ? null : buildDateTime(selectedDate, endTime),
          status: 'planned'
        });
      }
      await loadData();
    } catch (err: any) {
      setError(err.response?.data?.message ?? 'แก้ไขประเภทไม่สำเร็จ');
    } finally {
      setSavingSubjectId(null);
    }
  };

  const deleteEvent = async (event: CalendarEvent) => {
    const eventId = event.id;
    setDeletingId(eventId);
    setError(null);
    try {
      try {
        await api.delete(`/calendar-events/${eventId}`);
      } catch (err: any) {
        const status = err?.response?.status;
        if (status !== 404 && status !== 405) {
          throw err;
        }
        try {
          await api.post(`/calendar-events/${eventId}`);
        } catch (directErr: any) {
          const directStatus = directErr?.response?.status;
          if (directStatus !== 404 && directStatus !== 405) {
            throw directErr;
          }
          try {
            await api.post(`/calendar-events/${eventId}/delete`);
          } catch (nestedErr: any) {
            const nestedStatus = nestedErr?.response?.status;
            if (nestedStatus !== 404 && nestedStatus !== 405) {
              throw nestedErr;
            }
            await api.post('/calendar-events/delete', { id: eventId });
          }
        }
      }
      await loadData();
    } catch (err: any) {
      setError(err.response?.data?.message ?? 'ลบรายการไม่สำเร็จ');
    } finally {
      setDeletingId(null);
    }
  };

  const getEventsForDay = (day: number) => {
    const dateKey = format(new Date(currentYear, currentMonth, day), 'yyyy-MM-dd');
    return visibleEvents.filter(event => format(parseISO(event.start_time), 'yyyy-MM-dd') === dateKey);
  };

  const goToToday = () => {
    const today = new Date();
    const todayKey = format(today, 'yyyy-MM-dd');
    setCurrentMonthDate(new Date(today.getFullYear(), today.getMonth(), 1));
    setSelectedDate(todayKey);
    setIsAddingEvent(false);
  };
  const todayExamCount = selectedEvents.filter(event => resolveEventType(event) === 'exam').length;

  return (
    <div className={`bg-transparent text-[color:var(--text)] ${embedded ? 'px-3 py-4' : 'min-h-screen px-4 py-6 md:px-8 md:py-8'}`}>
      <div className={`mx-auto w-full max-w-6xl ${embedded ? 'space-y-4' : 'space-y-6'}`}>
      {error ? (
        <div className="rounded-2xl border border-rose-500/35 bg-rose-500/10 px-4 py-3 text-sm font-medium text-rose-300 shadow-[0_10px_24px_rgba(244,63,94,0.14)]">
          {error}
        </div>
      ) : null}

        <section className="rounded-[28px] border border-muted bg-[color:var(--panel-bg)] p-5 shadow-soft md:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            {!embedded && (
            <div>
              <p className="inline-flex items-center rounded-full border border-[color:rgba(var(--accent-rgb),0.35)] bg-[color:rgba(var(--accent-rgb),0.08)] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-accent">
                Smart Calendar
              </p>
              <h1 className="mt-3 text-3xl font-bold text-[color:var(--text)]">
                จัดการปฏิทินและการสอบ
              </h1>
              <p className="mt-1 text-sm text-[color:rgba(var(--text),0.72)]">จัดการเวลาเรียน สอบ และกิจกรรมรายวันในหน้าเดียว</p>
            </div>
            )}
            <button
              type="button"
              onClick={() => setIsAddingEvent(true)}
              className={`inline-flex items-center justify-center gap-2 rounded-2xl px-5 py-2.5 text-sm font-bold text-[color:var(--on-accent)] shadow-[0_12px_24px_rgba(var(--accent-rgb),0.26)] transition hover:opacity-95 ${embedded ? 'w-full' : ''}`}
              style={{ background: 'var(--accent)' }}
            >
              <PlusIcon size={16} />
              เพิ่มรายการใหม่
            </button>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <div className="rounded-[18px] border border-muted bg-[color:var(--surface)] px-4 py-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted">รายการทั้งหมด</p>
              <p className="mt-1.5 text-2xl font-bold text-[color:var(--text)]">{loading ? '...' : visibleEvents.length}</p>
            </div>
            <div className="rounded-[18px] border border-muted bg-[color:var(--surface)] px-4 py-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted">วิชาในเทอม</p>
              <p className="mt-1.5 text-2xl font-bold text-[color:var(--text)]">{filteredSubjects.length}</p>
            </div>
            <div className="rounded-[18px] border border-muted bg-[color:var(--surface)] px-4 py-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted">วันที่เลือก</p>
              <p className="mt-1.5 text-lg font-bold text-[color:var(--text)]">{format(parseISO(selectedDate), 'd MMM yyyy', { locale: th })}</p>
            </div>
            <div className="rounded-[18px] border border-muted bg-[color:var(--surface)] px-4 py-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted">สอบวันนี้</p>
              <p className="mt-1.5 text-2xl font-bold text-[color:var(--text)]">{todayExamCount}</p>
            </div>
          </div>
        </section>

      <div className={`grid grid-cols-1 gap-6 ${embedded ? 'xl:grid-cols-12' : 'lg:grid-cols-12'}`}>
        <section className={`min-w-0 ${embedded ? 'xl:col-span-8' : 'lg:col-span-8'}`}>
          <div className="bg-[color:var(--panel-bg)] backdrop-blur-xl border border-muted rounded-[32px] overflow-hidden shadow-soft">
          <div className="flex flex-col gap-4 border-b border-muted px-4 py-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:px-6 sm:py-5">
            <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto">
              <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center">
                <select
                  value={currentMonth}
                  onChange={event => setCurrentMonthDate(new Date(currentYear, Number(event.target.value), 1))}
                  className="min-w-[9.5rem] bg-transparent text-lg font-bold text-[color:var(--text)] outline-none cursor-pointer"
                >
                  {thaiMonthOptions.map((monthLabel, index) => (
                    <option key={monthLabel} value={index} className="bg-[color:var(--surface-3)] text-[color:var(--text)]">
                      {monthLabel}
                    </option>
                  ))}
                </select>
                <select
                  value={currentYear}
                  onChange={event => setCurrentMonthDate(new Date(Number(event.target.value), currentMonth, 1))}
                  className="min-w-[6.5rem] bg-transparent text-lg font-bold text-muted outline-none cursor-pointer"
                >
                  {yearOptions.map(year => (
                    <option key={year} value={year} className="bg-[color:var(--surface-3)] text-[color:var(--text)]">
                      {year}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex items-center gap-2 surface-2 p-1 rounded-2xl border border-muted">
              <button
                type="button"
                onClick={() => setCurrentMonthDate(new Date(currentYear, currentMonth - 1, 1))}
                className="p-2 hover:bg-[color:rgba(var(--accent-rgb),0.08)] rounded-xl transition-colors text-[color:var(--text)]"
                aria-label="เดือนก่อนหน้า"
                  >
                    <ChevronLeftIcon size={18} />
                  </button>
              <button
                type="button"
                onClick={goToToday}
                className="text-sm font-medium px-2 text-[color:var(--text)] hover:text-accent transition-colors"
              >
                วันนี้
              </button>
              <button
                type="button"
                onClick={() => setCurrentMonthDate(new Date(currentYear, currentMonth + 1, 1))}
                className="p-2 hover:bg-[color:rgba(var(--accent-rgb),0.08)] rounded-xl transition-colors text-[color:var(--text)]"
                aria-label="เดือนถัดไป"
                  >
                    <ChevronRightIcon size={18} />
                  </button>
                </div>
              </div>

          <div className="px-3 py-4 sm:px-6 sm:py-6">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
              <div className="min-w-0 sm:min-w-[220px]">
                <label className="mb-1 block text-xs font-bold text-muted uppercase tracking-widest">ภาคเรียน</label>
                <select
                  value={selectedSemesterKey}
                  onChange={event => setSelectedSemesterKey(event.target.value)}
                  className="w-full surface-2 border border-muted rounded-2xl px-4 py-2.5 text-sm text-[color:var(--text)] focus:outline-none focus:border-[color:var(--accent)] focus:ring-2 focus:ring-[color:var(--accent)]/20"
                >
                  {semesterOptions.map(option => (
                    <option key={option.key} value={option.key} className="bg-[color:var(--surface-3)] text-[color:var(--text)]">
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="text-xs font-bold text-muted">
                {format(parseISO(selectedDate), 'd MMMM yyyy', { locale: th })}
              </div>
            </div>

            <div className="w-full pb-2">
              <div className="grid w-full min-w-0 grid-cols-7 gap-2">
                {dayHeaders.map((dayLabel, index) => (
                  <div
                    key={dayLabel}
                    className={`text-center text-xs font-bold uppercase tracking-wider mb-3 ${
                      index === 0 ? 'text-rose-500' : index === 6 ? 'text-accent' : 'text-muted'
                    }`}
                  >
                    {dayLabel}
                  </div>
                ))}

                {blankDays.map(blankKey => (
                  <div key={blankKey} className="h-24 opacity-0" />
                ))}

                {monthDays.map(day => {
                  const dayDate = new Date(currentYear, currentMonth, day);
                  const dayKey = format(dayDate, 'yyyy-MM-dd');
                  const dayEvents = getEventsForDay(day);
                  const isSelected = dayKey === selectedDate;
                  const isToday = dayKey === format(new Date(), 'yyyy-MM-dd');
                  const weekDay = dayDate.getDay();
                  const isWeekend = weekDay === 0 || weekDay === 6;

                  return (
                    <button
                      key={day}
                      type="button"
                      onClick={() => {
                        setSelectedDate(dayKey);
                        setIsAddingEvent(false);
                      }}
                      className={`h-24 rounded-2xl p-2 border transition-all cursor-pointer relative group ${
                        isSelected
                          ? 'bg-primary/10 border-primary/40 shadow-glow'
                          : 'bg-[color:rgba(var(--on-accent-rgb),0.04)] border-muted hover:border-[color:rgba(var(--accent-rgb),0.45)]'
                      }`}
                    >
                      <div
                        className={`text-sm font-bold ${
                          isToday ? 'text-accent' : isWeekend ? (weekDay === 0 ? 'text-rose-400' : 'text-accent') : 'text-[color:var(--text)]'
                        }`}
                      >
                        {day}
                      </div>
                      <div className="mt-1.5 space-y-1 sm:mt-3">
                        {dayEvents.slice(0, 2).map(event => {
                          const badge = resolveEventBadge(event);
                          const resolvedType = event.source === 'study_log' ? 'log' : (resolveEventType(event) ?? 'other');
                          const eventTimeText = formatEventTime(event);
                          const examInfo = parseExamDescription(event.description);
                          const examTopic = examInfo.examScope || (event.title ?? '').replace(/^สอบ:\s*/u, '').trim();
                          const subjectName = event.subject?.name ?? '';
                          const compactTitle =
                            resolvedType === 'exam'
                              ? (subjectName || event.title || 'สอบ')
                              : (event.title || badge.label);
                          return (
                            <div
                              key={event.id}
                              className={`text-[10px] p-1 rounded-lg truncate ${calendarChipClassByType[resolvedType]}`}
                              title={
                                resolvedType === 'exam'
                                  ? `${badge.label}: ${subjectName || '-'} | ${examTopic || '-'} | ${eventTimeText}`
                                  : `${badge.label}: ${event.title} | ${eventTimeText}`
                              }
                            >
                              {compactTitle}
                            </div>
                          );
                        })}
                        {dayEvents.length > 2 ? (
                          <div className="text-[10px] surface-2 text-muted p-1 rounded-lg border border-muted">
                            +{dayEvents.length - 2} รายการ
                          </div>
                        ) : null}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          </div>

          <div className="mt-6 bg-[color:var(--panel-bg)] backdrop-blur-xl border border-muted rounded-[32px] overflow-hidden p-5 shadow-soft">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h3 className="text-xs font-bold text-muted uppercase tracking-widest">สถานะรายวิชา</h3>
              <span className="text-xs font-semibold text-muted">
                {filteredSubjectStatuses.length}/{subjectStatuses.length} วิชา
              </span>
            </div>
            {subjectStatuses.length === 0 ? (
              <div className="rounded-2xl border border-muted surface-2 px-4 py-8 text-center text-sm text-muted">
                ยังไม่มีรายวิชาในเทอมที่เลือก
              </div>
            ) : filteredSubjectStatuses.length === 0 ? (
              <div className="rounded-2xl border border-muted surface-2 px-4 py-8 text-center text-sm text-muted">
                ไม่พบรายวิชาที่ค้นหา
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                {filteredSubjectStatuses.slice(0, 6).map(subject => {
                  const isActive = subject.studied || subject.activity !== 'none';
                  const badgeLabel =
                    subject.activity === 'exam' ? 'EXAM' : subject.activity === 'class' ? 'ACTIVE' : 'PENDING';
                  const badgeClass =
                    subject.activity === 'class'
                      ? 'bg-primary/10 text-primary border-primary/20'
                      : subject.activity === 'exam'
                        ? 'bg-amber-500/10 text-amber-300 border-amber-500/20'
                        : 'surface-2 text-muted border-muted';
                  const icon =
                    subject.activity === 'class' ? (
                      <BookOpenIcon size={24} />
                    ) : subject.activity === 'exam' ? (
                      <ClockIcon size={24} />
                    ) : (
                      <ClockIcon size={24} />
                    );

                  return (
                      <div
                        key={subject.id}
                        className={`grid grid-cols-[auto_minmax(0,1fr)] items-start gap-4 rounded-[28px] border p-4 transition-all sm:p-5 ${
                        isActive ? 'border-muted surface' : 'border-muted surface-2 opacity-70'
                        }`}
                      >
                      <div
                        className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl ${
                          subject.activity === 'class'
                            ? 'bg-emerald-500/20 text-emerald-300'
                            : subject.activity === 'exam'
                              ? 'bg-primary/10 text-primary'
                              : 'surface-2 text-muted'
                        }`}
                      >
                        {icon}
                      </div>
                      <div className="min-w-0">
                        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                          <h4 className="min-w-0 flex-1 truncate font-bold">{subject.name}</h4>
                          <div className={`shrink-0 rounded-full border px-3 py-1 text-[10px] font-bold uppercase ${badgeClass}`}>
                            {badgeLabel}
                          </div>
                        </div>
                        <p className="mt-1 text-xs leading-5 text-muted">
                          สถานะ: {subject.studied ? 'กำลังเรียน' : 'ยังไม่เริ่ม'} •{' '}
                          {subject.activity === 'exam' ? 'มีสอบ' : subject.activity === 'class' ? 'มีเรียน' : 'ยังไม่กำหนด'}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => upsertSubjectActivity(subject.id, 'class')}
                            disabled={savingSubjectId === subject.id}
                            aria-pressed={subject.activity === 'class'}
                            className={`text-[10px] font-bold px-3 py-1 rounded-full border transition disabled:opacity-60 ${
                              subject.activity === 'class'
                                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600'
                                : 'border-muted text-muted hover:border-emerald-500/40 hover:text-emerald-500'
                            }`}
                          >
                            ตั้งเป็นเรียน
                          </button>
                          <button
                            type="button"
                            onClick={() => upsertSubjectActivity(subject.id, 'exam')}
                            disabled={savingSubjectId === subject.id}
                            aria-pressed={subject.activity === 'exam'}
                            className={`text-[10px] font-bold px-3 py-1 rounded-full border transition disabled:opacity-60 ${
                              subject.activity === 'exam'
                                ? 'border-primary/40 bg-primary/10 text-primary'
                                : 'border-muted text-muted hover:border-primary/40 hover:text-primary'
                            }`}
                          >
                            ตั้งเป็นสอบ
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        <aside className={`flex flex-col gap-6 ${embedded ? 'xl:col-span-4 xl:sticky xl:top-6' : 'lg:col-span-4 lg:sticky lg:top-6'}`}>
          {!isAddingEvent ? (
            <section className="overflow-hidden rounded-[32px] border border-muted bg-[color:var(--panel-bg)] backdrop-blur-xl shadow-soft">
              <div className="flex items-start justify-between gap-4 px-6 py-6">
                <div>
                  <h3 className="text-4xl font-black leading-none text-[color:var(--text)]">
                    {format(parseISO(selectedDate), 'd')}
                  </h3>
                  <p className="mt-2 text-sm font-bold tracking-widest uppercase text-accent">
                    {format(parseISO(selectedDate), 'LLLL', { locale: th })}
                  </p>
                  <p className="mt-3 text-xs font-bold text-muted uppercase tracking-widest">{selectedEvents.length} รายการ</p>
                </div>
                <button
                  type="button"
                  onClick={openAddForm}
                  className="bg-[color:var(--accent)] text-[color:var(--on-accent)] p-2.5 rounded-full shadow-glow transition-all hover:opacity-90 active:scale-95"
                  aria-label="เพิ่มกิจกรรมใหม่"
                  title="เพิ่มกิจกรรมใหม่"
                >
                  <PlusIcon size={20} />
                </button>
              </div>

              <div className="space-y-4 px-6 pb-6">
                {selectedEvents.length > 0 ? (
                  selectedEvents.map(event => {
                    const badge = resolveEventBadge(event);
                    const canEdit = event.id > 0 && event.source !== 'study_log';
                    const resolvedType = resolveEventType(event);
                    const examInfo = resolvedType === 'exam' ? parseExamDescription(event.description) : null;
                    return (
                      <article
                        key={event.id}
                        className="p-4 rounded-[24px] surface-2 border border-muted hover:border-primary/40 transition-all group"
                      >
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${badge.className}`}>
                            {badge.label}
                          </span>
                          <span className="text-xs font-bold text-muted">{formatEventTime(event)}</span>
                        </div>
                        <h4 className="font-bold text-lg text-[color:var(--text)]">{event.title}</h4>
                        {event.subject?.name ? (
                          <p className="mt-1 text-xs text-muted">{event.subject.name}</p>
                        ) : null}
                        {event.room ? (
                          <p className="mt-1 text-xs text-muted">ห้อง: {event.room}</p>
                        ) : null}
                        {examInfo ? (
                          <div className="mt-3 space-y-2 rounded-2xl border border-primary/20 bg-primary/10 p-3 text-sm">
                            <p className="text-[color:var(--text)]">
                              <span className="font-semibold">วิชาที่สอบ:</span> {event.subject?.name ?? '-'}
                            </p>
                            {examInfo.examScope ? (
                              <p className="text-muted">
                                <span className="font-semibold text-[color:var(--text)]">เรื่องที่สอบ:</span> {examInfo.examScope}
                              </p>
                            ) : null}
                            {examInfo.examMethod ? (
                              <p className="text-muted">
                                <span className="font-semibold text-[color:var(--text)]">รูปแบบการสอบ:</span> {examInfo.examMethod}
                              </p>
                            ) : null}
                            {examInfo.preparationNotes ? (
                              <p className="whitespace-pre-line text-muted">
                                <span className="font-semibold text-[color:var(--text)]">แนวทางเตรียมตัว:</span>{' '}
                                {examInfo.preparationNotes}
                              </p>
                            ) : null}
                            {examInfo.generalNotes ? (
                              <p className="whitespace-pre-line text-muted">
                                <span className="font-semibold text-[color:var(--text)]">หมายเหตุ:</span>{' '}
                                {examInfo.generalNotes}
                              </p>
                            ) : null}
                          </div>
                        ) : event.description ? (
                          <p className="mt-2 text-xs text-muted">{event.description}</p>
                        ) : null}
                        {canEdit ? (
                          <div className="mt-4 flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => startEditEvent(event)}
                              className="text-[10px] font-bold bg-primary text-[color:var(--on-accent)] px-3 py-1.5 rounded-full hover:opacity-90 transition-all"
                            >
                              เปิดดู
                            </button>
                            <button
                              type="button"
                              onClick={() => deleteEvent(event)}
                              disabled={deletingId === event.id}
                              className="text-[10px] font-bold px-3 py-1.5 rounded-full border border-rose-500/30 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 transition disabled:opacity-60"
                            >
                              {deletingId === event.id ? 'กำลังลบ...' : 'ลบ'}
                            </button>
                          </div>
                        ) : null}
                      </article>
                    );
                  })
                ) : (
                  <div className="p-6 rounded-[24px] surface-2 border border-muted text-center">
                    <p className="text-sm font-semibold text-[color:var(--text)]">ยังไม่มีรายการในวันนี้</p>
                    <p className="text-xs text-muted mt-1">กดปุ่ม + เพื่อเพิ่มกิจกรรมใหม่</p>
                  </div>
                )}
              </div>
            </section>
          ) : (
            <section className="overflow-hidden rounded-[32px] border border-muted bg-[color:var(--panel-bg)] backdrop-blur-xl shadow-soft">
              <div className="flex items-center justify-between gap-3 px-6 py-6">
                <div>
                  <h3 className="text-xl font-bold text-[color:var(--text)]">
                    {editingEventId ? 'แก้ไขตาราง' : 'เพิ่มตารางใหม่'}
                  </h3>
                  <p className="mt-1 text-sm text-muted">
                    {format(parseISO(form.date), 'd MMMM yyyy', { locale: th })}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setIsAddingEvent(false);
                    setEditingEventId(null);
                    setForm(prev => ({ ...prev, title: '', examTopic: '', examMethod: '', examNotes: '', room: '', description: '' }));
                  }}
                  className="flex h-9 w-9 items-center justify-center rounded-full border border-muted surface-2 text-muted transition hover:text-accent"
                >
                  ×
                </button>
              </div>

              <form
                id="calendar-form"
                onSubmit={event => {
                  event.preventDefault();
                  createEvent();
                }}
                className="grid gap-4 px-6 pb-6"
              >
                <div>
                  <label className="mb-1 block text-sm font-semibold text-[color:var(--text)]">
                    {form.type === 'exam' ? 'เรื่องที่สอบ' : 'ชื่อกิจกรรม'}
                  </label>
                  <input
                    value={form.type === 'exam' ? form.examTopic : form.title}
                    onChange={event =>
                      setForm(prev => (
                        form.type === 'exam'
                          ? { ...prev, examTopic: event.target.value }
                          : { ...prev, title: event.target.value }
                      ))
                    }
                    className="w-full surface-2 border border-muted rounded-2xl px-4 py-3 text-sm text-[color:var(--text)] placeholder:text-muted focus:outline-none focus:border-[color:var(--accent)] focus:ring-2 focus:ring-[color:var(--accent)]/20"
                  />
                </div>

                {form.type === 'exam' ? (
                  <>
                    <div>
                      <label className="mb-1 block text-sm font-semibold text-[color:var(--text)]">รูปแบบการสอบ</label>
                      <input
                        value={form.examMethod}
                        onChange={event => setForm(prev => ({ ...prev, examMethod: event.target.value }))}
                        className="w-full surface-2 border border-muted rounded-2xl px-4 py-3 text-sm text-[color:var(--text)] placeholder:text-muted focus:outline-none focus:border-[color:var(--accent)] focus:ring-2 focus:ring-[color:var(--accent)]/20"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-sm font-semibold text-[color:var(--text)]">แนวทางเตรียมตัว / รายละเอียดสอบ</label>
                      <textarea
                        value={form.examNotes}
                        onChange={event => setForm(prev => ({ ...prev, examNotes: event.target.value }))}
                        className="min-h-[110px] w-full surface-2 border border-muted rounded-2xl px-4 py-3 text-sm text-[color:var(--text)] placeholder:text-muted focus:outline-none focus:border-[color:var(--accent)] focus:ring-2 focus:ring-[color:var(--accent)]/20"
                      />
                    </div>
                  </>
                ) : null}

                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-sm font-semibold text-[color:var(--text)]">ประเภท</label>
                    <select
                      value={form.type}
                      onChange={event => setForm(prev => ({ ...prev, type: event.target.value }))}
                      className="w-full surface-2 border border-muted rounded-2xl px-4 py-3 text-sm text-[color:var(--text)] focus:outline-none focus:border-[color:var(--accent)] focus:ring-2 focus:ring-[color:var(--accent)]/20"
                    >
                      <option value="class" className="bg-[color:var(--surface-3)] text-[color:var(--text)]">เรียน</option>
                      <option value="exam" className="bg-[color:var(--surface-3)] text-[color:var(--text)]">สอบ</option>
                  
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-semibold text-[color:var(--text)]">รายวิชา</label>
                    <select
                      value={form.subjectId}
                      onChange={event => setForm(prev => ({ ...prev, subjectId: event.target.value }))}
                      className="w-full surface-2 border border-muted rounded-2xl px-4 py-3 text-sm text-[color:var(--text)] focus:outline-none focus:border-[color:var(--accent)] focus:ring-2 focus:ring-[color:var(--accent)]/20"
                    >
                      <option value="" className="bg-[color:var(--surface-3)] text-[color:var(--text)]">เลือกวิชา</option>
                      {filteredSubjects.map(subject => (
                        <option key={subject.id} value={subject.id} className="bg-[color:var(--surface-3)] text-[color:var(--text)]">
                          {subject.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="mb-1 block text-sm font-semibold text-[color:var(--text)]">ห้องเรียน</label>
                  <input
                    value={form.room}
                    onChange={event => setForm(prev => ({ ...prev, room: event.target.value }))}
                    placeholder="เช่น อาคาร 3 ห้อง 305"
                    className="w-full surface-2 border border-muted rounded-2xl px-4 py-3 text-sm text-[color:var(--text)] placeholder:text-muted focus:outline-none focus:border-[color:var(--accent)] focus:ring-2 focus:ring-[color:var(--accent)]/20"
                  />
                </div>

                <div>
                  <label className="mb-1 block text-sm font-semibold text-[color:var(--text)]">วันที่</label>
                  <div className="relative">
                    <input
                      type="text"
                      placeholder="dd/mm/yyyy"
                      inputMode="numeric"
                      value={formDateDisplay}
                      onChange={event => {
                        const nextDisplay = event.target.value;
                        setFormDateDisplay(nextDisplay);
                        const normalized = normalizeDateValue(nextDisplay);
                        if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
                          setForm(prev => ({ ...prev, date: normalized }));
                        }
                      }}
                      className="w-full surface-2 border border-muted rounded-2xl px-4 py-3 pr-12 text-sm text-[color:var(--text)] placeholder:text-muted focus:outline-none focus:border-[color:var(--accent)] focus:ring-2 focus:ring-[color:var(--accent)]/20"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const picker = createDatePickerRef.current;
                        if (!picker) return;
                        if (typeof (picker as any).showPicker === 'function') (picker as any).showPicker();
                        else picker.click();
                      }}
                      aria-label="เลือกวันที่"
                      title="เลือกวันที่"
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-accent"
                    >
                      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none">
                        <rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.6" />
                        <path d="M8 3v4M16 3v4M3 9h18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                      </svg>
                    </button>
                    <input
                      ref={createDatePickerRef}
                      type="date"
                      value={/^\d{4}-\d{2}-\d{2}$/.test(form.date) ? form.date : ''}
                      onChange={event => {
                        const normalized = normalizeDateValue(event.target.value);
                        if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return;
                        setForm(prev => ({ ...prev, date: normalized }));
                        setFormDateDisplay(formatDateDisplayValue(normalized));
                      }}
                      className="absolute inset-0 pointer-events-none opacity-0"
                      tabIndex={-1}
                      aria-hidden="true"
                    />
                  </div>
                </div>

                <div className="flex items-center gap-3 rounded-2xl border border-muted surface-2 px-4 py-3 text-sm text-[color:var(--text)]">
                  <input
                    id="all-day"
                    type="checkbox"
                    checked={form.allDay}
                    onChange={event => setForm(prev => ({ ...prev, allDay: event.target.checked }))}
                  />
                  <label htmlFor="all-day">ทั้งวัน</label>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-sm font-semibold text-[color:var(--text)]">เวลาเริ่ม</label>
                    <select
                      value={form.startTime}
                      onChange={event => setForm(prev => ({ ...prev, startTime: event.target.value }))}
                      disabled={form.allDay}
                      className="w-full surface-2 border border-muted rounded-2xl px-4 py-3 text-sm text-[color:var(--text)] focus:outline-none focus:border-[color:var(--accent)] focus:ring-2 focus:ring-[color:var(--accent)]/20 disabled:opacity-60"
                    >
                      <option value="">--.--</option>
                      {timeOptions.map(option => (
                        <option key={option} value={option} className="bg-[color:var(--surface-3)] text-[color:var(--text)]">
                          {formatTimeOptionLabel(option)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-semibold text-[color:var(--text)]">
                      {form.type === 'exam' ? 'ชั่วโมงสอบ' : 'เวลาเลิก'}
                    </label>
                    {form.type === 'exam' ? (
                      <input
                        type="number"
                        min="0.5"
                        step="0.5"
                        value={form.examHours}
                        onChange={event => setForm(prev => ({ ...prev, examHours: event.target.value }))}
                        disabled={form.allDay}
                        className="w-full surface-2 border border-muted rounded-2xl px-4 py-3 text-sm text-[color:var(--text)] focus:outline-none focus:border-[color:var(--accent)] focus:ring-2 focus:ring-[color:var(--accent)]/20 disabled:opacity-60"
                      />
                    ) : (
                      <select
                        value={form.endTime}
                        onChange={event => setForm(prev => ({ ...prev, endTime: event.target.value }))}
                        disabled={form.allDay}
                        className="w-full surface-2 border border-muted rounded-2xl px-4 py-3 text-sm text-[color:var(--text)] focus:outline-none focus:border-[color:var(--accent)] focus:ring-2 focus:ring-[color:var(--accent)]/20 disabled:opacity-60"
                      >
                        <option value="">--.--</option>
                        {timeOptions.map(option => (
                          <option key={option} value={option} className="bg-[color:var(--surface-3)] text-[color:var(--text)]">
                            {formatTimeOptionLabel(option)}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>

                {form.type !== 'exam' ? (
                  <div>
                    <label className="mb-1 block text-sm font-semibold text-[color:var(--text)]">รายละเอียดเพิ่มเติม</label>
                    <textarea
                      value={form.description}
                      onChange={event => setForm(prev => ({ ...prev, description: event.target.value }))}
                      className="min-h-[110px] w-full surface-2 border border-muted rounded-2xl px-4 py-3 text-sm text-[color:var(--text)] placeholder:text-muted focus:outline-none focus:border-[color:var(--accent)] focus:ring-2 focus:ring-[color:var(--accent)]/20"
                    />
                  </div>
                ) : null}

                <button
                  type="submit"
                  disabled={saving}
                  className="w-full py-3 rounded-[24px] bg-primary text-[color:var(--on-accent)] font-bold text-sm shadow-glow hover:opacity-90 transition-all disabled:opacity-60"
                >
                  {saving ? 'กำลังบันทึก...' : editingEventId ? 'บันทึกการแก้ไข' : 'บันทึกตาราง'}
                </button>
              </form>
            </section>
          )}

          <section className="bg-[color:var(--panel-bg)] backdrop-blur-xl border border-muted rounded-[32px] overflow-hidden p-5 shadow-soft">
            <h5 className="text-xs font-bold text-muted uppercase mb-4 px-1">สรุปภาพรวมสัปดาห์</h5>
            <div className="flex items-end gap-2 h-20 px-2">
              {weeklySummary.values.map((count, index) => {
                const height = Math.round((count / weeklySummary.max) * 100);
                const isHighlight = index === new Date(parseISO(selectedDate)).getDay();
                return (
                  <div
                    key={index}
                    style={{ height: `${height}%` }}
                    className={`flex-1 rounded-t-lg transition-all duration-500 ${
                      isHighlight
                        ? 'bg-primary shadow-glow'
                        : 'bg-[color:var(--surface-2)] hover:bg-[color:var(--surface-3)]'
                    }`}
                    title={`${count} รายการ`}
                  />
                );
              })}
            </div>
            <div className="flex justify-between mt-2 text-[8px] text-muted px-1 font-bold uppercase">
              <span>Sun</span><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span>
            </div>
          </section>
        </aside>
      </div>
      </div>
    </div>
  );
};
