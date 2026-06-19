// DocumentSummaryPage.tsx
import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from 'react';
import { api, apiFallbackClients, assetBaseURL } from '../../services/api';
import { getLastSubjectKey } from '../../constants/storage';
import { useAppAlert } from '../../context/AppAlertContext';
import { useAuth } from '../../context/AuthContext';
import { useSemesterOptions } from '../../hooks/useSemesterOptions';
import { VoiceSummaryPage } from './VoiceSummaryPage';
import { subscribeSubjectsUpdated } from '../../utils/subjectSync';
import { resolveStudyFileUrl, uploadStudyFileToSupabase } from '../../utils/studyFiles';

type DocumentSummaryResult = {
  summary?: string;
  model?: string;
  text?: string;
  message?: string;
  error?: string;
};

type DocumentExtractResult = {
  text?: string;
  message?: string;
  error?: string;
};

type SavedSummary = {
  id: number;
  content: string;
  title?: string;
  created_at?: string;
  period?: SummaryCategory | null;
  subject_name?: string;
  original_subject_id?: number | null;
};

type ArchivedSummary = {
  id: number;
  original_subject_id?: number;
  subject_name?: string;
  period?: SummaryCategory | null;
  name: string;
  description: string;
  color?: string | null;
  target_hours?: number | null;
  start_date?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  archived_at?: string;
};

type SummaryPeriod = 'all' | 'daily' | 'weekly' | 'monthly';
type SummaryCategory = Exclude<SummaryPeriod, 'all'>;

type SubjectOption = {
  id: number;
  name: string;
  semester_id?: number | null;
  semester?: number | null;
  academic_year?: number | null;
};

type MoodOption = {
  value: string;
  label: string;
};

const unwrapCollection = (payload: any): any[] => {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.data)) return payload.data.data;
  if (Array.isArray(payload?.subjects)) return payload.subjects;
  if (Array.isArray(payload?.result)) return payload.result;
  return [];
};

const toNumericOrNull = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const buildSemesterFilterKey = (subject?: SubjectOption | null) => {
  if (!subject) return null;
  if (Number.isFinite(Number(subject.semester_id))) return `id:${Number(subject.semester_id)}`;
  if (Number.isFinite(Number(subject.semester)) && Number.isFinite(Number(subject.academic_year))) {
    return `sy:${Number(subject.semester)}-${Number(subject.academic_year)}`;
  }
  return null;
};

const normalizeSubjectOptions = (rows: any[]): SubjectOption[] => {
  return rows.reduce<SubjectOption[]>((acc, item: any) => {
      if (!item || typeof item !== 'object') return acc;
      const rawId = item.id ?? item.subject_id;
      const id = typeof rawId === 'string' ? Number(rawId) : rawId;
      const name = item.name ?? item.subject_name ?? item.title;
      if (!Number.isFinite(id) || typeof name !== 'string' || !name.trim()) return acc;
      acc.push({
        id,
        name: name.trim(),
        semester_id: toNumericOrNull(item.semester_id),
        semester: toNumericOrNull(item.semester),
        academic_year: toNumericOrNull(item.academic_year),
      });
      return acc;
    }, []);
};

const summaryEndpoint = '/ai/summarize/document';
const extractEndpoint = '/ai/analyze/document';
const moodOptions: MoodOption[] = [
  { value: 'สนุก', label: 'สนุก' },
  { value: 'เฉย ๆ', label: 'เฉย ๆ' },
  { value: 'เครียด', label: 'เครียด' },
];

const allowedTypes = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain'
];

const allowedExtensions = ['pdf', 'doc', 'docx', 'txt'];

const formatFileSize = (bytes: number) => {
  if (!Number.isFinite(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
};

const isAllowedFile = (file: File) => {
  if (allowedTypes.includes(file.type)) return true;
  const ext = file.name.split('.').pop()?.toLowerCase();
  return !!ext && allowedExtensions.includes(ext);
};

const storageBase = assetBaseURL || (api.defaults.baseURL ?? '').replace(/\/api\/?$/, '');

const formatLocalDate = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const stripExtension = (filename: string) => filename.replace(/\.[^/.]+$/, '');
const normalizeSummaryId = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const isDocumentSummaryTitle = (title: string) => {
  const normalized = title.trim().toLowerCase();
  return normalized.startsWith('สรุปเอกสาร');
};

const buildLocalSummary = (text: string) => {
  const cleaned = text.trim();
  if (!cleaned) return '';

  const lines = cleaned
    .split(/\r\n|\n|\r/)
    .map(line => line.trim())
    .filter(Boolean);

  const source = lines.length >= 3 ? lines : cleaned.split(/(?<=[.!?。！？])\s+/u).filter(Boolean);
  const selected = source.filter(line => line.length >= 12).slice(0, 5);
  if (!selected.length) return cleaned.slice(0, 300);

  return selected.map(line => `- ${line}`).join('\n');
};

const isDocumentSummary = (summary: any, logTitle?: string) => {
  if (summary?.metadata?.source === 'document') return true;
  return typeof logTitle === 'string' && isDocumentSummaryTitle(logTitle);
};

const summaryCategoryLabels: Record<SummaryCategory, string> = {
  daily: 'รายวัน',
  weekly: 'รายสัปดาห์',
  monthly: 'รายเดือน',
};

const normalizeSummaryPeriod = (value?: string, title?: string) => {
  if (value === 'daily' || value === 'weekly' || value === 'monthly') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'daily' || normalized === 'weekly' || normalized === 'monthly') {
      return normalized as SummaryCategory;
    }
  }
  if (typeof title === 'string') {
    if (title.includes('รายวัน')) return 'daily';
    if (title.includes('รายสัปดาห์')) return 'weekly';
    if (title.includes('รายเดือน')) return 'monthly';
  }
  return null;
};

const formatSummaryDate = (value?: string) => {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('th-TH');
};

const extractErrorMessage = (error: any, fallback: string) => {
  const message = error?.response?.data?.message;
  if (typeof message === 'string' && message.trim() !== '') {
    return message;
  }
  const errors = error?.response?.data?.errors;
  if (errors && typeof errors === 'object') {
    const firstKey = Object.keys(errors)[0];
    const firstMessage = firstKey ? errors[firstKey]?.[0] : null;
    if (typeof firstMessage === 'string' && firstMessage.trim() !== '') {
      return firstMessage;
    }
  }
  if (typeof error?.message === 'string' && error.message.trim() !== '') {
    return error.message;
  }
  return fallback;
};

export const DocumentSummaryPage = () => {
  const { error } = useAppAlert();
  const { user } = useAuth();
  const isArchivePage = false;
  
  // UI State
  const [inputMode, setInputMode] = useState<'document' | 'audio'>('document');
  const [activeHistoryTab, setActiveHistoryTab] = useState<'saved' | 'original' | 'archived'>('saved');

  const subjectFetchClients = useMemo(() => {
    const isDev = import.meta.env.DEV;
    const hostname = typeof window !== 'undefined' ? window.location.hostname : '';
    const isLocalNetworkHost =
      /^localhost$/i.test(hostname) ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      /^192\.168\./.test(hostname) ||
      /^10\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname);
    const isLocalhost =
      typeof window !== 'undefined' &&
      (isLocalNetworkHost || isDev);
    return isLocalhost ? [api] : apiFallbackClients;
  }, []);
  const [statusText, setStatusText] = useState('อัปโหลดไฟล์เอกสารเพื่อให้ AI ช่วยสรุปเนื้อหาแบบอ่านง่าย');
  const [isLoading, setIsLoading] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [originalText, setOriginalText] = useState<string | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [originalError, setOriginalError] = useState<string | null>(null);
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [subjects, setSubjects] = useState<SubjectOption[]>([]);
  const [selectedSemesterKey, setSelectedSemesterKey] = useState<string>('all');
  const [selectedSubjectId, setSelectedSubjectId] = useState('');
  const [selectedMood, setSelectedMood] = useState('');
  const [dbStatus, setDbStatus] = useState<string | null>(null);
  const [dbError, setDbError] = useState<string | null>(null);
  const [dbFileUrl, setDbFileUrl] = useState<string | null>(null);
  const [dbFileName, setDbFileName] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [, setDbLogTitle] = useState<string | null>(null);
  const [, setDbLogId] = useState<number | null>(null);
  const [dbSubjectId, setDbSubjectId] = useState<number | null>(null);
  const [, setSummaryModel] = useState<string | null>(null);
  const [, setSummarySavedLogId] = useState<number | null>(null);
  const [savedSummary, setSavedSummary] = useState<SavedSummary | null>(null);
  const [savedSummaries, setSavedSummaries] = useState<SavedSummary[]>([]);
  const [summaryPeriod, setSummaryPeriod] = useState<SummaryPeriod>('all');
  const [savedSummaryPage, setSavedSummaryPage] = useState(1);
  const [saveSummaryPeriod, setSaveSummaryPeriod] = useState<SummaryCategory>('daily');
  const [isSavingSummary, setIsSavingSummary] = useState(false);
  const [isResultSectionCollapsed, setIsResultSectionCollapsed] = useState(false);
  const [savedSummarySignature, setSavedSummarySignature] = useState<string | null>(null);
  const [, setSelectedArchiveIds] = useState<number[]>([]);
  const [deletingSummaryId, setDeletingSummaryId] = useState<number | null>(null);
  const lastSubjectKey = useMemo(() => getLastSubjectKey(user?.id), [user?.id]);
  const [archivedSummaries, setArchivedSummaries] = useState<ArchivedSummary[]>([]);
  const selectedSubject = useMemo(
    () => subjects.find(item => String(item.id) === selectedSubjectId) ?? null,
    [subjects, selectedSubjectId]
  );
  const semesterFilterOptions = useSemesterOptions();
  const semesterFilteredSubjects = useMemo(() => {
    if (selectedSemesterKey === 'all') return subjects;
    return subjects.filter(subject => buildSemesterFilterKey(subject) === selectedSemesterKey);
  }, [subjects, selectedSemesterKey]);
  const selectedSubjectName = useMemo(
    () => selectedSubject?.name ?? null,
    [selectedSubject]
  );
  const archiveDisplaySummaries = archivedSummaries;

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const saveSummaryPeriodRef = useRef<SummaryCategory>('daily');
  const summaryPeriodOptions: { key: SummaryPeriod; label: string }[] = [
    { key: 'all', label: 'ทั้งหมด' },
    { key: 'daily', label: 'รายวัน' },
    { key: 'weekly', label: 'รายสัปดาห์' },
    { key: 'monthly', label: 'รายเดือน' }
  ];
  const saveSummaryPeriodOptions: { key: SummaryCategory; label: string }[] = [
    { key: 'daily', label: 'รายวัน' },
    { key: 'weekly', label: 'รายสัปดาห์' },
    { key: 'monthly', label: 'รายเดือน' }
  ];

  const fetchSubjects = async (cancelledRef?: { current: boolean }) => {
    let list: SubjectOption[] = [];

    for (const client of subjectFetchClients) {
      try {
        const res = await client.get('/subjects');
        const rows = unwrapCollection(res.data);
        const normalized = normalizeSubjectOptions(rows);
        if (normalized.length > 0) {
          list = normalized;
          break;
        }
        if (list.length === 0) {
          list = normalized;
        }
      } catch {
        // try next fallback client
      }
    }

    if (cancelledRef?.current) return;

    setSubjects(list);

    if (isArchivePage) {
      setSelectedSubjectId('');
      return;
    }

    const storedId = localStorage.getItem(lastSubjectKey);
    if (storedId && list.some(subject => String(subject.id) === storedId)) {
      setSelectedSubjectId(storedId);
      return;
    }

    if (list[0]?.id) {
      const fallbackId = String(list[0].id);
      setSelectedSubjectId(fallbackId);
      localStorage.setItem(lastSubjectKey, fallbackId);
    } else {
      setSelectedSubjectId('');
      localStorage.removeItem(lastSubjectKey);
    }
  };

  useEffect(() => {
    return () => {
      if (sourceUrl) {
        URL.revokeObjectURL(sourceUrl);
      }
    };
  }, [sourceUrl]);

  useEffect(() => {
    saveSummaryPeriodRef.current = saveSummaryPeriod;
  }, [saveSummaryPeriod]);

  useEffect(() => {
    const cancelledRef = { current: false };
    void fetchSubjects(cancelledRef);
    const unsubscribe = subscribeSubjectsUpdated(() => {
      void fetchSubjects(cancelledRef);
    });
    return () => {
      cancelledRef.current = true;
      unsubscribe();
    };
  }, [lastSubjectKey, isArchivePage, subjectFetchClients]);

  useEffect(() => {
    if (selectedSemesterKey === 'all') return;
    const exists = semesterFilterOptions.some(option => option.key === selectedSemesterKey);
    if (!exists) {
      setSelectedSemesterKey('all');
    }
  }, [selectedSemesterKey, semesterFilterOptions]);

  useEffect(() => {
    if (isArchivePage) {
      if (selectedSubjectId && !semesterFilteredSubjects.some(item => String(item.id) === selectedSubjectId)) {
        setSelectedSubjectId('');
      }
      return;
    }

    if (selectedSubjectId && semesterFilteredSubjects.some(item => String(item.id) === selectedSubjectId)) {
      return;
    }

    const fallbackSubject = semesterFilteredSubjects[0];
    if (!fallbackSubject) {
      setSelectedSubjectId('');
      localStorage.removeItem(lastSubjectKey);
      return;
    }

    const fallbackId = String(fallbackSubject.id);
    setSelectedSubjectId(fallbackId);
    localStorage.setItem(lastSubjectKey, fallbackId);
  }, [
    isArchivePage,
    lastSubjectKey,
    selectedSubjectId,
    semesterFilteredSubjects,
  ]);

  useEffect(() => {
    const loadSavedSummaries = async () => {
      try {
        const items: SavedSummary[] = [];

        const pushLogSummaries = (logs: any[], subject?: SubjectOption | null) => {
          logs.forEach((log: any) => {
            const title = typeof log?.title === 'string' ? log.title : '';
            const summaries = Array.isArray(log?.summaries) ? log.summaries : [];
            summaries.forEach((summaryItem: any) => {
              const content = typeof summaryItem?.content === 'string' ? summaryItem.content : '';
              if (!content.trim()) return;
              if (!isDocumentSummary(summaryItem, title)) return;
              const normalizedId = normalizeSummaryId(summaryItem?.id);
              if (normalizedId === null) return;
              const period = normalizeSummaryPeriod(summaryItem?.metadata?.period, title);
              items.push({
                id: normalizedId,
                content,
                title,
                created_at: summaryItem?.created_at ?? log.created_at,
                period,
                subject_name: subject?.name,
                original_subject_id: subject?.id ?? null,
              });
            });
          });
        };

        if (isArchivePage) {
          const targetSubjects = selectedSubjectId
            ? semesterFilteredSubjects.filter(subject => String(subject.id) === selectedSubjectId)
            : semesterFilteredSubjects;

          if (targetSubjects.length === 0) {
            setSavedSummary(null);
            setSavedSummaries([]);
            return;
          }

          const results = await Promise.allSettled(
            targetSubjects.map(subject => api.get(`/subjects/${subject.id}/study-logs`))
          );

          results.forEach((result, index) => {
            if (result.status !== 'fulfilled') return;
            const payload = Array.isArray(result.value.data) ? result.value.data : result.value.data?.data;
            const logs = Array.isArray(payload) ? payload : [];
            pushLogSummaries(logs, targetSubjects[index] ?? null);
          });
        } else {
          if (!selectedSubjectId) {
            setSavedSummary(null);
            setSavedSummaries([]);
            return;
          }

          const res = await api.get(`/subjects/${selectedSubjectId}/study-logs`);
          const payload = Array.isArray(res.data) ? res.data : res.data?.data;
          const logs = Array.isArray(payload) ? payload : [];
          const selectedSubject = subjects.find(item => String(item.id) === selectedSubjectId) ?? null;
          pushLogSummaries(logs, selectedSubject);
        }

        const toTime = (value?: string) => (value ? new Date(value).getTime() : 0);
        items.sort((a, b) => toTime(b.created_at) - toTime(a.created_at));
        setSavedSummaries(items);
        setSavedSummary(items[0] ?? null);
      } catch (err) {
        setSavedSummary(null);
        setSavedSummaries([]);
      }
    };

    loadSavedSummaries();
  }, [isArchivePage, selectedSubjectId, semesterFilteredSubjects, subjects]);

  useEffect(() => {
    const loadArchivedSummaries = async () => {
      const mapArchiveItems = (items: any[], fallbackSubjectId?: number, fallbackSubjectName?: string) =>
        items
          .map((item: any) => ({
            id: normalizeSummaryId(item?.id) ?? 0,
            original_subject_id:
              normalizeSummaryId(item?.original_subject_id) ?? fallbackSubjectId ?? undefined,
            subject_name: fallbackSubjectName,
            period: normalizeSummaryPeriod(item?.metadata?.period ?? item?.period, item?.name),
            name: typeof item?.name === 'string' ? item.name : '',
            description: typeof item?.description === 'string' ? item.description : '',
            color: typeof item?.color === 'string' ? item.color : null,
            target_hours: Number.isFinite(Number(item?.target_hours)) ? Number(item?.target_hours) : null,
            start_date: typeof item?.start_date === 'string' ? item.start_date : null,
            start_time: typeof item?.start_time === 'string' ? item.start_time : null,
            end_time: typeof item?.end_time === 'string' ? item.end_time : null,
            archived_at: item?.archived_at,
          }))
          .filter(item => item.id && item.name);

      const loadAllSubjectsArchives = async () => {
        if (subjects.length === 0) {
          setArchivedSummaries([]);
          return;
        }

        const results = await Promise.allSettled(
          subjects.map(subject => api.get(`/subjects/${subject.id}/summary-archives`))
        );

        const merged: ArchivedSummary[] = [];
        results.forEach((result, index) => {
          if (result.status !== 'fulfilled') return;
          const payload = Array.isArray(result.value.data) ? result.value.data : result.value.data?.data;
          const items = Array.isArray(payload) ? payload : [];
          const subject = subjects[index];
          merged.push(
            ...mapArchiveItems(items, subject?.id, subject?.name)
          );
        });

        merged.sort((a, b) => {
          const aTime = a.archived_at ? new Date(a.archived_at).getTime() : 0;
          const bTime = b.archived_at ? new Date(b.archived_at).getTime() : 0;
          return bTime - aTime;
        });

        setArchivedSummaries(merged);
      };

      try {
        if (isArchivePage) {
          await loadAllSubjectsArchives();
          return;
        }

        await loadAllSubjectsArchives();
      } catch {
        setArchivedSummaries([]);
      }
    };

    loadArchivedSummaries();
  }, [selectedSubjectId, isArchivePage, subjects]);

  const fileInfo = useMemo(() => {
    if (!selectedFile) return null;
    return `${selectedFile.name} · ${formatFileSize(selectedFile.size)}`;
  }, [selectedFile]);

  const summarySaveSignature = useMemo(() => {
    const summaryText = summary?.trim();
    const subjectKey = dbSubjectId || Number(selectedSubjectId) || 'none';
    if (!summaryText) return null;
    return `${subjectKey}::${summaryText}`;
  }, [summary, dbSubjectId, selectedSubjectId]);

  const isSummarySaved = Boolean(summarySaveSignature && summarySaveSignature === savedSummarySignature);
  const canSaveSummary = Boolean(summarySaveSignature) && !isSummarySaved && !isSavingSummary;
  const activeSummaries = useMemo(() => savedSummaries, [savedSummaries]);
  const subjectNameById = useMemo(
    () => new Map(subjects.map(subject => [subject.id, subject.name])),
    [subjects]
  );
  
  const archivedItems = useMemo<SavedSummary[]>(
    () =>
      archiveDisplaySummaries.map(item => ({
        id: item.id,
        content: item.description,
        title: item.name,
        created_at: item.archived_at,
        period: item.period ?? normalizeSummaryPeriod(undefined, item.name),
        subject_name:
          item.subject_name ??
          (item.original_subject_id ? subjectNameById.get(item.original_subject_id) : undefined),
        original_subject_id: item.original_subject_id ?? null,
      })),
    [archiveDisplaySummaries, subjectNameById]
  );
  
  const archivedSummaryKeys = useMemo(
    () =>
      new Set(
        archivedItems.map(item =>
          `${item.original_subject_id ?? selectedSubjectId ?? 'none'}::${item.title ?? ''}::${item.content}`
        )
      ),
    [archivedItems, selectedSubjectId]
  );
  
  const summarySource = activeSummaries;
  const filteredSummaries = useMemo(() => {
    const subjectFiltered =
      isArchivePage && selectedSubjectId
        ? summarySource.filter(item => item.original_subject_id === Number(selectedSubjectId))
        : summarySource;
    if (summaryPeriod === 'all') return subjectFiltered;
    return subjectFiltered.filter(item => item.period === summaryPeriod);
  }, [summarySource, summaryPeriod, isArchivePage, selectedSubjectId]);
  
  const savedSummaryPageSize = 10;
  const totalSavedSummaryPages = Math.max(1, Math.ceil(filteredSummaries.length / savedSummaryPageSize));
  const paginatedSummaries = useMemo(() => {
    const startIndex = (savedSummaryPage - 1) * savedSummaryPageSize;
    return filteredSummaries.slice(startIndex, startIndex + savedSummaryPageSize);
  }, [filteredSummaries, savedSummaryPage]);
  
  const filteredArchivedSummaries = useMemo(() => {
    if (summaryPeriod === 'all') return archivedItems;
    return archivedItems.filter(item => item.period === summaryPeriod);
  }, [archivedItems, summaryPeriod]);
  
  const activeSummaryText = summary || savedSummary?.content || '';
  const activeSummaryTitle = savedSummary?.title ?? 'ผลลัพธ์การสรุป';
  const hasResultContent = activeSummaryText.trim() !== '';
  const savedCountLabel = savedSummaries.length > 99 ? '99+' : String(savedSummaries.length);
  const archiveCountLabel = filteredArchivedSummaries.length > 99 ? '99+' : String(filteredArchivedSummaries.length);

  useEffect(() => {
    setSelectedArchiveIds([]);
  }, [selectedSubjectId, isArchivePage]);

  useEffect(() => {
    setSavedSummaryPage(1);
  }, [selectedSubjectId, selectedSemesterKey, summaryPeriod, savedSummaries.length]);

  const isAlreadyArchived = (item: SavedSummary) =>
    archivedSummaryKeys.has(
      `${item.original_subject_id ?? selectedSubjectId ?? 'none'}::${item.title ?? ''}::${item.content}`
    );

  const ensureArchiveSubjectId = async () => {
    if (selectedSubjectId) return selectedSubjectId;

    if (subjects[0]?.id) {
      const fallbackId = String(subjects[0].id);
      setSelectedSubjectId(fallbackId);
      localStorage.setItem(lastSubjectKey, fallbackId);
      return fallbackId;
    }

    setGeneralError('กรุณาเพิ่มวิชาอย่างน้อย 1 วิชาก่อนเก็บถาวร');
    return null;
  };

    const archiveSummary = async (id: number, summaryOverride?: SavedSummary) => {
      const fallbackSubjectId = await ensureArchiveSubjectId();
      if (!fallbackSubjectId) {
        setGeneralError('กรุณาเพิ่มวิชาอย่างน้อย 1 วิชาก่อนเก็บถาวร');
        return;
      }

      const target = summaryOverride ?? savedSummaries.find(item => item.id === id);
      if (!target) return;

      try {
        const res = await api.post(`/subjects/${fallbackSubjectId}/summary-archives`, {
          name: target.title ?? 'สรุปเอกสาร',
          description: target.content,
        });
        const payload = res.data?.data ?? res.data;
        const archiveId = normalizeSummaryId(payload?.id);
        if (archiveId) {
          const nextArchive: ArchivedSummary = {
            id: archiveId,
            original_subject_id: normalizeSummaryId(payload?.original_subject_id) ?? undefined,
            name: typeof payload?.name === 'string' ? payload.name : target.title ?? 'สรุปเอกสาร',
            description: typeof payload?.description === 'string' ? payload.description : target.content,
            color: typeof payload?.color === 'string' ? payload.color : null,
            target_hours: Number.isFinite(Number(payload?.target_hours))
              ? Number(payload?.target_hours)
              : null,
            start_date: typeof payload?.start_date === 'string' ? payload.start_date : null,
            start_time: typeof payload?.start_time === 'string' ? payload.start_time : null,
            end_time: typeof payload?.end_time === 'string' ? payload.end_time : null,
            archived_at: payload?.archived_at ?? new Date().toISOString(),
          };
          setArchivedSummaries(prev => [nextArchive, ...prev.filter(item => item.id !== archiveId)]);
          setStatusText('เก็บถาวรเรียบร้อยแล้ว');
        }
        setSelectedArchiveIds(prev => prev.filter(item => item !== id));
        window.dispatchEvent(new Event('slt:archive-refresh'));
        localStorage.setItem(lastSubjectKey, fallbackSubjectId);
      } catch (error) {
      setGeneralError(extractErrorMessage(error, 'เก็บถาวรไม่สำเร็จ'));
    }
  };

  const restoreSummary = async (summaryItem: SavedSummary) => {
    const archiveId = summaryItem.id;
    const targetSubjectId =
      selectedSubjectId ||
      (Number.isFinite(Number(summaryItem.original_subject_id)) ? String(summaryItem.original_subject_id) : '');

    if (!targetSubjectId) {
      setGeneralError('ไม่พบวิชาของรายการที่ต้องการนำกลับ');
      return;
    }

    if (archiveId < 0) {
      setArchivedSummaries(prev => prev.filter(summary => summary.id !== archiveId));
      window.dispatchEvent(new Event('slt:archive-refresh'));
      localStorage.setItem(lastSubjectKey, targetSubjectId);
      setActiveHistoryTab('saved'); 
      return;
    }

    try {
      await api.delete(`/subjects/${targetSubjectId}/summary-archives/${archiveId}`);
      setArchivedSummaries(prev => prev.filter(item => item.id !== archiveId));
      window.dispatchEvent(new Event('slt:archive-refresh'));
      localStorage.setItem(lastSubjectKey, targetSubjectId);
      setActiveHistoryTab('saved');
    } catch (error) {
      setGeneralError(extractErrorMessage(error, 'นำกลับไม่สำเร็จ'));
    }
  };

  const closeViewedSummary = () => {
    setSavedSummary(null);
    setSummary(null);
    setSummaryError(null);
    setGeneralError(null);
    setStatusText('ปิดข้อความที่เลือกแล้ว');
  };

  const viewSavedSummaryItem = (item: SavedSummary) => {
    if (savedSummary?.id === item.id) {
      closeViewedSummary();
      return;
    }
    setSummary(item.content);
    setSavedSummary(item);
    setSummaryError(null);
    setGeneralError(null);
    setStatusText('แสดงสรุปที่เลือกเรียบร้อยแล้ว');
    document.getElementById('result-section')?.scrollIntoView({ behavior: 'smooth' });
  };

  const deleteSavedSummary = async (item: SavedSummary) => {
    if (!Number.isFinite(item.id) || item.id <= 0) return;
    const confirmed = window.confirm(`ต้องการลบสรุป "${item.title ?? 'สรุปเอกสาร'}" ใช่หรือไม่?`);
    if (!confirmed) return;

    setGeneralError(null);
    setDeletingSummaryId(item.id);

    try {
      await api.delete(`/summaries/${item.id}`);
      setSavedSummaries(prev => prev.filter(summaryItem => summaryItem.id !== item.id));
      setSelectedArchiveIds(prev => prev.filter(summaryId => summaryId !== item.id));
      if (savedSummary?.id === item.id) {
        setSavedSummary(null);
        setSummary(null);
      }
      setStatusText('ลบสรุปเรียบร้อยแล้ว');
    } catch (error) {
      setGeneralError(extractErrorMessage(error, 'ลบสรุปไม่สำเร็จ'));
    } finally {
      setDeletingSummaryId(current => (current === item.id ? null : current));
    }
  };

  const triggerFileSelect = () => {
    if (isLoading) return;
    fileInputRef.current?.click();
  };

  const handleFileSelected = (file: File) => {
    if (!isAllowedFile(file)) {
      setGeneralError('รองรับเฉพาะไฟล์ PDF, DOC, DOCX หรือ TXT เท่านั้น');
      setStatusText('ไฟล์ที่อัปโหลดไม่รองรับ กรุณาเลือกไฟล์ใหม่');
      return;
    }

    setSelectedFile(file);
    setSummary(null);
    setOriginalText(null);
    setSummaryError(null);
    setOriginalError(null);
    setGeneralError(null);
    setDbStatus(null);
    setDbError(null);
    setDbFileUrl(null);
    setDbFileName(null);
    setDbLogTitle(null);
    setDbLogId(null);
    setDbSubjectId(null);
    setSummaryModel(null);
    setSummarySavedLogId(null);
    setStatusText('เลือกไฟล์แล้ว กดปุ่ม "สร้างสรุปเนื้อหา" เพื่อเริ่มสรุป');
    setSourceUrl(prev => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      handleFileSelected(file);
    }
    event.target.value = '';
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (isLoading) return;
    setIsDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) {
      handleFileSelected(file);
    }
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (!isDragging) setIsDragging(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
  };

  const escapeHtml = (value: string) =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const printHtmlInIframe = (html: string) => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    const iframe = document.createElement('iframe');
    iframe.setAttribute('title', 'print');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    iframe.style.opacity = '0';
    iframe.style.pointerEvents = 'none';

    document.body.appendChild(iframe);

    const win = iframe.contentWindow;
    const doc = win?.document;
    if (!win || !doc) {
      iframe.remove();
      error('ไม่สามารถเปิดหน้าพิมพ์ได้ กรุณาลองใหม่อีกครั้ง');
      return;
    }

    doc.open();
    doc.write(html);
    doc.close();

    let hasTriggeredPrint = false;
    const cleanup = () => {
      window.setTimeout(() => iframe.remove(), 1500);
    };

    const trigger = () => {
      if (hasTriggeredPrint) return;
      hasTriggeredPrint = true;
      try {
        win.focus();
        win.print();
      } finally {
        cleanup();
      }
    };

    iframe.onload = trigger;
    window.setTimeout(trigger, 250);
  };

  const printSummaryItem = (item: {
    title?: string | null;
    content: string;
    created_at?: string | null;
    subject_name?: string | null;
    period?: SummaryCategory | null;
  }) => {
    const title = item.title?.trim() ? item.title.trim() : 'สรุป';
    const subject = item.subject_name?.trim() ? item.subject_name.trim() : '';
    const period = item.period ? summaryCategoryLabels[item.period] : '';
    const createdAt = item.created_at ? formatSummaryDate(item.created_at) : '';
    const headerParts = [subject, period].filter(Boolean).join(' · ');

    const html = `<!doctype html>
<html lang="th">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color-scheme: light; }
      body {
        margin: 24px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Tahoma, Arial, sans-serif;
        color: #111827;
        background: #ffffff;
      }
      .meta { margin-top: 6px; font-size: 12px; color: #374151; }
      .meta span { margin-right: 10px; }
      h1 { margin: 0; font-size: 18px; line-height: 1.25; }
      .content {
        margin-top: 14px;
        padding-top: 14px;
        border-top: 1px solid #e5e7eb;
        white-space: pre-wrap;
        word-break: break-word;
        font-size: 14px;
        line-height: 1.6;
      }
      @media print {
        body { margin: 0.6in; }
      }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(title)}</h1>
    <div class="meta">
      ${headerParts ? `<span>${escapeHtml(headerParts)}</span>` : ''}
      ${createdAt ? `<span>${escapeHtml(createdAt)}</span>` : ''}
    </div>
    <div class="content">${escapeHtml(item.content ?? '')}</div>
  </body>
</html>`;

    printHtmlInIframe(html);
  };

  const handlePrintPdf = () => {
    const contentToPrint = (activeSummaryText || savedSummary?.content || summary || '').trim();
    if (!contentToPrint) {
      setGeneralError('ยังไม่มีสรุปให้พิมพ์');
      setStatusText('กรุณาสร้างสรุปก่อนสั่งพิมพ์');
      return;
    }

    printSummaryItem({
      title: activeSummaryTitle || savedSummary?.title || selectedFile?.name || 'สรุปเอกสาร',
      content: contentToPrint,
      created_at: savedSummary?.created_at ?? null,
      subject_name: selectedSubjectName || null,
      period: summaryPeriod === 'all' ? null : summaryPeriod
    });
  };

  const handleSaveSummary = async () => {
    const summaryText = summary?.trim();
    if (!summaryText) {
      setGeneralError('ยังไม่มีสรุปให้บันทึก');
      setStatusText('กรุณาสรุปเอกสารก่อนบันทึก');
      return;
    }
    const summaryTextForStorage = summaryText;

    if (summarySaveSignature && summarySaveSignature === savedSummarySignature) {
      setStatusText('บันทึกสรุปนี้ไว้แล้ว');
      return;
    }

    setIsSavingSummary(true);
    setDbError(null);
    setGeneralError(null);

    try {
      const archiveSubjectId = await ensureArchiveSubjectId();
      if (!archiveSubjectId) {
        throw new Error('กรุณาเพิ่มวิชาอย่างน้อย 1 วิชาก่อนบันทึกสรุป');
      }

      const selectedPeriod = saveSummaryPeriodRef.current;
      const periodLabel = summaryCategoryLabels[selectedPeriod];
      const fallbackTitle =
        savedSummary?.title?.trim() ||
        stripExtension(selectedFile?.name ?? '').trim() ||
        'สรุปเอกสาร';

      const archiveResponse = await api.post(`/subjects/${archiveSubjectId}/summary-archives`, {
        name: `${periodLabel}: ${fallbackTitle}`,
        description: summaryTextForStorage,
        period: selectedPeriod,
      });
      const archivePayload = archiveResponse.data?.data ?? archiveResponse.data;
      const archiveId = normalizeSummaryId(archivePayload?.id) ?? Date.now();
      const nextArchive: ArchivedSummary = {
        id: archiveId,
        original_subject_id: normalizeSummaryId(archivePayload?.original_subject_id) ?? Number(archiveSubjectId),
        subject_name:
          typeof archivePayload?.subject_name === 'string'
            ? archivePayload.subject_name
            : selectedSubject?.name,
        period: normalizeSummaryPeriod(archivePayload?.period, archivePayload?.name) ?? selectedPeriod,
        name: typeof archivePayload?.name === 'string' ? archivePayload.name : `${periodLabel}: ${fallbackTitle}`,
        description: typeof archivePayload?.description === 'string' ? archivePayload.description : summaryTextForStorage,
        color: typeof archivePayload?.color === 'string' ? archivePayload.color : null,
        target_hours: Number.isFinite(Number(archivePayload?.target_hours)) ? Number(archivePayload?.target_hours) : null,
        start_date: typeof archivePayload?.start_date === 'string' ? archivePayload.start_date : null,
        start_time: typeof archivePayload?.start_time === 'string' ? archivePayload.start_time : null,
        end_time: typeof archivePayload?.end_time === 'string' ? archivePayload.end_time : null,
        archived_at: archivePayload?.archived_at ?? new Date().toISOString(),
      };
      setArchivedSummaries(prev => [nextArchive, ...prev.filter(item => item.id !== archiveId)]);
      setSavedSummarySignature(`${archiveSubjectId}::${summaryText}`);
      window.dispatchEvent(new Event('slt:archive-refresh'));
      setStatusText('บันทึกสรุปไปยังสรุปที่เก็บถาวรเรียบร้อยแล้ว');
    } catch (error) {
      setDbError(extractErrorMessage(error, 'บันทึกสรุปไปยังสรุปที่เก็บถาวรไม่สำเร็จ'));
    } finally {
      setIsSavingSummary(false);
    }
  };

  const saveFileToDatabase = async (file: File) => {
    const fallbackSubjectId = subjects[0] ? String(subjects[0].id) : '';
    const subjectId = selectedSubjectId || fallbackSubjectId;

    if (!subjectId) {
      setDbError('กรุณาเลือกวิชาเพื่อบันทึกไฟล์ลงฐานข้อมูล');
      setDbStatus(null);
      return;
    }

    if (!selectedSubjectId && fallbackSubjectId) {
      setSelectedSubjectId(fallbackSubjectId);
      localStorage.setItem(lastSubjectKey, fallbackSubjectId);
    }

    setIsSaving(true);
    setDbStatus('กำลังบันทึกไฟล์ลงฐานข้อมูล...');
    setDbError(null);
    setDbFileUrl(null);
    setDbFileName(null);

    try {
      const titleBase = stripExtension(file.name).trim() || file.name;
      const logPayload = {
        title: `สรุปเอกสาร: ${titleBase}`,
        log_date: formatLocalDate(new Date()),
        note: 'อัปโหลดไฟล์เพื่อสรุปเอกสาร',
        mood: selectedMood || null,
        log_type: 'document_summary',
        is_summary: true
      };

      const logResponse = await api.post(`/subjects/${subjectId}/study-logs`, logPayload);
      const logData = logResponse.data?.data ?? logResponse.data;
      const logId = logData?.id;

      if (!logId) {
        throw new Error('ไม่สามารถบันทึกบันทึกการเรียนได้');
      }

      setDbLogId(logId);
      setDbSubjectId(Number(subjectId));
      setDbLogTitle(logPayload.title);

      let fileResponse;
      let publicFileUrl: string | null = null;
      let usedLocalUpload = false;

      try {
        const uploaded = await uploadStudyFileToSupabase({
          file,
          userId: user?.id,
          subject: {
            id: Number(subjectId),
            name: selectedSubject?.name ?? file.name,
            semester: selectedSubject?.semester,
            academic_year: selectedSubject?.academic_year,
          },
        });

        fileResponse = await api.post(`/study-logs/${logId}/files`, {
          original_name: file.name,
          storage_path: uploaded.storagePath,
          file_type: uploaded.fileType,
          mime_type: file.type || null,
          file_size: file.size,
        });
        publicFileUrl = uploaded.publicUrl;
      } catch (storageError) {
        console.warn('supabase upload failed, falling back to local storage', storageError);
        setDbStatus('Supabase ใช้งานไม่ได้ กำลังบันทึกไฟล์ลงระบบของเว็บแทน...');
        usedLocalUpload = true;

        const uploadForm = new FormData();
        uploadForm.append('file', file, file.name);
        fileResponse = await api.post(`/study-logs/${logId}/files`, uploadForm);
      }

      const fileData = fileResponse.data?.data ?? fileResponse.data;
      setDbFileName(fileData?.original_name ?? file.name);
      if (fileData?.file_path) {
        setDbFileUrl(publicFileUrl ?? resolveStudyFileUrl(fileData.file_path, assetBaseURL));
      }
      setDbStatus(usedLocalUpload ? 'บันทึกไฟล์ลงระบบของเว็บเรียบร้อยแล้ว' : 'บันทึกไฟล์ลงฐานข้อมูลเรียบร้อยแล้ว');
    } catch (error) {
      setDbStatus(null);
      setDbError(extractErrorMessage(error, 'บันทึกไฟล์ลงฐานข้อมูลไม่สำเร็จ'));
    } finally {
      setIsSaving(false);
    }
  };

  const processDocument = async (file: File) => {
    setIsLoading(true);

    const summaryForm = new FormData();
    summaryForm.append('file', file, file.name);

    const extractForm = new FormData();
    extractForm.append('file', file, file.name);

    try {
      const [summaryResult, extractResult] = await Promise.allSettled([
        api.post<DocumentSummaryResult>(summaryEndpoint, summaryForm),
        api.post<DocumentExtractResult>(extractEndpoint, extractForm)
      ]);

      let hasSuccess = false;
      let summaryTextValue = '';
      let extractTextValue = '';

      if (summaryResult.status === 'fulfilled') {
        const payload = summaryResult.value.data;
        const summaryRaw = typeof payload?.summary === 'string' ? payload.summary : '';
        const summaryText = summaryRaw.trim();
        summaryTextValue = summaryText;
        const summaryMessage =
          (typeof payload?.message === 'string' && payload.message.trim() !== '' ? payload.message : '') ||
          (typeof payload?.error === 'string' && payload.error.trim() !== '' ? payload.error : '');

        if (summaryText !== '') {
          setSummary(summaryRaw);
          setSummaryModel(payload?.model ?? null);
          hasSuccess = true;
        } else {
          setSummaryError(summaryMessage || 'ไม่สามารถสรุปเนื้อหาได้ กรุณาลองใหม่');
        }

        const extractedText = typeof payload?.text === 'string' ? payload.text : '';
        if (extractedText.trim() !== '') {
          extractTextValue = extractedText;
          setOriginalText(prev => (prev && prev.trim() !== '' ? prev : extractedText));
          hasSuccess = true;
        }
      } else {
        setSummaryError(extractErrorMessage(summaryResult.reason, 'ไม่สามารถสรุปเนื้อหาได้ กรุณาลองใหม่'));
      }

      if (extractResult.status === 'fulfilled') {
        extractTextValue = extractResult.value.data?.text ?? extractTextValue;
      }

      if (summaryResult.status !== 'fulfilled' || summaryTextValue === '') {
        const fallbackSummary = buildLocalSummary(extractTextValue);
        if (fallbackSummary) {
          setSummary(fallbackSummary);
          setSummaryModel('local');
          setSummaryError(null);
          hasSuccess = true;
        }
      } else {
        setSummaryError(null);
      }

      if (extractResult.status === 'fulfilled') {
        setOriginalText(extractResult.value.data?.text ?? '');
        hasSuccess = true;
      } else {
        setOriginalError(extractErrorMessage(extractResult.reason, 'ไม่สามารถดึงต้นฉบับจากไฟล์ได้ กรุณาลองใหม่'));
      }

      if (hasSuccess) {
        setStatusText('สรุปเสร็จแล้ว! ตรวจสอบต้นฉบับและสรุปได้ทันที');
        document.getElementById('result-section')?.scrollIntoView({ behavior: 'smooth' });
      } else {
        setGeneralError('เกิดข้อผิดพลาดระหว่างการสรุปเอกสาร');
        setStatusText('เกิดข้อผิดพลาดในการประมวลผลเอกสาร กรุณาลองอีกครั้ง');
      }
    } catch (err) {
      console.error(err);
      setGeneralError('เกิดข้อผิดพลาดระหว่างการประมวลผลเอกสาร');
      setStatusText('เกิดข้อผิดพลาดในการประมวลผลเอกสาร กรุณาลองอีกครั้ง');
    } finally {
      setIsLoading(false);
    }
  };

  const handleVoiceSummaryReady = (payload: { summary: string; transcript?: string; source: 'upload' | 'record' }) => {
    const summaryText = (payload.summary ?? '').trim();
    const transcriptText = (payload.transcript ?? '').trim();

    if (summaryText) {
      setSummary(payload.summary);
      setSummaryError(null);
      setSavedSummary(null);
    }

    if (transcriptText) {
      setOriginalText(payload.transcript ?? '');
      setOriginalError(null);
    }

    setGeneralError(null);
    setStatusText(payload.source === 'record' ? 'สรุปจากการอัดเสียงเสร็จแล้ว' : 'สรุปจากไฟล์เสียงเสร็จแล้ว');
    setActiveHistoryTab('saved');
    setIsResultSectionCollapsed(false);
  };

  const startSummary = () => {
    if (!selectedFile) {
      setGeneralError('กรุณาเลือกไฟล์เอกสารก่อนเริ่มสรุป');
      setStatusText('ยังไม่ได้เลือกไฟล์เอกสาร');
      return;
    }

    if (isLoading || isSaving) {
      return;
    }

    setGeneralError(null);
    setStatusText('กำลังสรุปเนื้อหาจากไฟล์...');
    processDocument(selectedFile);
    void saveFileToDatabase(selectedFile);
  };

  return (
    <div
      className="doc-summary-page relative min-h-screen overflow-hidden bg-transparent font-sans pb-[7.5rem] md:pb-16"
      style={{ ['--doc-accent-soft' as string]: 'rgba(var(--accent-rgb),0.10)' }}
    >
      {/* Print View */}
      <div className="hidden print:block text-slate-900 bg-white">
        <h1 className="text-xl font-semibold">สรุปเอกสาร</h1>
        <p className="mt-2 text-sm">{savedSummary?.title ?? 'สรุปเอกสาร'}</p>
        <pre className="mt-4 whitespace-pre-wrap text-sm">
          {summary || savedSummary?.content || 'ยังไม่มีสรุป'}
        </pre>
      </div>

      <div className="max-w-7xl mx-auto px-4 pb-4 pt-2 md:p-8 relative z-10 space-y-8 print:hidden">
        <style>{`
          .doc-summary-page::before {
            content: "";
            position: absolute;
            inset: 0;
            pointer-events: none;
            background:
              linear-gradient(135deg, rgba(var(--accent-rgb), 0.10), transparent 36%),
              linear-gradient(90deg, transparent 0%, rgba(34, 197, 94, 0.07) 58%, transparent 100%),
              linear-gradient(180deg, rgba(255,255,255,0.34), transparent 34%);
          }
          .doc-summary-header,
          .doc-summary-card {
            background:
              linear-gradient(145deg, rgba(255,255,255,0.92), rgba(255,255,255,0.70)),
              var(--surface) !important;
            border: 1px solid rgba(148, 163, 184, 0.22) !important;
            box-shadow: 0 24px 58px rgba(15, 23, 42, 0.10) !important;
            backdrop-filter: blur(24px);
          }
          .dark .doc-summary-header,
          .dark .doc-summary-card {
            background:
              linear-gradient(145deg, rgba(15,23,42,0.78), rgba(15,23,42,0.54)),
              var(--surface) !important;
            border-color: rgba(255,255,255,0.10) !important;
            box-shadow: 0 24px 58px rgba(0,0,0,0.28) !important;
          }
          .doc-summary-card {
            border-radius: 26px;
          }
          .doc-summary-header {
            border-radius: 30px;
            padding: 22px;
          }
          .doc-upload-zone {
            min-height: 260px;
            background:
              linear-gradient(145deg, rgba(var(--accent-rgb),0.08), rgba(255,255,255,0.58)) !important;
            border-color: rgba(var(--accent-rgb),0.24) !important;
          }
          .dark .doc-upload-zone {
            background:
              linear-gradient(145deg, rgba(var(--accent-rgb),0.16), rgba(15,23,42,0.46)) !important;
          }
          .doc-upload-zone:hover {
            transform: translateY(-2px);
            border-color: rgba(var(--accent-rgb),0.58) !important;
            box-shadow: 0 18px 44px rgba(var(--accent-rgb),0.14);
          }
          .doc-input-toggle button,
          .doc-save-period-tabs button,
          .doc-history-tabs button,
          .doc-toolbar-btn {
            min-height: 38px;
          }
          .doc-primary-action,
          .doc-toolbar-btn-primary,
          .doc-upload-select-btn {
            color: #fff !important;
          }
          .doc-result-panel {
            background:
              linear-gradient(180deg, rgba(255,255,255,0.80), rgba(248,250,252,0.74)) !important;
          }
          .dark .doc-result-panel {
            background:
              linear-gradient(180deg, rgba(15,23,42,0.58), rgba(2,6,23,0.38)) !important;
          }
          .doc-empty-state {
            border-style: dashed;
            border-color: rgba(148,163,184,0.24) !important;
          }
          .doc-summary-chip {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            border-radius: 999px;
            padding: 8px 12px;
            background: rgba(255,255,255,0.70);
            border: 1px solid rgba(148,163,184,0.22);
            color: var(--text);
            font-size: 12px;
            font-weight: 700;
          }
          .dark .doc-summary-chip {
            background: rgba(255,255,255,0.06);
            border-color: rgba(255,255,255,0.10);
          }
          @media (max-width: 640px) {
            .doc-summary-header {
              padding: 18px;
              border-radius: 24px;
            }
            .doc-summary-card {
              border-radius: 22px;
              padding: 18px !important;
            }
            .doc-upload-zone {
              min-height: 220px;
              padding: 24px 16px !important;
            }
            .doc-history-tabs,
            .doc-save-period-tabs {
              width: 100%;
            }
            .doc-history-tabs button,
            .doc-save-period-tabs button {
              flex: 1 0 auto;
            }
            .doc-toolbar-btn {
              flex: 1 1 calc(50% - 8px);
              justify-content: center;
            }
          }
        `}</style>
        
        {/* Header */}
        <header className="doc-summary-header mb-8 flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
          <div className="flex items-start gap-4">
            <div
              className="doc-summary-header-icon flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl shadow-lg"
              style={{
                background: 'linear-gradient(135deg, var(--accent), rgba(var(--accent-rgb),0.72))',
                boxShadow: '0 18px 38px rgba(var(--accent-rgb),0.30)'
              }}
            >
              <svg viewBox="0 0 24 24" className="h-7 w-7 text-white" fill="none">
                <path d="M6.7 3.8h7.2l3.4 3.5v12.9H6.7V3.8Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
                <path d="M13.7 3.9v3.7h3.6M9 11h6M9 14.5h6M9 18h3.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div>
              <span
                className="mb-2 inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]"
                style={{
                  background: 'rgba(var(--accent-rgb),0.12)',
                  border: '1px solid rgba(var(--accent-rgb),0.22)',
                  color: 'var(--accent)'
                }}
              >
                Smart Summary
              </span>
              <h1 className="text-2xl font-bold tracking-wide text-[color:var(--text)] md:text-3xl">สรุปเนื้อหาด้วย AI</h1>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-[color:var(--muted)]">
                อัปโหลดเอกสารหรือเสียง แล้วจัดเก็บสรุปแยกตามวิชาและช่วงเวลา
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="doc-summary-chip">
              <span className="h-2 w-2 rounded-full" style={{ background: 'var(--accent)' }} />
              {selectedSubjectName ?? 'ยังไม่เลือกวิชา'}
            </span>
            <span className="doc-summary-chip">{savedCountLabel} สรุป</span>
            <span className="doc-summary-chip">{archiveCountLabel} เก็บถาวร</span>
          </div>
        </header>

        {/* Section 1: Input & Settings */}
        {!isArchivePage && (
          <section
            className="doc-summary-card doc-summary-card-input rounded-3xl p-6 shadow-[0_24px_60px_rgba(15,23,42,0.08)] dark:shadow-2xl"
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              backdropFilter: 'blur(22px)'
            }}
          >

            {/* Step 1 */}
            <div className="mb-4 flex items-center gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white" style={{ background: 'var(--accent)' }}>1</span>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--accent)' }}>ขั้นที่ 1</p>
                <h3 className="text-[15px] font-bold leading-tight text-slate-800 dark:text-white">เลือกบริบท <span className="text-sm font-normal text-slate-400">เทอม / วิชา</span></h3>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
              {/* Semester Dropdown */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700 dark:text-slate-300 drop-shadow-sm dark:drop-shadow-none">ภาคเรียน</label>
                <div className="relative">
                  <select 
                    value={selectedSemesterKey}
                    onChange={event => setSelectedSemesterKey(event.target.value)}
                    className="w-full appearance-none text-slate-800 dark:text-white text-sm rounded-xl px-4 py-3 focus:outline-none backdrop-blur-md transition-all cursor-pointer"
                    style={{
                      background: 'var(--surface)',
                      border: '1px solid var(--border)',
                      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.7)'
                    }}
                  >
                    {semesterFilterOptions.map(option => (
                      <option key={option.key} value={option.key} className="bg-white text-slate-900 dark:bg-slate-900 dark:text-white">
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs text-slate-500 dark:text-slate-400 pointer-events-none">▼</span>
                </div>
              </div>

              {/* Subject Dropdown */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700 dark:text-slate-300 drop-shadow-sm dark:drop-shadow-none">วิชาที่เกี่ยวข้อง</label>
                <div className="relative">
                  <select 
                    value={selectedSubjectId}
                    onChange={event => {
                      const value = event.target.value;
                      setSelectedSubjectId(value);
                      if (value) localStorage.setItem(lastSubjectKey, value);
                    }}
                    className="w-full appearance-none text-slate-800 dark:text-white text-sm rounded-xl px-4 py-3 focus:outline-none backdrop-blur-md transition-all cursor-pointer"
                    style={{
                      background: 'var(--surface)',
                      border: '1px solid var(--border)',
                      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.7)'
                    }}
                  >
                    <option value="" className="bg-white text-slate-900 dark:bg-slate-900 dark:text-white">เลือกวิชาเพื่อบันทึกไฟล์ลงฐานข้อมูล</option>
                    {semesterFilteredSubjects.map(subject => (
                      <option key={subject.id} value={subject.id} className="bg-white text-slate-900 dark:bg-slate-900 dark:text-white">
                        {subject.name}
                      </option>
                    ))}
                  </select>
                  <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs text-slate-500 dark:text-slate-400 pointer-events-none">▼</span>
                </div>
                {semesterFilteredSubjects.length === 0 && (
                   <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                     ยังไม่มีวิชาในเทอมที่เลือก <a href="/subjects" className="font-semibold text-accent hover:opacity-80">ไปเพิ่มวิชา</a>
                   </p>
                )}
              </div>
            </div>

            {/* Step 2 */}
            <div className="mb-4 flex items-center gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white" style={{ background: 'var(--accent)' }}>2</span>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--accent)' }}>ขั้นที่ 2</p>
                <h3 className="text-[15px] font-bold leading-tight text-slate-800 dark:text-white">ใส่เนื้อหา <span className="text-sm font-normal text-slate-400">เอกสาร หรือ ไฟล์เสียง</span></h3>
              </div>
            </div>
            {/* Input Type Toggle */}
            <div
              className="doc-input-toggle flex p-1.5 backdrop-blur-md rounded-2xl mb-6 w-full max-w-md mx-auto"
              style={{
                background: 'var(--surface-2)',
                border: '1px solid var(--border)',
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.8)'
              }}
            >
              <button 
                type="button"
                onClick={() => setInputMode('document')}
                className={`flex-1 flex items-center justify-center space-x-2 border py-2.5 rounded-lg text-sm font-semibold transition-all ${
                  inputMode === 'document'
                    ? 'text-slate-900 shadow'
                    : 'border-transparent text-slate-500 dark:text-slate-200 hover:bg-white/25 dark:hover:bg-white/10 hover:text-slate-800 dark:hover:text-white'
                }`}
                style={
                  inputMode === 'document'
                    ? {
                        background: 'var(--accent)',
                        borderColor: 'var(--accent)',
                        color: '#ffffff'
                      }
                    : undefined
                }
              >
                <span>📄</span>
                <span>เอกสาร</span>
              </button>
              <button 
                type="button"
                onClick={() => setInputMode('audio')}
                className={`flex-1 flex items-center justify-center space-x-2 border py-2.5 rounded-lg text-sm font-semibold transition-all ${
                  inputMode === 'audio'
                    ? 'text-slate-900 shadow'
                    : 'border-transparent text-slate-500 dark:text-slate-200 hover:bg-white/25 dark:hover:bg-white/10 hover:text-slate-800 dark:hover:text-white'
                }`}
                style={
                  inputMode === 'audio'
                    ? {
                        background: 'var(--accent)',
                        borderColor: 'var(--accent)',
                        color: '#ffffff'
                      }
                    : undefined
                }
              >
                <span>🎙️</span>
                <span>ไฟล์เสียง</span>
              </button>
            </div>

            {/* Main Input Area */}
            {inputMode === 'document' ? (
              <>
                {/* Upload Dropzone */}
                <div 
                  onDrop={handleDrop}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onClick={triggerFileSelect}
                  className="doc-upload-zone border-2 border-dashed rounded-[28px] p-6 md:p-10 flex flex-col items-center justify-center transition-all group cursor-pointer backdrop-blur-sm"
                  style={{
                    borderColor: isDragging ? 'var(--accent)' : 'var(--border)',
                    background: isDragging ? 'var(--surface-2)' : 'var(--surface-2)'
                  }}
                >
                  <div
                    className="w-16 h-16 rounded-full flex items-center justify-center mb-4 group-hover:scale-110 transition-all text-2xl shadow-sm dark:shadow-none"
                    style={{
                      background: 'var(--accent)',
                      border: '1px solid var(--accent)',
                      color: '#ffffff'
                    }}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-7 w-7 text-slate-700 dark:text-slate-200" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.4-7.98A5.5 5.5 0 0117 9a3.5 3.5 0 01.5 6.96H15m-3-6v8m0 0l-3-3m3 3l3-3" />
                    </svg>
                  </div>
                  <h3 className="text-lg font-medium text-slate-800 dark:text-white mb-2">
                    {fileInfo ? 'พร้อมสรุปไฟล์ที่เลือกแล้ว' : 'ลากและวางไฟล์ หรือคลิกเพื่อเลือก'}
                  </h3>
                  <p className="text-sm text-slate-500 dark:text-slate-400 mb-6">
                    {fileInfo ?? 'รองรับ PDF, DOCX, TXT ขนาดไม่เกิน 20MB'}
                  </p>
                  <button
                    type="button"
                    disabled={isLoading}
                    className="doc-upload-select-btn px-6 py-2.5 text-sm font-bold rounded-full transition-all duration-200 disabled:opacity-50 backdrop-blur-md shadow-md hover:shadow-lg hover:-translate-y-0.5 active:translate-y-0 dark:shadow-none !text-white"
                    style={{
                      background: 'var(--accent)',
                      border: '1px solid var(--accent)',
                      color: '#ffffff',
                      WebkitTextFillColor: '#ffffff',
                      textShadow: '0 1px 2px rgba(0,0,0,0.35)',
                      boxShadow: '0 12px 26px rgba(var(--accent-rgb),0.40)'
                    }}
                  >
                    เลือกไฟล์จากเครื่อง
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf,.doc,.docx,.txt"
                    className="hidden"
                    onChange={handleFileChange}
                  />
                </div>

                <hr className="border-white/60 dark:border-white/10 my-8" />

                {/* Step 3 */}
                <div className="mb-4 flex items-center gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white" style={{ background: 'var(--accent)' }}>3</span>
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--accent)' }}>ขั้นที่ 3</p>
                    <h3 className="text-[15px] font-bold leading-tight text-slate-800 dark:text-white">ตั้งค่าการสรุป <span className="text-sm font-normal text-slate-400">รูปแบบ / อารมณ์</span></h3>
                  </div>
                </div>

                {/* Preferences */}
                <div className="flex flex-col md:flex-row items-center justify-between gap-6">
                  <div className="flex flex-col sm:flex-row items-center gap-4 w-full md:w-auto">
                    <span className="text-sm text-slate-700 dark:text-slate-300 font-medium">รูปแบบการสรุป:</span>
                    <div
                      className="doc-save-period-tabs flex rounded-xl p-1 border backdrop-blur-sm"
                      style={{
                      background: 'var(--surface-2)',
                      borderColor: 'var(--border)'
                    }}
                    >
                      {saveSummaryPeriodOptions.map(option => (
                        <button 
                          key={option.key}
                          type="button"
                          onClick={() => setSaveSummaryPeriod(option.key)}
                          className={`px-4 py-1.5 rounded-lg text-sm transition-all ${saveSummaryPeriod === option.key ? 'shadow-sm' : 'text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}`}
                          style={
                            saveSummaryPeriod === option.key
                              ? {
                                  background: 'var(--accent)',
                                  color: '#ffffff',
                                  border: '1px solid var(--accent)'
                                }
                              : undefined
                          }
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>

                    <div className="relative w-full sm:w-auto mt-2 sm:mt-0">
                      <select 
                        value={selectedMood}
                        onChange={event => setSelectedMood(event.target.value)}
                        className="doc-mood-select w-full sm:w-auto appearance-none text-slate-800 dark:text-white text-sm rounded-xl pl-10 pr-10 py-2.5 focus:outline-none backdrop-blur-md transition-all cursor-pointer"
                        style={{
                      background: 'var(--surface)',
                      border: '1px solid var(--border)'
                    }}
                      >
                        <option value="" className="bg-white text-slate-900 dark:bg-slate-900 dark:text-white">เลือกอารมณ์ก่อนบันทึกสรุป</option>
                        {moodOptions.map(option => (
                          <option key={option.value} value={option.value} className="bg-white text-slate-900 dark:bg-slate-900 dark:text-white">{option.label}</option>
                        ))}
                      </select>
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-600 dark:text-slate-300">😊</span>
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-500 dark:text-slate-400 pointer-events-none">▼</span>
                    </div>
                  </div>

                </div>

                {/* Submit */}
                <button
                  type="button"
                  onClick={startSummary}
                  disabled={!selectedFile || isLoading || isSaving}
                  className="doc-primary-action mt-7 w-full px-8 py-3.5 text-white font-bold rounded-xl shadow-xl transition-all duration-200 hover:-translate-y-0.5 hover:shadow-2xl active:translate-y-0 flex items-center justify-center space-x-2 disabled:opacity-50 disabled:cursor-not-allowed backdrop-blur-md"
                  style={{
                    background: 'var(--accent)',
                    boxShadow: '0 22px 38px rgba(var(--accent-rgb),0.35)',
                    border: '1px solid var(--accent)'
                  }}
                >
                  {isLoading || isSaving ? (
                    <>
                      <span className="animate-spin inline-block">⏳</span>
                      <span>กำลังประมวลผล...</span>
                    </>
                  ) : (
                    <>
                      <span>✨</span>
                      <span>สร้างสรุปเนื้อหา</span>
                    </>
                  )}
                </button>
              </>
            ) : (
              <div
                className="rounded-2xl p-2 backdrop-blur-md"
                style={{
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border)'
                }}
              >
                <VoiceSummaryPage key={inputMode} embedded onSummaryReady={handleVoiceSummaryReady} />
              </div>
            )}

            {/* Status / Errors Alerts */}
            <div className="mt-6 space-y-3">
              <div
                className="doc-status-banner rounded-xl px-4 py-2.5 text-[13px] font-medium flex items-center gap-2"
                style={{
                  border: '1px solid var(--border)',
                  borderLeft: '3px solid var(--accent)',
                  background: 'var(--surface-2)',
                  color: 'var(--muted)'
                }}
              >
                 <span>🕒</span> {statusText}
              </div>
              {generalError && (
                <div className="rounded-xl border border-rose-200 dark:border-rose-500/40 bg-rose-50/80 dark:bg-rose-500/20 px-4 py-3 text-sm text-rose-700 dark:text-rose-200 backdrop-blur-sm">{generalError}</div>
              )}
              {dbStatus && (
                <div className="rounded-xl border border-emerald-200 dark:border-emerald-500/40 bg-emerald-50/80 dark:bg-emerald-500/20 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-200 backdrop-blur-sm">
                  {dbStatus}
                  {dbFileUrl && (
                    <div className="mt-1">
                      <a href={dbFileUrl} target="_blank" rel="noopener noreferrer" className="text-xs font-semibold underline hover:text-emerald-800 dark:hover:text-emerald-100">
                        เปิดไฟล์ที่บันทึกแล้ว{dbFileName ? `: ${dbFileName}` : ''}
                      </a>
                    </div>
                  )}
                </div>
              )}
              {dbError && (
                <div className="rounded-xl border border-rose-200 dark:border-rose-500/40 bg-rose-50/80 dark:bg-rose-500/20 px-4 py-3 text-sm text-rose-700 dark:text-rose-200 backdrop-blur-sm">{dbError}</div>
              )}
            </div>

          </section>
        )}

        {/* Section 2: Output Result */}
        <section
          id="result-section"
          className="doc-summary-card doc-summary-card-result rounded-3xl p-6 shadow-[0_24px_60px_rgba(15,23,42,0.08)] dark:shadow-2xl"
          style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              backdropFilter: 'blur(22px)'
            }}
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
            <div className="flex items-center space-x-2">
              <span className="text-lg">📝</span>
              <h2 className="text-lg font-semibold text-slate-800 dark:text-white">ผลลัพธ์การสรุป</h2>
            </div>
            
            <div className="flex items-center space-x-2 flex-wrap gap-y-2">
              <button 
                type="button" 
                onClick={() => setIsResultSectionCollapsed(prev => !prev)}
                className="doc-toolbar-btn flex items-center space-x-1.5 px-3 py-1.5 bg-white/80 dark:bg-white/5 hover:bg-white dark:hover:bg-white/10 border border-slate-200 dark:border-white/10 text-xs font-medium rounded-lg transition-colors text-slate-700 dark:text-slate-200 backdrop-blur-md shadow-sm dark:shadow-none"
              >
                <span>↕️</span>
                <span>{isResultSectionCollapsed ? 'ขยายผลลัพธ์' : 'ย่อผลลัพธ์'}</span>
              </button>
              
              {savedSummary && (
                 <button
                   type="button"
                   onClick={closeViewedSummary}
                   className="doc-toolbar-btn flex items-center space-x-1.5 px-3 py-1.5 bg-white/70 dark:bg-white/5 hover:bg-white dark:hover:bg-white/10 border border-slate-200 dark:border-white/10 text-xs font-medium rounded-lg transition-colors text-slate-700 dark:text-slate-200 backdrop-blur-md shadow-sm dark:shadow-none"
                 >
                   <span>ปิดข้อความที่ดู</span>
                 </button>
              )}

              <button 
                type="button" 
                onClick={handlePrintPdf}
                className="doc-toolbar-btn flex items-center space-x-1.5 px-3 py-1.5 bg-white/70 dark:bg-white/5 hover:bg-white dark:hover:bg-white/10 border border-slate-200 dark:border-white/10 text-xs font-medium rounded-lg transition-colors text-slate-700 dark:text-slate-200 backdrop-blur-md shadow-sm dark:shadow-none"
              >
                <span>🖨️</span>
                <span>พิมพ์ / PDF</span>
              </button>

              <button 
                type="button"
                onClick={handleSaveSummary}
                disabled={!canSaveSummary}
                className="doc-toolbar-btn doc-toolbar-btn-primary flex items-center space-x-1.5 px-4 py-1.5 text-xs font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed backdrop-blur-md shadow-sm dark:shadow-none"
                style={{
                  background: 'var(--accent)',
                  color: '#ffffff',
                  border: '1px solid var(--accent)'
                }}
              >
                <span>💾</span>
                <span>{isSavingSummary ? 'กำลังบันทึก...' : isSummarySaved ? 'บันทึกแล้ว' : 'บันทึกสรุป'}</span>
              </button>
            </div>
          </div>

          {!isResultSectionCollapsed && (
            <div
              className={`doc-result-panel w-full min-h-[300px] rounded-2xl border transition-all backdrop-blur-sm ${hasResultContent ? 'p-6' : 'border-dashed flex flex-col items-center justify-center'}`}
              style={{
                borderColor: 'var(--border)',
                background: 'var(--surface-2)'
              }}
            >
              {!hasResultContent ? (
                <div className="doc-result-empty text-center opacity-70">
                  <div className="text-4xl mb-3 text-slate-400 dark:text-slate-300">✨</div>
                  <p className="text-slate-500 dark:text-slate-300 text-sm mb-2">อัปโหลดข้อมูลและกด <span className="text-accent font-medium">สร้างสรุปเนื้อหา</span> เพื่อให้ AI ทำงาน</p>
                  {summaryError && <p className="text-sm text-rose-500 dark:text-rose-300">{summaryError}</p>}
                </div>
              ) : (
                <div className="text-slate-700 dark:text-slate-200 text-sm leading-relaxed space-y-4 animate-in fade-in duration-500">
                  <p className="text-xs font-semibold uppercase tracking-widest text-accent mb-2">AI Summary</p>
                  <h3 className="text-lg font-semibold text-slate-900 dark:text-indigo-200">{activeSummaryTitle}</h3>
                  <div className="whitespace-pre-wrap leading-7 text-slate-800 dark:text-slate-200">
                    {activeSummaryText}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        {/* Section 3: History / Archives */}
        <section
          className="doc-summary-card doc-summary-card-history rounded-3xl p-6 shadow-[0_24px_60px_rgba(15,23,42,0.08)] dark:shadow-2xl"
          style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              backdropFilter: 'blur(22px)'
            }}
        >

          <div className="flex flex-col sm:flex-row sm:items-end justify-between border-b border-slate-200 dark:border-white/10 pb-4 gap-4">
            <div
              className="rounded-xl px-4 py-3 backdrop-blur-sm"
              style={{
                border: '1px solid var(--border)',
                background: 'var(--surface-2)'
              }}
            >
              <div className="flex items-center space-x-2 mb-1">
                <span className="text-lg">🕒</span>
                <h2 className="text-lg font-semibold text-[color:var(--text)]">ประวัติและคลังข้อมูล</h2>
              </div>
              <p className="text-xs text-[color:var(--muted)]">แสดงผลแบบการ์ด 10 รายการต่อหน้า</p>
            </div>

            {/* History Tabs */}
            <div
              className="doc-history-tabs flex space-x-1 p-1 rounded-xl overflow-x-auto scrollbar-hide backdrop-blur-md"
              style={{
                background: 'var(--surface-2)',
                border: '1px solid var(--border)'
              }}
            >
               {[
                 { id: 'saved', label: 'สรุปที่บันทึกไว้', icon: '💾', count: undefined },
                 { id: 'original', label: 'ข้อความต้นฉบับ', icon: '📄', count: undefined },
                 { id: 'archived', label: 'สรุปที่เก็บถาวร', icon: '📦', count: filteredArchivedSummaries.length }
               ].map((tab) => (
                 <button
                   key={tab.id}
                   type="button"
                   onClick={() => setActiveHistoryTab(tab.id as any)}
                   className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-md border text-xs font-semibold transition-all whitespace-nowrap ${
                     activeHistoryTab === tab.id 
                     ? 'text-slate-900 shadow' 
                     : 'border-transparent text-slate-600 dark:text-slate-200 hover:text-slate-800 dark:hover:text-white hover:bg-white/30 dark:hover:bg-white/10'
                   }`}
                   style={
                     activeHistoryTab === tab.id
                       ? {
                           background: 'transparent',
                           borderColor: 'rgba(148,163,184,0.28)',
                           color: 'var(--accent)'
                         }
                       : undefined
                   }
                 >
                   <span>{tab.icon}</span>
                   <span>{tab.label}</span>
                   {tab.count !== undefined && <span className="ml-1 bg-slate-100 dark:bg-black/40 text-slate-600 dark:text-slate-300 px-1.5 py-0.5 rounded text-[10px] border border-slate-200 dark:border-white/10">{tab.count}</span>}
                 </button>
               ))}
            </div>
          </div>

          <div className="mt-6">
            
            {/* Filter Pills for Saved Tab */}
            {activeHistoryTab === 'saved' && (
              <div className="flex space-x-2 mb-4 overflow-x-auto pb-2 scrollbar-hide">
                {summaryPeriodOptions.map(option => (
                  <button 
                    key={option.key} 
                    type="button"
                    onClick={() => setSummaryPeriod(option.key)}
                    className={`px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors backdrop-blur-md border ${
                      summaryPeriod === option.key 
                        ? 'shadow-sm' 
                        : 'bg-white/50 dark:bg-white/5 text-slate-600 dark:text-slate-300 hover:bg-white/80 dark:hover:bg-white/10 border-white/60 dark:border-white/10'
                    }`}
                    style={
                      summaryPeriod === option.key
                        ? {
                            background: 'transparent',
                            borderColor: 'rgba(148,163,184,0.28)',
                            color: 'var(--accent)'
                          }
                        : undefined
                    }
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}

            {/* --- SAVED TAB --- */}
            {activeHistoryTab === 'saved' && (
               <>
                 {!selectedSubjectId ? (
                    <div className="doc-empty-state bg-white/40 dark:bg-black/10 border border-white/60 dark:border-white/10 rounded-xl p-8 flex flex-col items-center justify-center text-center backdrop-blur-sm">
                      <span className="text-4xl text-slate-400 mb-3">🕒</span>
                      <p className="text-slate-600 dark:text-slate-300 text-sm">เลือกวิชาเพื่อดูสรุปที่บันทึกไว้</p>
                    </div>
                 ) : filteredSummaries.length === 0 ? (
                    <div className="doc-empty-state bg-white/40 dark:bg-black/10 border border-white/60 dark:border-white/10 rounded-xl p-8 flex flex-col items-center justify-center text-center backdrop-blur-sm">
                      <span className="text-4xl text-slate-400 mb-3">🕒</span>
                      <p className="text-slate-600 dark:text-slate-300 text-sm">ยังไม่มีสรุปเอกสารที่บันทึกไว้</p>
                    </div>
                 ) : (
                   <div className="grid gap-4 md:grid-cols-2">
                      {paginatedSummaries.map(item => (
                         <article
                           key={item.id}
                           role="button"
                           tabIndex={0}
                           onClick={() => viewSavedSummaryItem(item)}
                           onKeyDown={event => {
                             if (event.key === 'Enter' || event.key === ' ') {
                               event.preventDefault();
                               viewSavedSummaryItem(item);
                             }
                           }}
                           className={`rounded-2xl border bg-white/70 dark:bg-black/20 backdrop-blur-md p-5 text-left transition-all ${
                             savedSummary?.id === item.id
                               ? 'shadow-md'
                               : 'border-white/80 dark:border-white/10 hover:bg-white/85 dark:hover:bg-white/5'
                           }`}
                           style={
                             savedSummary?.id === item.id
                               ? {
                                   borderColor: 'rgba(var(--accent-rgb),0.30)',
                                   boxShadow: '0 18px 36px rgba(var(--accent-rgb),0.14)'
                                 }
                               : {
                                   borderColor: 'rgba(148,163,184,0.16)'
                                 }
                           }
                         >
                           <div className="flex flex-col gap-3">
                             <div className="flex justify-between items-start gap-2">
                               <div>
                                 <h4 className="text-sm font-bold text-slate-800 dark:text-white">{item.title ?? 'สรุปเอกสาร'}</h4>
                                 <div className="flex items-center gap-2 mt-1">
                                    {item.created_at && (
                                       <p className="text-[10px] text-slate-500 dark:text-slate-400">{formatSummaryDate(item.created_at)}</p>
                                    )}
                                 </div>
                               </div>
                             </div>

                             <p className="line-clamp-3 text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                               {item.content}
                             </p>

                             <div className="flex flex-wrap items-center gap-2 mt-2 pt-3 border-t border-slate-200 dark:border-white/10">
                               <button
                                 type="button"
                                 onClick={event => {
                                   event.stopPropagation();
                                   viewSavedSummaryItem(item);
                                 }}
                                 className="rounded-lg border border-slate-300 dark:border-white/20 bg-white/80 dark:bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 transition hover:bg-white dark:hover:bg-white/10 backdrop-blur-md shadow-sm dark:shadow-none"
                               >
                                 {savedSummary?.id === item.id ? 'ปิดเนื้อหา' : 'ดูเนื้อหา'}
                               </button>
                               <button
                                 type="button"
                                 onClick={event => {
                                   event.stopPropagation();
                                   printSummaryItem({
                                     title: item.title,
                                     content: item.content,
                                     created_at: item.created_at ?? null,
                                     subject_name: selectedSubjectName,
                                     period: item.period ?? null,
                                   });
                                 }}
                                 className="rounded-lg border border-slate-300 dark:border-white/20 bg-white/80 dark:bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 transition hover:bg-white dark:hover:bg-white/10 backdrop-blur-md shadow-sm dark:shadow-none"
                               >
                                 พิมพ์
                               </button>
                               <button
                                 type="button"
                                 onClick={event => {
                                   event.stopPropagation();
                                   void archiveSummary(item.id, item);
                                 }}
                                 disabled={isAlreadyArchived(item)}
                                 className="rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-40 disabled:cursor-not-allowed backdrop-blur-md shadow-sm dark:shadow-none"
                                 style={{
                                   border: '1px solid var(--accent)',
                                   background: 'var(--accent)',
                                   color: '#ffffff'
                                 }}
                               >
                                 {isAlreadyArchived(item) ? 'บันทึกถาวรแล้ว' : 'บันทึกถาวร'}
                               </button>
                               <button
                                 type="button"
                                 onClick={event => {
                                   event.stopPropagation();
                                   void deleteSavedSummary(item);
                                 }}
                                 disabled={deletingSummaryId === item.id}
                                 className="rounded-lg border border-rose-200 dark:border-rose-400/30 bg-rose-50 dark:bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-600 dark:text-rose-200 transition hover:bg-rose-100 dark:hover:bg-rose-500/20 disabled:opacity-40 backdrop-blur-md shadow-sm dark:shadow-none"
                               >
                                 {deletingSummaryId === item.id ? 'กำลังลบ...' : 'ลบ'}
                               </button>
                             </div>
                           </div>
                         </article>
                      ))}
                   </div>
                 )}

                 {/* Pagination */}
                 {totalSavedSummaryPages > 1 && (
                    <div className="flex flex-wrap items-center justify-between gap-3 mt-6 pt-4 border-t border-slate-200 dark:border-white/10">
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        หน้า {savedSummaryPage} / {totalSavedSummaryPages} · {filteredSummaries.length} รายการ
                      </p>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setSavedSummaryPage(prev => Math.max(prev - 1, 1))}
                          disabled={savedSummaryPage === 1}
                          className="rounded-full border border-slate-300 dark:border-white/20 bg-white/80 dark:bg-black/20 px-4 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 transition hover:bg-white dark:hover:bg-white/10 disabled:opacity-40 backdrop-blur-md shadow-sm dark:shadow-none"
                        >
                          ก่อนหน้า
                        </button>
                        <button
                          type="button"
                          onClick={() => setSavedSummaryPage(prev => Math.min(prev + 1, totalSavedSummaryPages))}
                          disabled={savedSummaryPage === totalSavedSummaryPages}
                          className="rounded-full border border-slate-300 dark:border-white/20 bg-white/80 dark:bg-black/20 px-4 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 transition hover:bg-white dark:hover:bg-white/10 disabled:opacity-40 backdrop-blur-md shadow-sm dark:shadow-none"
                        >
                          ถัดไป
                        </button>
                      </div>
                    </div>
                 )}
               </>
            )}

            {/* --- ORIGINAL TEXT TAB --- */}
            {activeHistoryTab === 'original' && (
               <div className="doc-empty-state bg-white/40 dark:bg-black/10 border border-white/60 dark:border-white/10 rounded-xl p-6 text-left backdrop-blur-sm">
                  {originalText ? (
                    <p className="whitespace-pre-wrap text-sm leading-7 text-slate-800 dark:text-slate-300">{originalText}</p>
                  ) : originalError ? (
                    <p className="text-sm text-rose-600 dark:text-rose-300">{originalError}</p>
                  ) : (
                    <div className="flex flex-col items-center justify-center text-center p-4">
                      <span className="text-4xl text-slate-400 mb-3">📄</span>
                      <p className="text-sm text-slate-500 dark:text-slate-400">ยังไม่มีต้นฉบับจากไฟล์ที่อัปโหลด</p>
                    </div>
                  )}
               </div>
            )}

            {/* --- ARCHIVED TAB --- */}
            {activeHistoryTab === 'archived' && (
               <>
                 {filteredArchivedSummaries.length === 0 ? (
                    <div className="doc-empty-state bg-white/40 dark:bg-black/10 border border-white/60 dark:border-white/10 rounded-xl p-8 flex flex-col items-center justify-center text-center backdrop-blur-sm">
                      <span className="text-4xl text-slate-400 mb-3">📦</span>
                      <p className="text-slate-600 dark:text-slate-300 text-sm">ยังไม่มีสรุปที่เก็บถาวร</p>
                    </div>
                 ) : (
                    <div className="grid gap-4 md:grid-cols-2">
                       {filteredArchivedSummaries.map(item => (
                          <article
                            key={`archive-${item.id}`}
                            role="button"
                            tabIndex={0}
                            onClick={() => viewSavedSummaryItem(item)}
                            onKeyDown={event => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                viewSavedSummaryItem(item);
                              }
                            }}
                            className="doc-archive-card rounded-2xl border border-amber-300 dark:border-amber-400/30 bg-amber-50/80 dark:bg-amber-500/5 p-5 text-left transition hover:border-amber-400 dark:hover:border-amber-400/50 hover:bg-amber-100/80 dark:hover:bg-amber-500/10 backdrop-blur-md shadow-sm dark:shadow-none"
                          >
                            <div className="flex flex-col gap-3">
                               <div className="flex justify-between items-start gap-2">
                                 <div>
                                   <div className="flex items-center gap-2">
                                     <h4 className="text-sm font-bold text-amber-800 dark:text-amber-200">{item.title ?? 'สรุปเอกสาร'}</h4>
                                   </div>
                                   <div className="flex items-center gap-2 mt-1">
                                      {item.period && (
                                         <span className="text-[10px] text-slate-600 dark:text-slate-300 border border-slate-300 dark:border-white/20 px-1.5 py-0.5 rounded-md bg-white/50 dark:bg-white/5">
                                           {summaryCategoryLabels[item.period]}
                                         </span>
                                      )}
                                      {item.created_at && (
                                         <p className="text-[10px] text-slate-500 dark:text-slate-400">{formatSummaryDate(item.created_at)}</p>
                                      )}
                                   </div>
                                 </div>
                               </div>

                               <p className="line-clamp-3 text-sm text-slate-700 dark:text-slate-300 leading-relaxed">
                                 {item.content}
                               </p>

                               <div className="flex flex-wrap items-center gap-2 mt-2 pt-3 border-t border-amber-200 dark:border-amber-400/20">
                                  <button
                                    type="button"
                                    onClick={event => {
                                      event.stopPropagation();
                                      viewSavedSummaryItem(item);
                                    }}
                                    className="rounded-lg border border-slate-300 dark:border-white/20 bg-white/80 dark:bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 transition hover:bg-white dark:hover:bg-white/10 backdrop-blur-md shadow-sm dark:shadow-none"
                                  >
                                    {savedSummary?.id === item.id ? 'ปิดเนื้อหา' : 'ดูเนื้อหา'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={event => {
                                      event.stopPropagation();
                                      printSummaryItem({
                                        title: item.title,
                                        content: item.content,
                                        created_at: item.created_at ?? null,
                                        subject_name: item.subject_name ?? selectedSubjectName,
                                        period: item.period ?? null,
                                      });
                                    }}
                                    className="rounded-lg border border-slate-300 dark:border-white/20 bg-white/80 dark:bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 transition hover:bg-white dark:hover:bg-white/10 backdrop-blur-md shadow-sm dark:shadow-none"
                                  >
                                    พิมพ์
                                  </button>
                                  <button
                                    type="button"
                                    onClick={event => {
                                      event.stopPropagation();
                                      void restoreSummary(item);
                                    }}
                                    className="rounded-lg border border-sky-300 dark:border-sky-400/30 bg-sky-50 dark:bg-sky-500/10 px-3 py-1.5 text-xs font-medium text-sky-700 dark:text-sky-200 transition hover:bg-sky-100 dark:hover:bg-sky-500/20 backdrop-blur-md shadow-sm dark:shadow-none"
                                  >
                                    เอาออกจากเก็บถาวร
                                  </button>
                               </div>
                            </div>
                          </article>
                       ))}
                    </div>
                 )}
               </>
            )}

          </div>
        </section>

      </div>
    </div>
  );
};
