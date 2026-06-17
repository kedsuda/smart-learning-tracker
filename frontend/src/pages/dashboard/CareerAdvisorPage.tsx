import axios from 'axios';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { useSemesterOptions } from '../../hooks/useSemesterOptions';
import { filterBySemester, toNumberOrNull } from '../../utils/semester';
import { subscribeSubjectsUpdated } from '../../utils/subjectSync';
import robotImage from '../../img/robot.png';
import saveIcon from '../../img/savel.png';

type ApiRecommendation = {
  id?: number;
  career: string;
  skills: string;
  subjects: string;
  score: number;
  reason?: string | null;
  created_at?: string | null;
};

type RecommendationCard = {
  title: string;
  skills: string;
  subjects: string;
  score: number;
  source: 'history' | 'generated';
  reason?: string | null;
};

type TopSubject = {
  id: number;
  subject_name: string;
  summary_count: number;
  study_log_count?: number;
  study_hours: number;
  avg_mood_score?: number;
  quiz_attempt_count?: number;
  avg_quiz_score?: number | null;
  latest_quiz_score?: number | null;
  max_quiz_score?: number;
  is_latest_top_score?: boolean;
  passed_count?: number;
};

type WeakSubject = {
  id: number;
  subject_name: string;
  hint: string;
  next_steps: string[];
};

type LatestQuizInsight = {
  quiz_title: string;
  subject_name: string;
  score: number;
  total: number;
  percentage: number;
  passed: boolean;
  created_at?: string | null;
};

type SubjectOption = {
  id: number;
  name: string;
  semester_id?: number | null;
  semester?: number | null;
  academic_year?: number | null;
};

type ChatMessage = {
  id: number;
  user_id: string;
  room_id: string;
  sender_type: 'user' | 'assistant' | string;
  message: string;
  attachment_url?: string | null;
  is_deleted?: boolean;
  created_at?: string | null;
};

type ChatRoomMeta = {
  id: string;
  title: string;
  updated_at: string;
  last_message?: string;
};

const normalizeAssistantFallback = (message: string) => {
  const text = (message || '').trim();
  if (!text) return text;

  const legacyPatterns = [
    'Gemini API ของระบบยังไม่ได้เปิดใช้งานในโปรเจกต์นี้',
    'ระบบ AI ตอบกลับไม่ได้ชั่วคราว',
    'Gemini ของระบบใช้โควต้าครบแล้ว',
    'Gemini ของระบบถูกบล็อกการเรียกใช้งานอยู่',
    'Gemini ของระบบตั้งค่า model ไม่ตรงกับ endpoint',
  ];

  if (legacyPatterns.some(pattern => text.includes(pattern))) {
    return 'ตอนนี้ระบบ AI ภายนอกมีปัญหาชั่วคราว แต่ยังใช้งานผู้ช่วยได้ตามปกติค่ะ บอกหัวข้อที่อยากสรุป/วางแผนอ่าน/ทำแบบฝึกหัดได้เลยค่ะ';
  }

  return text;
};

const isSubjectCreatedReply = (message: string) => {
  const text = (message || '').trim().toLowerCase();
  if (!text) return false;
  return text.includes('เพิ่มวิชา') && text.includes('เรียบร้อย') && text.includes('ตารางเรียน');
};

type CareerAdvisorPageProps = {
  mode?: 'career' | 'home';
};

type BrowserSpeechRecognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
};

export const CareerAdvisorPage = ({ mode = 'career' }: CareerAdvisorPageProps) => {
  const navigate = useNavigate();
  const { user, token, loading: authLoading } = useAuth();
  const [recommendations, setRecommendations] = useState<RecommendationCard[]>([]);
  const [subjects, setSubjects] = useState<SubjectOption[]>([]);
  const [selectedSemesterKey, setSelectedSemesterKey] = useState('all');
  const [topSubjects, setTopSubjects] = useState<TopSubject[]>([]);
  const [weakSubjects, setWeakSubjects] = useState<WeakSubject[]>([]);
  const [latestQuiz, setLatestQuiz] = useState<LatestQuizInsight | null>(null);
  const [, setInsightsStatus] = useState<'idle' | 'loaded' | 'failed'>('idle');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [, setLastUpdated] = useState<string | null>(null);
  const [inputText, setInputText] = useState('');
  const [assistantMessage, setAssistantMessage] = useState(
    'สวัสดีครับน้อง CS 👋 วันนี้มีอะไรให้ผมช่วยบันทึก หรืออยากทบทวนบทเรียนไหนเป็นพิเศษไหมครับ?'
  );
  const [isThinking, setIsThinking] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [chatRooms, setChatRooms] = useState<ChatRoomMeta[]>([]);
  const [activeChatRoomId, setActiveChatRoomId] = useState('default');
  const [chatRoomSearch, setChatRoomSearch] = useState('');
  const [selectedTool, setSelectedTool] = useState<'บันทึกเรียน' | 'สรุปบทเรียน' | 'ถามการบ้าน'>('บันทึกเรียน');
  const [attachedFileName, setAttachedFileName] = useState('');
  const [attachmentTrayOpen, setAttachmentTrayOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [clearingHistory, setClearingHistory] = useState(false);
  const [deletingMessageId, setDeletingMessageId] = useState<number | null>(null);
  const [voiceInputSupported, setVoiceInputSupported] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const attachmentTrayRef = useRef<HTMLDivElement | null>(null);
  const speechRecognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const speechRecognitionCtorRef = useRef<any>(null);
  const speechTranscriptBaseRef = useRef('');
  const voiceInputSilenceTimerRef = useRef<number | null>(null);
  const voiceInputAcceptResultsRef = useRef(false);
  const semesterOptions = useSemesterOptions();

  const userId = user?.id ?? 0;
  const isAuthenticated = userId > 0;
  const hasAuthToken = Boolean(token);
  const hasAnySubjects = subjects.length > 0;

  const mapApiRecommendations = (items: ApiRecommendation[], source: RecommendationCard['source']): RecommendationCard[] =>
    items.map(item => ({
      title: item.career,
      skills: item.skills,
      subjects: item.subjects,
      score: Math.round(item.score ?? 0),
      source,
      reason: item.reason ?? null
    }));

  const fetchRecommendations = async () => {
    setLoading(true);
    setError(null);
    setInfo(null);
    try {
      // Uses authenticated user from Sanctum token (no user_id param).
      const response = await api.post<ApiRecommendation[]>('/career/recommendations');
      const items = response.data ?? [];
      setRecommendations(items.length ? mapApiRecommendations(items, 'history') : []);
      setLastUpdated(new Date().toLocaleString('th-TH'));
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'เกิดข้อผิดพลาดในการดึงข้อมูล');
    } finally {
      setLoading(false);
    }
  };

  const fetchInsights = async () => {
    try {
      const response = await api.get<{ top_subjects?: TopSubject[]; weak_subjects?: WeakSubject[]; latest_quiz?: LatestQuizInsight | null }>('/career/insights');
      setTopSubjects(response.data?.top_subjects ?? []);
      setWeakSubjects(response.data?.weak_subjects ?? []);
      setLatestQuiz(response.data?.latest_quiz ?? null);
      setInsightsStatus('loaded');
    } catch {
      setInsightsStatus('failed');
    }
  };

  const analyzeNow = async () => {
    setLoading(true);
    setError(null);
    setInfo(null);
    try {
      // Uses authenticated user from Sanctum token (no user_id param).
      const response = await api.post<{ recommendations?: ApiRecommendation[]; top_subjects?: TopSubject[]; weak_subjects?: WeakSubject[]; latest_quiz?: LatestQuizInsight | null; message?: string }>(
        '/career/analyze'
      );
      const recs = response.data?.recommendations ?? [];
      setRecommendations(recs.length ? mapApiRecommendations(recs, 'generated') : []);
      setTopSubjects(response.data?.top_subjects ?? []);
      setWeakSubjects(response.data?.weak_subjects ?? []);
      setLatestQuiz(response.data?.latest_quiz ?? null);
      if (response.data?.message) setInfo(response.data.message);
      setLastUpdated(new Date().toLocaleString('th-TH'));
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'เกิดข้อผิดพลาดในการวิเคราะห์');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (userId) {
      analyzeNow();
      fetchInsights();
    }
  }, [userId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(chatRoomStorageKey);
      const parsed = raw ? (JSON.parse(raw) as ChatRoomMeta[]) : [];
      const valid = Array.isArray(parsed)
        ? parsed.filter(room => room && typeof room.id === 'string' && room.id.trim() !== '')
        : [];
      if (valid.length > 0) {
        setChatRooms(valid);
        setActiveChatRoomId(valid[0].id);
      } else {
        setChatRooms([
          {
            id: 'default',
            title: 'แชทหลัก',
            updated_at: new Date().toISOString(),
          },
        ]);
        setActiveChatRoomId('default');
      }
    } catch {
      setChatRooms([
        {
          id: 'default',
          title: 'แชทหลัก',
          updated_at: new Date().toISOString(),
        },
      ]);
      setActiveChatRoomId('default');
    }
  }, []); 

  const loadSubjects = async () => {
    try {
      const res = await api.get('/subjects');
      const payload = Array.isArray(res.data) ? res.data : res.data?.data;
      const list: SubjectOption[] = Array.isArray(payload)
        ? payload.map((item: any) => ({
            id: Number(item.id),
            name: String(item.name ?? item.subject_name ?? ''),
            semester_id: toNumberOrNull(item.semester_id),
            semester: toNumberOrNull(item.semester),
            academic_year: toNumberOrNull(item.academic_year),
          }))
        : [];
      setSubjects(list.filter(item => Number.isFinite(item.id) && item.name.trim() !== ''));
    } catch {
      setSubjects([]);
    }
  };

  useEffect(() => {
    void loadSubjects();
    return subscribeSubjectsUpdated(() => {
      void loadSubjects();
    });
  }, []);

  const filteredSubjects = useMemo(() => filterBySemester(subjects, selectedSemesterKey), [subjects, selectedSemesterKey]);
  const hasSubjectsInFilter = filteredSubjects.length > 0;
  const filteredSubjectIdSet = useMemo(() => new Set(filteredSubjects.map(subject => subject.id)), [filteredSubjects]);
  const filteredSubjectNameSet = useMemo(
    () => new Set(filteredSubjects.map(subject => subject.name.trim().toLowerCase()).filter(Boolean)),
    [filteredSubjects]
  );

  const displayedTopSubjects = topSubjects
    .slice()
    .filter(subject => selectedSemesterKey === 'all' || filteredSubjectIdSet.has(subject.id))
    .sort((a, b) => {
      const aQuizSignal =
        (a.quiz_attempt_count ?? 0) * 1000 +
        (a.avg_quiz_score ?? 0) * 20 +
        (a.latest_quiz_score ?? 0) * 10 +
        (a.passed_count ?? 0) * 5;
      const bQuizSignal =
        (b.quiz_attempt_count ?? 0) * 1000 +
        (b.avg_quiz_score ?? 0) * 20 +
        (b.latest_quiz_score ?? 0) * 10 +
        (b.passed_count ?? 0) * 5;
      if (bQuizSignal !== aQuizSignal) return bQuizSignal - aQuizSignal;
      return (b.summary_count ?? 0) - (a.summary_count ?? 0);
    });
  const displayedWeakSubjects = weakSubjects
    .filter(subject => selectedSemesterKey === 'all' || filteredSubjectIdSet.has(subject.id));
  const displayedRecommendations = recommendations
    .filter(rec => {
      if (selectedSemesterKey === 'all') return true;
      const recSubjects = rec.subjects
        .split(',')
        .map(subject => subject.trim().toLowerCase())
        .filter(Boolean);
      return recSubjects.some(subject => filteredSubjectNameSet.has(subject));
    });

  const studyStats = useMemo(() => {
    const totalStudyHours = displayedTopSubjects.reduce((sum, subject) => sum + (subject.study_hours ?? 0), 0);
    const totalReviewCount = displayedTopSubjects.reduce((sum, subject) => sum + (subject.summary_count ?? 0), 0);
    const totalStudyLogs = displayedTopSubjects.reduce((sum, subject) => sum + (subject.study_log_count ?? 0), 0);
    const maxReviewCount = displayedTopSubjects.reduce((max, subject) => Math.max(max, subject.summary_count ?? 0), 0);
    const mostReviewedSubject =
      displayedTopSubjects
        .slice()
        .sort((a, b) => (b.summary_count ?? 0) - (a.summary_count ?? 0))
        .find(subject => (subject.summary_count ?? 0) > 0) ?? null;

    const reviewRate = totalStudyLogs > 0 ? totalReviewCount / totalStudyLogs : 0;
    const reviewRateLabel =
      reviewRate >= 1
        ? 'สูง'
        : reviewRate >= 0.6
          ? 'ปานกลาง'
          : reviewRate > 0
            ? 'ยังต่ำ'
            : 'ยังไม่มีข้อมูล';

    return {
      totalStudyHours,
      totalReviewCount,
      totalStudyLogs,
      maxReviewCount,
      mostReviewedSubject,
      reviewRate,
      reviewRateLabel,
    };
  }, [displayedTopSubjects]);

  const formatQuizScore = (value?: number | null) => {
    if (value === null || value === undefined) return '—';
    if (!Number.isFinite(value)) return '—';
    return Math.round(value).toString();
  };

  const primaryRecommendation =
    displayedRecommendations
      .slice()
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0] ??
    null;
  const weeklyChart = useMemo(() => {
    const total = Math.max(0, studyStats.totalStudyHours);
    const base = total > 0 ? total / 7 : 0;
    const data = [
      Math.max(0, base * 0.45),
      Math.max(0, base * 0.65),
      Math.max(0, base * 0.9),
      Math.max(0, base * 1.25),
      Math.max(0, base * 0.85),
      Math.max(0, base * 0.5),
      Math.max(0, base * 0.35),
    ];
    const max = Math.max(1, ...data);
    return { data, max };
  }, [studyStats.totalStudyHours]);

  const topSubjectNames = displayedTopSubjects
    .map(s => s.subject_name)
    .filter(Boolean)
    .slice(0, 2);
  const prioritizedSkills = Array.from(
    new Set(
      (primaryRecommendation ? [primaryRecommendation, ...displayedRecommendations] : displayedRecommendations)
        .flatMap(rec =>
          (rec.skills ?? '')
            .split(',')
            .map(skill => skill.trim())
            .filter(Boolean)
        )
    )
  ).slice(0, 10);

  const filteredChatRooms = chatRooms.filter(room => {
    const q = chatRoomSearch.trim().toLowerCase();
    if (!q) return true;
    return (
      room.title.toLowerCase().includes(q) ||
      (room.last_message ?? '').toLowerCase().includes(q)
    );
  });

  const chatRoomStorageKey = `smartroom-chat-rooms-${userId || 'guest'}`;

  const upsertChatRoomMeta = (
    roomId: string,
    patch: Partial<Pick<ChatRoomMeta, 'title' | 'last_message' | 'updated_at'>>
  ) => {
    setChatRooms(prev => {
      const nowIso = patch.updated_at ?? new Date().toISOString();
      const next = [...prev];
      const index = next.findIndex(room => room.id === roomId);

      if (index >= 0) {
        next[index] = {
          ...next[index],
          ...patch,
          updated_at: nowIso,
        };
      } else {
        next.push({
          id: roomId,
          title: patch.title?.trim() || `แชท ${prev.length + 1}`,
          updated_at: nowIso,
          last_message: patch.last_message,
        });
      }

      return next
        .slice()
        .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
    });
  };
  const canSendChat = inputText.trim().length > 0 && !isThinking && hasAuthToken;
  const quickActions = [
    {
      id: 'study-capture',
      label: 'บันทึกการเรียน',
      to: '/study-capture',
      iconClassName: 'text-white',
      tileStyle: { backgroundColor: '#2563eb' },
      icon: (
        <img
          src={saveIcon}
          alt=""
          className="pointer-events-none relative z-10 h-full w-full scale-[1.35] object-contain drop-shadow-[0_12px_20px_rgba(37,99,235,0.22)] motion-safe:animate-[save-wiggle_5s_ease-in-out_infinite] md:scale-[1.45]"
          aria-hidden="true"
        />
      )
    },
    {
      id: 'study-digest',
      label: 'สรุปการเรียน',
      to: '/study-digest',
      iconClassName: 'text-white',
      tileStyle: { backgroundColor: '#059669' },
      icon: (
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 5h14" />
          <path d="M5 12h14" />
          <path d="M5 19h9" />
          <path d="M18 17v4" />
          <path d="M16 19h4" />
        </svg>
      )
    }
  ];
  const storageAction = {
    id: 'study-storage',
    label: 'กระเป๋าเก็บไฟล์',
    to: '/study-storage',
    iconClassName: 'text-white',
    tileStyle: {
      background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
      boxShadow: '0 10px 22px rgba(99,102,241,0.24)',
    },
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" />
        <path d="M10 12h4" />
      </svg>
    ),
  };
  const quickActionItems = [...quickActions, storageAction];
  const [smartMenuOffset, setSmartMenuOffset] = useState({ x: 0, y: 0 });
  const [isDraggingSmartMenu, setIsDraggingSmartMenu] = useState(false);
  const smartMenuDragStartRef = useRef<{ x: number; y: number; pointerX: number; pointerY: number } | null>(null);
  const [isDesktopLike, setIsDesktopLike] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(min-width: 1024px)').matches : true
  );
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false
  );
  const lowFxMode = !isDesktopLike || prefersReducedMotion;

  const clearVoiceInputSilenceTimer = () => {
    if (typeof window === 'undefined' || voiceInputSilenceTimerRef.current === null) return;

    window.clearTimeout(voiceInputSilenceTimerRef.current);
    voiceInputSilenceTimerRef.current = null;
  };

  useEffect(() => {
    if (!isDraggingSmartMenu) return;

    const handlePointerMove = (event: PointerEvent) => {
      const dragStart = smartMenuDragStartRef.current;
      if (!dragStart) return;
      const nextX = dragStart.x + (event.clientX - dragStart.pointerX);
      const nextY = dragStart.y + (event.clientY - dragStart.pointerY);
      setSmartMenuOffset({ x: nextX, y: nextY });
    };

    const handlePointerUp = () => {
      setIsDraggingSmartMenu(false);
      smartMenuDragStartRef.current = null;
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [isDraggingSmartMenu]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const media = window.matchMedia('(min-width: 1024px)');
    const apply = () => setIsDesktopLike(media.matches);
    apply();
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', apply);
      return () => media.removeEventListener('change', apply);
    }
    media.addListener(apply);
    return () => media.removeListener(apply);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setPrefersReducedMotion(media.matches);
    apply();
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', apply);
      return () => media.removeEventListener('change', apply);
    }
    media.addListener(apply);
    return () => media.removeListener(apply);
  }, []);


  const stopVoiceInput = () => {
    clearVoiceInputSilenceTimer();
    voiceInputAcceptResultsRef.current = false;
    speechTranscriptBaseRef.current = '';

    if (!speechRecognitionRef.current) {
      setIsListening(false);
      return;
    }

    try {
      speechRecognitionRef.current.stop();
    } catch {
      // ignore stop errors from browser api
    }
  };

  const scheduleVoiceInputSilenceTimer = () => {
    if (typeof window === 'undefined') return;

    clearVoiceInputSilenceTimer();
    voiceInputSilenceTimerRef.current = window.setTimeout(() => {
      stopVoiceInput();
    }, 3000);
  };

  const submitAssistantPrompt = async (prompt: string) => {
    const trimmed = prompt.trim();
    if (!trimmed || isThinking || !hasAuthToken) return;

    stopVoiceInput();

    const attachmentUrl = attachedFileName.trim() !== '' ? attachedFileName.trim() : null;

    setInputText('');
    setIsThinking(true);
    setChatError(null);

    try {
      const response = await api.post<{
        room_id: string;
        messages?: ChatMessage[];
        assistant_message?: ChatMessage;
      }>('/assistant/chat/message', {
        room_id: activeChatRoomId,
        message: trimmed,
        tool: selectedTool,
        attachment_url: attachmentUrl,
      });

      const nextMessages = response.data?.messages ?? [];
      setChatMessages(nextMessages);
      upsertChatRoomMeta(activeChatRoomId, {
        title: trimmed.slice(0, 28) || undefined,
        last_message: trimmed,
      });

      const latestAssistant =
        response.data?.assistant_message ??
        [...nextMessages].reverse().find(message => message.sender_type === 'assistant');

      const nextAssistantMessage =
        normalizeAssistantFallback(latestAssistant?.message ?? '') ||
        'ตอบกลับเรียบร้อยแล้วครับ มีอะไรให้ช่วยต่อได้อีกไหม?';

      setAssistantMessage(nextAssistantMessage);
      if (isSubjectCreatedReply(nextAssistantMessage)) {
        navigate('/calendar');
      }

      setAttachedFileName('');
      setAttachmentTrayOpen(false);
    } catch (err) {
      console.error(err);
      const message = axios.isAxiosError(err)
        ? ((err.response?.data as { message?: string } | undefined)?.message ?? err.message)
        : err instanceof Error
          ? err.message
          : 'ไม่สามารถส่งข้อความได้ในขณะนี้';
      setChatError(message);
      setAssistantMessage('ส่งข้อความไม่สำเร็จ ลองอีกครั้งได้เลยครับ');
    } finally {
      setIsThinking(false);
    }
  };

  const clearChatHistory = async () => {
    if (clearingHistory) return;

    const confirmed = window.confirm('ต้องการลบประวัติการสนทนาทั้งหมดในห้องนี้ใช่หรือไม่?');
    if (!confirmed) return;

    setClearingHistory(true);
    setChatError(null);

    try {
      await api.delete('/assistant/chat/history', {
        data: {
          room_id: activeChatRoomId,
        },
      });

      setChatMessages([]);
      setAssistantMessage('สวัสดีครับน้อง CS 👋 วันนี้มีอะไรให้ผมช่วยบันทึก หรืออยากทบทวนบทเรียนไหนเป็นพิเศษไหมครับ?');
      upsertChatRoomMeta(activeChatRoomId, {
        last_message: 'เริ่มแชทใหม่',
      });
    } catch (err) {
      console.error(err);
      const message = axios.isAxiosError(err)
        ? ((err.response?.data as { message?: string } | undefined)?.message ?? err.message)
        : err instanceof Error
          ? err.message
          : 'ลบประวัติการสนทนาไม่สำเร็จ';
      setChatError(message);
    } finally {
      setClearingHistory(false);
    }
  };

  const deleteChatMessage = async (messageId: number) => {
    if (deletingMessageId !== null) return;

    const confirmed = window.confirm('ต้องการลบข้อความนี้ใช่หรือไม่?');
    if (!confirmed) return;

    setDeletingMessageId(messageId);
    setChatError(null);

    try {
      await api.delete(`/assistant/chat/history/${messageId}`);
      setChatMessages(prev => prev.filter(message => message.id !== messageId));
    } catch (err) {
      console.error(err);
      const message = axios.isAxiosError(err)
        ? ((err.response?.data as { message?: string } | undefined)?.message ?? err.message)
        : err instanceof Error
          ? err.message
          : 'ลบข้อความไม่สำเร็จ';
      setChatError(message);
    } finally {
      setDeletingMessageId(null);
    }
  };

  const handleAssistantSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submitAssistantPrompt(inputText);
  };

  const createNewChatRoom = () => {
    const roomId = `room-${Date.now()}`;
    const room: ChatRoomMeta = {
      id: roomId,
      title: `แชทใหม่ ${chatRooms.length + 1}`,
      updated_at: new Date().toISOString(),
      last_message: '',
    };
    setChatRooms(prev => [room, ...prev]);
    setActiveChatRoomId(roomId);
    setChatMessages([]);
    setInputText('');
    setAttachedFileName('');
    setAssistantMessage('เริ่มแชทใหม่แล้วครับ พิมพ์สิ่งที่อยากให้ช่วยได้เลย');
    setChatError(null);
  };

  const startVoiceInput = () => {
    if (typeof window === 'undefined' || !speechRecognitionCtorRef.current || isThinking) return;

    setChatError(null);
    speechTranscriptBaseRef.current = inputText.trim();
    voiceInputAcceptResultsRef.current = true;

    try {
      const recognition: BrowserSpeechRecognition = new speechRecognitionCtorRef.current();
      recognition.lang = 'th-TH';
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onresult = (event: any) => {
        if (!voiceInputAcceptResultsRef.current || speechRecognitionRef.current !== recognition) {
          return;
        }

        const transcript = Array.from(event.results ?? [])
          .map((item: any) => item?.[0]?.transcript ?? '')
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();

        const base = speechTranscriptBaseRef.current;
        const nextText = transcript ? [base, transcript].filter(Boolean).join(base ? ' ' : '') : base;
        setInputText(nextText);
        scheduleVoiceInputSilenceTimer();
      };
      recognition.onerror = () => {
        clearVoiceInputSilenceTimer();
        voiceInputAcceptResultsRef.current = false;
        setChatError('ไม่สามารถใช้งานไมค์เพื่อแปลงเสียงเป็นข้อความได้ในขณะนี้');
        setIsListening(false);
        speechRecognitionRef.current = null;
      };
      recognition.onend = () => {
        clearVoiceInputSilenceTimer();
        voiceInputAcceptResultsRef.current = false;
        setIsListening(false);
        speechRecognitionRef.current = null;
      };

      recognition.start();
      speechRecognitionRef.current = recognition;
      setIsListening(true);
      scheduleVoiceInputSilenceTimer();
    } catch {
      clearVoiceInputSilenceTimer();
      voiceInputAcceptResultsRef.current = false;
      setChatError('อุปกรณ์หรือเบราว์เซอร์นี้ไม่รองรับการพูดเป็นข้อความ');
      setIsListening(false);
      speechRecognitionRef.current = null;
    }
  };

  useEffect(() => {
    if (mode !== 'home' || typeof document === 'undefined') return;

    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
    };
  }, [mode]);

  useEffect(() => {
    if (!attachmentTrayOpen || typeof document === 'undefined') return;
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (attachmentTrayRef.current?.contains(target)) return;
      setAttachmentTrayOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
    };
  }, [attachmentTrayOpen]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const SpeechRecognitionCtor =
      (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition ?? null;
    speechRecognitionCtorRef.current = SpeechRecognitionCtor;
    setVoiceInputSupported(Boolean(SpeechRecognitionCtor));

    return () => {
      stopVoiceInput();
    };
  }, []);

  useEffect(() => {
    if (mode !== 'home' || !hasAuthToken) return;

    let cancelled = false;

    const loadChatHistory = async () => {
      setChatLoading(true);
      setChatError(null);

      try {
        const response = await api.get<{ messages?: ChatMessage[] }>('/assistant/chat/history', {
          params: {
            room_id: activeChatRoomId,
            limit: 50,
          },
        });

        if (cancelled) return;

        const messages = response.data?.messages ?? [];
        setChatMessages(messages);
        const latestMessage = [...messages].reverse().find(message => (message.message ?? '').trim() !== '');
        const firstUserMessage = messages.find(message => message.sender_type === 'user' && message.message?.trim());
        upsertChatRoomMeta(activeChatRoomId, {
          title: firstUserMessage?.message?.trim()?.slice(0, 28),
          last_message: latestMessage?.message?.trim() || '',
        });

        const latestAssistant = [...messages].reverse().find(message => message.sender_type === 'assistant');
        if (latestAssistant?.message?.trim()) {
          setAssistantMessage(normalizeAssistantFallback(latestAssistant.message));
        } else {
          setAssistantMessage('พร้อมช่วยเสมอครับ พิมพ์โจทย์หรือคำสั่งที่อยากให้ช่วยได้เลย');
        }
      } catch (err) {
        if (cancelled) return;
        console.error(err);
        setChatError(
          axios.isAxiosError(err)
            ? ((err.response?.data as { message?: string } | undefined)?.message ?? err.message)
            : err instanceof Error
              ? err.message
              : 'โหลดประวัติการคุยไม่สำเร็จ'
        );
      } finally {
        if (!cancelled) {
          setChatLoading(false);
        }
      }
    };

    void loadChatHistory();

    return () => {
      cancelled = true;
    };
  }, [activeChatRoomId, hasAuthToken, mode]);

  useEffect(() => {
    if (mode !== 'home' || typeof window === 'undefined') return;

    const handleHomeMenuClose = () => {
      setAttachmentTrayOpen(false);
      setHistoryOpen(false);
    };

    window.addEventListener('smartroom:home-menu-pressed', handleHomeMenuClose);
    return () => {
      window.removeEventListener('smartroom:home-menu-pressed', handleHomeMenuClose);
    };
  }, [mode]);

  if (mode === 'home') {
    return (
      <div className="smart-home-root relative h-[calc(100dvh-14.25rem)] overflow-hidden lg:h-[calc(100vh-8.5rem)]">
        <style>{`
          @keyframes float {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-10px); }
          }
          @keyframes save-wiggle {
            0%, 100% { transform: translateY(0) rotate(0deg) scale(1); }
            10% { transform: translateY(-3px) rotate(-2.4deg) scale(1.02); }
            20% { transform: translateY(2px) rotate(2.4deg) scale(1.04); }
            30% { transform: translateY(-2px) rotate(-1.8deg) scale(1.02); }
            40% { transform: translateY(1px) rotate(1.2deg) scale(1.01); }
            50%, 90% { transform: translateY(0) rotate(0deg) scale(1); }
          }
          @keyframes bubblePulse {
            0%, 100% { box-shadow: 0 18px 48px rgba(15, 23, 42, 0.06); }
            50% { box-shadow: 0 22px 52px rgba(15, 23, 42, 0.1); }
          }
          @keyframes orbitSpin {
            from { transform: translate(-50%, -50%) rotate(0deg); }
            to { transform: translate(-50%, -50%) rotate(360deg); }
          }
          @keyframes softGlow {
            0%, 100% { opacity: .72; transform: scale(1); }
            50% { opacity: 1; transform: scale(1.06); }
          }
          @media (max-width: 480px) and (max-height: 820px) {
            .smart-home-root {
              height: calc(100dvh - 14.75rem);
            }
            .smart-home-stack {
              gap: 0.55rem;
              padding-top: 0.5rem;
            }
            .smart-home-bubble {
              border-radius: 1.35rem;
              padding: 1rem 1.1rem;
            }
            .smart-home-actions {
              gap: 0.45rem;
            }
            .smart-home-actions button {
              padding: 0.55rem 0.72rem;
              font-size: 10px;
            }
            .smart-home-label {
              font-size: 9px;
              letter-spacing: 0.18em;
            }
            .smart-home-message {
              max-height: 5.1rem;
            }
            .smart-home-message p {
              font-size: 13px;
              line-height: 1.55;
            }
            .smart-home-robot-section {
              padding-top: 0;
            }
            .smart-home-robot {
              height: clamp(136px, 28vh, 210px);
              width: clamp(136px, 28vh, 210px);
            }
            .smart-home-composer {
              padding-bottom: 0;
            }
            .smart-home-input-shell {
              border-radius: 1.65rem;
              padding: 0.45rem 0.8rem;
            }
            .smart-home-input-shell textarea {
              font-size: 14px;
            }
            .smart-home-input-shell .smart-home-tool-button {
              height: 2.1rem;
              width: 2.1rem;
              margin-right: 0.45rem;
            }
            .smart-home-input-shell .smart-home-mic-button {
              height: 2.1rem;
              width: 2.1rem;
              margin-left: 0.45rem;
            }
            .smart-home-send {
              height: 52px;
              width: 52px;
            }
          }
          @media (max-width: 380px) and (max-height: 760px) {
            .smart-home-root {
              height: calc(100dvh - 15rem);
            }
            .smart-home-message {
              max-height: 4.25rem;
            }
            .smart-home-robot {
              height: clamp(118px, 24vh, 170px);
              width: clamp(118px, 24vh, 170px);
            }
          }
        `}</style>
        <div
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(180deg, color-mix(in srgb, var(--surface-2) 86%, var(--bg)) 0%, color-mix(in srgb, var(--surface) 82%, var(--bg)) 42%, color-mix(in srgb, var(--surface-2) 84%, var(--bg)) 100%)'
          }}
        />
        <div className="absolute inset-x-0 bottom-0 h-[52%] opacity-60" style={{ backgroundImage: 'linear-gradient(to right, rgba(var(--accent-rgb),0.10) 1px, transparent 1px), linear-gradient(to bottom, rgba(var(--accent-rgb),0.10) 1px, transparent 1px)', backgroundSize: '2rem 2rem', transform: lowFxMode ? 'none' : 'perspective(540px) rotateX(64deg)', transformOrigin: 'bottom', opacity: lowFxMode ? 0.3 : 0.6 }} />
        {!lowFxMode ? <div className="absolute left-6 top-16 h-44 w-44 rounded-full blur-3xl" style={{ background: 'rgba(var(--accent-rgb),0.12)' }} /> : null}
        {!lowFxMode ? <div className="absolute right-4 top-24 h-56 w-56 rounded-full blur-3xl" style={{ background: 'rgba(var(--accent-rgb),0.10)' }} /> : null}
        {!lowFxMode ? <div className="absolute inset-x-0 top-[38%] mx-auto h-52 w-52 rounded-full blur-[88px]" style={{ background: 'rgba(var(--accent-rgb),0.18)', animation: 'softGlow 4.8s ease-in-out infinite' }} /> : null}

        {historyOpen ? (
          <div
            className="absolute inset-0 z-40 flex items-center justify-center bg-slate-950/55 px-4"
            onClick={() => setHistoryOpen(false)}
          >
            <div
              className="flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-[1.5rem] border md:max-h-[82vh] md:flex-row md:rounded-[2rem]"
              style={{ borderColor: 'var(--border)', background: 'var(--surface)', boxShadow: 'var(--shadow-soft)' }}
              onClick={event => event.stopPropagation()}
            >
              <aside className="w-full border-b md:max-w-[320px] md:border-b-0 md:border-r" style={{ borderColor: 'var(--border)', background: 'color-mix(in srgb, var(--surface-2) 88%, transparent)' }}>
                <div className="px-4 pb-4 pt-5">
                  <div className="mb-3 flex items-center justify-between">
                    <p className="text-sm font-bold text-[color:var(--text)]">แชทของฉัน</p>
                    <button
                      type="button"
                      onClick={() => setHistoryOpen(false)}
                      className="rounded-full p-1.5 text-[color:var(--muted)] transition hover:text-[color:var(--text)]"
                      style={{ background: 'transparent' }}
                      aria-label="ปิดล็อบบี้"
                    >
                      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 6 6 18" />
                        <path d="m6 6 12 12" />
                      </svg>
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={createNewChatRoom}
                    className="mb-3 inline-flex w-full items-center gap-2 rounded-full px-3 py-2 text-[11px] font-semibold shadow-sm transition hover:brightness-110"
                    style={{
                      color: 'rgba(var(--on-accent-rgb),0.96)',
                      border: '1px solid rgba(var(--accent-rgb),0.52)',
                      background: 'linear-gradient(135deg, rgba(var(--accent-rgb),0.92) 0%, rgba(var(--accent-rgb),0.74) 100%)',
                      backdropFilter: lowFxMode ? undefined : 'blur(10px)'
                    }}
                  >
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 5v14" />
                      <path d="M5 12h14" />
                    </svg>
                    เริ่มแชทใหม่
                  </button>
                  <div className="mb-3 flex items-center gap-2 rounded-xl border px-3 py-2" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
                    <svg viewBox="0 0 24 24" className="h-4 w-4 text-[color:var(--muted)]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="11" cy="11" r="8" />
                      <path d="m21 21-4.3-4.3" />
                    </svg>
                    <input
                      value={chatRoomSearch}
                      onChange={event => setChatRoomSearch(event.target.value)}
                      placeholder="ค้นหาแชท"
                      className="w-full bg-transparent text-sm text-[color:var(--text)] outline-none placeholder:text-[color:var(--muted)]"
                    />
                  </div>
                  <div className="max-h-[28vh] space-y-2 overflow-y-auto pr-1 md:max-h-[62vh]">
                    {filteredChatRooms.map(room => (
                      <button
                        key={room.id}
                        type="button"
                        onClick={() => {
                          setActiveChatRoomId(room.id);
                          setChatError(null);
                        }}
                        className={`w-full rounded-xl border px-3 py-2 text-left transition ${
                          room.id === activeChatRoomId
                            ? 'border-[color:var(--accent)] shadow-sm'
                            : 'border-transparent hover:border-[color:var(--border)]'
                        }`}
                        style={{ background: room.id === activeChatRoomId ? 'var(--surface)' : 'color-mix(in srgb, var(--surface) 78%, transparent)' }}
                      >
                        <p className="truncate text-sm font-semibold text-[color:var(--text)]">{room.title}</p>
                        <p className="mt-1 truncate text-xs text-[color:var(--muted)]">{room.last_message || 'ยังไม่มีข้อความ'}</p>
                      </button>
                    ))}
                  </div>
                </div>
              </aside>

              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div className="flex items-center justify-between border-b px-5 py-4 md:px-6" style={{ borderColor: 'var(--border)' }}>
                  <div>
                    <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-[color:var(--accent)]">Chat History</p>
                    <h3 className="mt-1 text-base font-bold text-[color:var(--text)] md:text-lg">
                      {chatRooms.find(room => room.id === activeChatRoomId)?.title ?? 'ประวัติการสนทนา'}
                    </h3>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={clearChatHistory}
                      disabled={clearingHistory || chatMessages.length === 0}
                      className="inline-flex items-center rounded-full border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-600 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {clearingHistory ? 'กำลังลบ...' : 'ลบประวัติ'}
                    </button>
                  </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 md:px-6">
                  {chatLoading ? (
                    <div className="rounded-2xl px-4 py-4 text-[13px] text-[color:var(--muted)]" style={{ background: 'var(--surface-2)' }}>กำลังโหลดประวัติการคุย...</div>
                  ) : chatMessages.length === 0 ? (
                    <div className="rounded-2xl px-4 py-4 text-[13px] text-[color:var(--muted)]" style={{ background: 'var(--surface-2)' }}>ยังไม่มีประวัติการคุยในห้องนี้</div>
                  ) : (
                    <div className="space-y-3">
                      {chatMessages.slice(-24).map(message => (
                        <div
                          key={message.id}
                          className={`rounded-[1.4rem] px-4 py-3 shadow-sm ring-1 ring-black/5 ${
                            message.sender_type === 'assistant'
                              ? 'text-[color:var(--text)]'
                              : 'bg-[color:rgba(var(--accent-rgb),0.08)] text-[color:var(--text)]'
                          }`}
                          style={message.sender_type === 'assistant' ? { background: 'var(--surface-2)' } : undefined}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-[color:var(--muted)]">
                              {message.sender_type === 'assistant' ? 'AI' : 'You'}
                            </span>
                            <span className="text-[10px] text-[color:var(--muted)]">
                              {message.created_at
                                ? new Date(message.created_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
                                : ''}
                            </span>
                          </div>
                          <p className="mt-2 whitespace-pre-wrap text-[14px] leading-6">
                            {message.sender_type === 'assistant'
                              ? normalizeAssistantFallback(message.message)
                              : message.message}
                          </p>
                          <div className="mt-2 flex justify-end">
                            <button
                              type="button"
                              onClick={() => void deleteChatMessage(message.id)}
                              disabled={deletingMessageId !== null}
                              className="rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-[10px] font-semibold text-rose-600 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {deletingMessageId === message.id ? 'กำลังลบ...' : 'ลบ'}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : null}

        <div className="smart-home-stack relative z-10 mx-auto flex h-full min-h-0 w-full max-w-[430px] flex-col gap-4 px-3 pb-0 pt-3 md:gap-5">
          <section
            className="smart-home-bubble relative overflow-visible rounded-[1.8rem] px-5 py-5 ring-1 md:px-6 md:py-6"
            style={{
              border: '1px solid var(--border)',
              background: 'color-mix(in srgb, var(--surface) 94%, transparent)',
              boxShadow: lowFxMode ? '0 8px 18px rgba(var(--accent-rgb),0.10)' : '0 18px 40px rgba(var(--accent-rgb),0.12)',
              animation: lowFxMode ? 'none' : 'bubblePulse 5.4s ease-in-out infinite'
            }}
          >
            <span
              aria-hidden="true"
              className="absolute left-1/2 top-full z-0 -translate-x-1/2 -translate-y-[4px] drop-shadow-[0_10px_18px_rgba(15,23,42,0.08)]"
              style={{ color: 'var(--surface)' }}
            >
              <svg width="34" height="18" viewBox="0 0 34 18" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path d="M17 18L0 0H34L17 18Z" fill="currentColor" />
              </svg>
            </span>
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 rounded-[1.8rem] ring-1 ring-black/[0.03]"
            />
            <div className="relative z-10">
              <div className="smart-home-actions flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="relative flex h-3 w-3">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/45" />
                    <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-500" />
                  </span>
                  <span className="smart-home-label text-[10px] font-bold uppercase tracking-[0.24em] text-[color:var(--accent)]">Smart Assistant</span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={createNewChatRoom}
                    className="inline-flex items-center gap-2 rounded-full px-3 py-2 text-[11px] font-semibold shadow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                    style={{
                      color: 'rgba(var(--on-accent-rgb),0.96)',
                      border: '1px solid rgba(var(--accent-rgb),0.52)',
                      background: 'linear-gradient(135deg, rgba(var(--accent-rgb),0.92) 0%, rgba(var(--accent-rgb),0.74) 100%)',
                      boxShadow: lowFxMode ? '0 6px 12px rgba(var(--accent-rgb),0.20)' : '0 10px 24px rgba(var(--accent-rgb),0.28)',
                      backdropFilter: lowFxMode ? undefined : 'blur(10px)'
                    }}
                  >
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                    เริ่มแชทใหม่
                  </button>
                  <button
                    type="button"
                    onClick={() => setHistoryOpen(prev => !prev)}
                    className="inline-flex items-center gap-2 rounded-full px-3 py-2 text-[11px] font-semibold shadow-sm transition hover:brightness-110"
                    style={{
                      color: 'var(--text)',
                      border: '1px solid rgba(var(--accent-rgb),0.28)',
                      background: 'rgba(var(--accent-rgb),0.10)',
                      backdropFilter: lowFxMode ? undefined : 'blur(10px)'
                    }}
                  >
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 8v4l3 3" />
                      <circle cx="12" cy="12" r="9" />
                    </svg>
                    ดูประวัติ
                  </button>
                </div>
              </div>

              {isThinking ? (
                <div className="mt-4 inline-flex items-center gap-2 rounded-full px-3 py-2" style={{ background: 'var(--surface-3)', color: 'var(--text)' }}>
                  <span className="h-2.5 w-2.5 animate-bounce rounded-full bg-current [animation-delay:-0.2s]" />
                  <span className="h-2.5 w-2.5 animate-bounce rounded-full bg-current [animation-delay:-0.1s]" />
                  <span className="h-2.5 w-2.5 animate-bounce rounded-full bg-current" />
                </div>
              ) : (
                <div className="relative mt-4">
                  <div className="smart-home-message max-h-[7rem] overflow-y-auto pr-1">
                    <p className="text-[15px] font-semibold leading-7 text-[color:var(--text)]">
                      {assistantMessage}
                    </p>
                  </div>
                </div>
              )}
            </div>

          </section>

          <section className="smart-home-robot-section relative flex min-h-0 flex-1 items-start justify-center pt-2 lg:pt-6 xl:pt-4">
            <div className="relative flex w-full max-w-full flex-col items-center">
              <div style={{ animation: 'float 3.8s ease-in-out infinite' }}>
              <img
                src={robotImage}
                alt="AI Robot"
                className="smart-home-robot relative z-10 h-[clamp(180px,38vh,300px)] w-[clamp(180px,38vh,300px)] object-contain drop-shadow-[0_28px_38px_rgba(15,23,42,0.15)] sm:h-[280px] sm:w-[280px] md:h-[290px] md:w-[290px] lg:h-[310px] lg:w-[310px] xl:h-[330px] xl:w-[330px]"
                style={{ filter: lowFxMode ? 'drop-shadow(0 10px 16px rgba(15,23,42,0.12))' : undefined }}
              />
              </div>
            </div>
          </section>

          <section className="smart-home-composer relative bg-transparent px-0 pt-0 pb-1 md:pb-3 lg:pb-0" ref={attachmentTrayRef}>
            <div className="mx-auto w-full max-w-2xl">
              <div
                className={`mb-3 transition-all duration-200 ${
                  attachmentTrayOpen ? 'translate-y-0 opacity-100' : 'pointer-events-none -translate-y-2 opacity-0'
                }`}
              >
                <div className="inline-flex rounded-[1.6rem] px-5 py-4 ring-1" style={{ background: 'color-mix(in srgb, var(--surface) 94%, transparent)', borderColor: 'var(--border)' }}>
                  <div className="flex items-start gap-5">
                    <label className="flex cursor-pointer flex-col items-center gap-3 text-slate-600 transition hover:text-[color:var(--accent)]">
                      <input type="file" className="hidden" onChange={event => setAttachedFileName(event.target.files?.[0]?.name ?? '')} />
                      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-50">
                        <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M21.4 11.1 12.3 20.2a5 5 0 0 1-7.1-7.1l9.5-9.5a3.5 3.5 0 0 1 5 5l-9.2 9.2a2 2 0 1 1-2.8-2.8l8.1-8.1" />
                        </svg>
                      </span>
                      <span className="text-[13px] font-semibold">เอกสาร</span>
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedTool('สรุปบทเรียน');
                        setAttachmentTrayOpen(false);
                      }}
                      className="flex flex-col items-center gap-3 text-slate-600 transition hover:text-[color:var(--accent)]"
                    >
                      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-50">
                        <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <rect x="3" y="3" width="18" height="18" rx="3" />
                          <circle cx="8.5" cy="8.5" r="1.5" />
                          <path d="m21 15-5-5L5 21" />
                        </svg>
                      </span>
                      <span className="text-[13px] font-semibold">รูปภาพ</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedTool('ถามการบ้าน');
                        setAttachmentTrayOpen(false);
                      }}
                      className="flex flex-col items-center gap-3 text-slate-600 transition hover:text-[color:var(--accent)]"
                    >
                      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-50">
                        <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M4 7h4l2-2h4l2 2h4v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" />
                          <circle cx="12" cy="13" r="3" />
                        </svg>
                      </span>
                      <span className="text-[13px] font-semibold">ถ่ายรูป</span>
                    </button>
                  </div>
                </div>
              </div>

              {attachedFileName ? (
                <div className="mb-3 inline-flex max-w-full items-center gap-2 rounded-full px-3 py-1.5 text-[11px] font-medium shadow-sm ring-1" style={{ background: 'var(--surface)', color: 'var(--text)', borderColor: 'var(--border)' }}>
                  <span className="truncate">{attachedFileName}</span>
                  <button
                    type="button"
                    onClick={() => setAttachedFileName('')}
                    className="text-slate-400 hover:text-slate-700"
                  >
                    ×
                  </button>
                </div>
              ) : null}

              {chatError ? (
                <div className="mb-3 rounded-2xl bg-rose-50 px-3 py-2 text-[12px] font-medium text-rose-600 ring-1 ring-rose-100">
                  {chatError}
                </div>
              ) : null}

              {!hasAuthToken && !authLoading ? (
                <div className="mb-3 rounded-2xl bg-amber-50 px-3 py-2 text-[12px] font-medium text-amber-700 ring-1 ring-amber-100">
                  กรุณาเข้าสู่ระบบใหม่อีกครั้งก่อนใช้งานแชต
                </div>
              ) : null}

              <div className="lg:flex lg:items-end lg:gap-4">
              <form onSubmit={handleAssistantSubmit} className="flex items-center gap-3 lg:flex-1">
                <div
                  className="smart-home-input-shell flex flex-1 items-center rounded-[2rem] border-2 px-4 py-2.5 shadow-[0_12px_28px_rgba(15,23,42,0.05)]"
                  style={{
                    background: 'color-mix(in srgb, var(--surface) 94%, transparent)',
                    borderColor: 'rgba(var(--accent-rgb),0.34)',
                    boxShadow: lowFxMode ? '0 10px 20px rgba(var(--accent-rgb),0.08)' : '0 18px 36px rgba(var(--accent-rgb),0.10)',
                    backdropFilter: lowFxMode ? undefined : 'blur(8px)'
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setAttachmentTrayOpen(prev => !prev)}
                    className="smart-home-tool-button mr-3 flex h-10 w-10 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-50 hover:text-[color:var(--accent)]"
                    aria-label="แนบไฟล์และเครื่องมือ"
                  >
                    {attachmentTrayOpen ? (
                      <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M18 6 6 18" />
                        <path d="m6 6 12 12" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M12 5v14" />
                        <path d="M5 12h14" />
                      </svg>
                    )}
                  </button>

                  <textarea
                    value={inputText}
                    onChange={event => setInputText(event.target.value)}
                    placeholder="พิมพ์ข้อความที่นี่..."
                    disabled={isThinking}
                    rows={1}
                    className="max-h-24 min-h-[24px] flex-1 resize-none bg-transparent py-1.5 text-[15px] font-medium text-[color:var(--text)] outline-none placeholder:text-slate-400"
                    onKeyDown={event => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        void submitAssistantPrompt(inputText);
                      }
                    }}
                  />

                  <button
                    type="button"
                    onClick={() => {
                      if (isListening) {
                        stopVoiceInput();
                      } else {
                        startVoiceInput();
                      }
                    }}
                    disabled={!voiceInputSupported || isThinking}
                    className={`smart-home-mic-button ml-3 flex h-10 w-10 items-center justify-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-50 ${
                      isListening
                        ? 'bg-rose-50 text-rose-500 shadow-[0_10px_24px_rgba(244,63,94,0.15)]'
                        : 'text-slate-400 hover:bg-slate-50 hover:text-[color:var(--accent)]'
                    }`}
                    aria-label={isListening ? 'หยุดฟังเสียง' : 'พูดเป็นข้อความ'}
                    title={
                      !voiceInputSupported
                        ? 'อุปกรณ์นี้ไม่รองรับการพูดเป็นข้อความ'
                        : isListening
                          ? 'กำลังฟังอยู่'
                          : 'พูดเป็นข้อความ'
                    }
                  >
                    {isListening ? (
                      <span className="relative flex h-3 w-3">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current/35" />
                        <span className="relative inline-flex h-3 w-3 rounded-full bg-current" />
                      </span>
                    ) : null}
                    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="9" y="3" width="6" height="11" rx="3" />
                      <path d="M5 10v2a7 7 0 0 0 14 0v-2" />
                      <path d="M12 19v2" />
                    </svg>
                  </button>
                </div>

                <button
                  type="submit"
                  disabled={!canSendChat}
                  className="smart-home-send flex h-[60px] w-[60px] shrink-0 items-center justify-center rounded-full border text-[color:var(--accent)] transition hover:scale-[1.02] disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-300"
                  style={{
                    borderColor: 'rgba(var(--accent-rgb),0.24)',
                    background: 'var(--surface)',
                    boxShadow: '0 14px 26px rgba(var(--accent-rgb),0.12)'
                  }}
                >
                  <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M22 2 11 13" />
                    <path d="M22 2 15 22 11 13 2 9 22 2Z" />
                  </svg>
                </button>
              </form>
              <div
                className={`hidden w-[220px] shrink-0 rounded-[1.75rem] border p-4 backdrop-blur-sm lg:block ${
                  isDraggingSmartMenu ? 'select-none' : ''
                }`}
                style={{
                  borderColor: 'var(--border)',
                  background: isDesktopLike
                    ? 'color-mix(in srgb, var(--surface) 94%, transparent)'
                    : 'var(--surface)',
                  boxShadow: isDesktopLike ? 'var(--shadow-soft)' : 'none',
                  transform: `translate3d(${smartMenuOffset.x}px, ${smartMenuOffset.y}px, 0)`,
                  transition: isDraggingSmartMenu ? 'none' : 'transform 120ms ease',
                  willChange: 'transform',
                  contain: 'layout paint',
                }}
                title="ลาก Smart Menu ไปตำแหน่งที่ต้องการ"
              >
                <div
                  className="mb-3 flex items-center justify-between"
                  style={{ cursor: isDraggingSmartMenu ? 'grabbing' : 'grab' }}
                  onPointerDown={event => {
                    if (event.button !== 0) return;
                    if (!isDesktopLike) return;
                    smartMenuDragStartRef.current = {
                      x: smartMenuOffset.x,
                      y: smartMenuOffset.y,
                      pointerX: event.clientX,
                      pointerY: event.clientY,
                    };
                    setIsDraggingSmartMenu(true);
                  }}
                >
                  <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[color:var(--accent)]">Smart Menu</p>
                  <span className="text-[10px] font-medium text-slate-400">ลากได้</span>
                </div>
                <div
                  className="space-y-2.5"
                  style={{
                    maxHeight: '58vh',
                    overflowY: 'auto',
                    WebkitOverflowScrolling: 'touch',
                    overscrollBehaviorY: 'contain',
                    scrollbarWidth: 'thin',
                  }}
                >
                  {quickActionItems.map(action => (
                    <button
                      key={action.id}
                      type="button"
                      onClick={() => navigate(action.to)}
                      className="group flex w-full items-center gap-3 rounded-2xl border px-3 py-3 text-left transition hover:-translate-y-0.5 motion-reduce:transition-none"
                      style={{
                        borderColor: 'var(--border)',
                        background: 'color-mix(in srgb, var(--surface) 94%, transparent)',
                        boxShadow: isDesktopLike ? '0 6px 14px rgba(var(--accent-rgb),0.06)' : 'none'
                      }}
                    >
                      <span
                        className={`flex shrink-0 items-center justify-center ${
                          action.id === 'study-capture'
                            ? 'relative h-[44px] w-[44px] overflow-visible'
                            : `h-11 w-11 rounded-[1rem] border border-white/80 shadow-[0_8px_18px_rgba(15,23,42,0.05)] ${action.iconClassName}`
                        }`}
                        style={action.id === 'study-capture' ? undefined : action.tileStyle}
                      >
                        {action.icon}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[12px] font-semibold leading-5 text-[color:var(--text)]">{action.label}</span>
                        <span className="block text-[10px] text-[color:var(--muted)]">
                          {action.id === 'study-storage' ? 'รวมไฟล์แนบไว้ในที่เดียว' : 'เปิดใช้งานได้ทันที'}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden pb-16">
      <div className="career-bg-blob career-blob-1" />
      <div className="career-bg-blob career-blob-2" />
      <div className="career-bg-blob career-blob-3" />

      <div className="relative z-10 space-y-6">
        {!isAuthenticated ? (
          <div className="career-soft-card p-6 text-center text-muted shadow-soft">
            กรุณาเข้าสู่ระบบเพื่อดูคำแนะนำอาชีพของคุณ
          </div>
        ) : (
          <>
            {error ? (
              <div className="rounded-[2rem] border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-500 shadow-soft">{error}</div>
            ) : null}

            {info ? (
              <div className="rounded-[2rem] p-4 text-sm shadow-soft" style={{ border: '1px solid rgba(var(--accent-rgb),0.18)', background: 'rgba(var(--accent-rgb),0.10)', color: 'var(--accent)' }}>
                {info}
              </div>
            ) : null}

            <section className="career-soft-card p-4 md:p-5">
              <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div className="flex items-center gap-4 w-full md:w-auto">
                  <label className="text-muted font-semibold whitespace-nowrap">ภาคเรียน</label>
                  <div className="relative w-full md:w-72">
                    <select
                      value={selectedSemesterKey}
                      onChange={event => setSelectedSemesterKey(event.target.value)}
                      className="w-full rounded-xl bg-white/50 border border-white/40 px-4 py-2.5 pr-10 text-sm text-[color:var(--text)] outline-none transition cursor-pointer appearance-none"
                      style={{ boxShadow: '0 0 0 0 rgba(0,0,0,0)' }}
                    >
                      {semesterOptions.map(option => (
                        <option key={option.key} value={option.key}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-muted">
                      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="m6 9 6 6 6-6" />
                      </svg>
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={analyzeNow}
                  disabled={loading}
                  className="text-white px-6 py-2.5 rounded-xl font-bold inline-flex items-center justify-center gap-2 w-full md:w-auto disabled:cursor-not-allowed disabled:opacity-70"
                  style={{ background: 'linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 72%, white))', boxShadow: '0 16px 30px rgba(var(--accent-rgb),0.24)' }}
                >
                  <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                    <path d="M3 3v5h5" />
                    <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
                    <path d="M16 16h5v5" />
                  </svg>
                  {loading ? 'กำลังรีเฟรช...' : 'รีเฟรชวิเคราะห์ข้อมูลล่าสุด'}
                </button>
              </div>
            </section>

            <div className="rounded-[40px] p-4 md:p-6" style={{ background: 'linear-gradient(135deg, rgba(205,226,252,0.48), rgba(233,238,255,0.55))' }}>
              <div className="grid grid-cols-1 gap-6 xl:grid-cols-[2fr_1fr]">
                <div className="flex flex-col gap-6">
                  <section
                    className="relative overflow-hidden rounded-[34px] border border-white/70 p-6 md:p-8"
                    style={{
                      background: 'linear-gradient(145deg, rgba(230,246,255,0.82) 0%, rgba(225,248,241,0.78) 100%)',
                      backdropFilter: 'blur(16px)',
                      boxShadow: '0 10px 50px rgba(120,130,255,0.10)',
                    }}
                  >
                    <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-cyan-100/40 via-transparent to-green-100/40" />
                    <div className="pointer-events-none absolute -bottom-20 -right-10 h-[320px] w-[700px] rounded-full bg-gradient-to-r from-cyan-200/40 to-green-200/40 blur-2xl" />
                    <div className="absolute right-6 top-6 hidden h-24 w-24 items-center justify-center rounded-[28px] bg-white/60 text-4xl shadow-lg md:flex">
                      💼
                    </div>

                    <div className="relative z-10">
                      <div className="inline-flex items-center gap-2 rounded-2xl border border-white bg-white/70 px-5 py-3 font-semibold text-indigo-600 shadow">
                        ✨ สรุปคำแนะนำ
                      </div>

                      <p className="mt-7 text-base text-slate-500">เส้นทางอาชีพที่เหมาะกับคุณ</p>
                      <h2 className="mt-1 text-4xl font-bold leading-tight text-[#17346f] md:text-6xl">
                        {primaryRecommendation?.title ?? 'ยังไม่มีข้อมูลแนะนำ'} ✨
                      </h2>

                      <div className="mt-8 flex items-center gap-4">
                        <div className="h-4 flex-1 overflow-hidden rounded-full bg-slate-100">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-cyan-400"
                            style={{ width: `${Math.max(8, primaryRecommendation?.score ?? 0)}%` }}
                          />
                        </div>
                        <span className="whitespace-nowrap text-sm font-medium text-slate-500">ระดับความเหมาะสม {primaryRecommendation?.score ?? 0}%</span>
                      </div>

                      <p className="mt-6 max-w-[880px] text-base leading-relaxed text-slate-500">
                        {primaryRecommendation?.reason ?? 'เนื่องจากผู้ใช้มีการบันทึกและเรียนในวิชาที่เกี่ยวข้อง แต่ยังขาดการสรุปและวิเคราะห์เชิงลึกเพิ่มเติม'}
                      </p>

                      <button
                        type="button"
                        className="mt-8 rounded-2xl px-7 py-4 text-base font-semibold text-white duration-300 hover:scale-[1.02]"
                        style={{ background: 'linear-gradient(to right, #6366f1, #22d3ee)', boxShadow: '0 10px 30px rgba(80,120,255,.35)' }}
                      >
                        ดูอาชีพแนะนำทั้งหมด →
                      </button>
                    </div>
                  </section>

                  <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                    <section className="rounded-[30px] border border-white/70 bg-white/60 p-6 backdrop-blur-2xl shadow-[0_10px_40px_rgba(120,130,255,.08)]">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex gap-3">
                          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-violet-100 text-xl text-violet-600">✦</div>
                          <div>
                            <h3 className="text-2xl font-bold text-slate-800">ทักษะที่ควรเริ่มพัฒนาก่อน</h3>
                            <p className="mt-1 text-sm text-slate-500">สรุปจากสายอาชีพที่เหมาะกับคุณตอนนี้</p>
                          </div>
                        </div>
                        <button type="button" className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white text-xl shadow">›</button>
                      </div>

                      <div className="mt-8 flex flex-wrap gap-3">
                        {prioritizedSkills.length ? (
                          prioritizedSkills.slice(0, 6).map(skill => (
                            <span key={`skill-${skill}`} className="rounded-2xl border border-violet-100 bg-violet-50 px-5 py-3 font-medium text-violet-600">
                              {skill}
                            </span>
                          ))
                        ) : (
                          <span className="text-sm text-slate-500">ยังไม่มีข้อมูลทักษะแนะนำ</span>
                        )}
                      </div>
                    </section>

                    <section className="rounded-[30px] border border-white/70 bg-white/60 p-6 backdrop-blur-2xl shadow-[0_10px_40px_rgba(120,130,255,.08)]">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex gap-3">
                          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-cyan-100 text-xl text-cyan-600">📈</div>
                          <div>
                            <h3 className="text-2xl font-bold text-slate-800">สถิติชั่วโมงเรียน</h3>
                            <p className="mt-1 text-sm text-slate-500">ภาพรวมจากภารกิจสัปดาห์นี้</p>
                          </div>
                        </div>
                        <div className="rounded-2xl border bg-white px-4 py-2 text-slate-600">สัปดาห์นี้</div>
                      </div>

                      <div className="mt-6 rounded-2xl border bg-white/45 p-3" style={{ borderColor: 'rgba(148,163,184,.22)' }}>
                        <svg viewBox="0 0 500 180" className="h-[150px] w-full" fill="none">
                          <line x1="20" y1="22" x2="480" y2="22" stroke="rgba(148,163,184,.18)" />
                          <line x1="20" y1="85" x2="480" y2="85" stroke="rgba(148,163,184,.18)" />
                          <line x1="20" y1="148" x2="480" y2="148" stroke="rgba(148,163,184,.18)" />
                          <polyline
                            points={weeklyChart.data
                              .map((value, index) => {
                                const x = 20 + index * ((480 - 20) / 6);
                                const y = 148 - (value / weeklyChart.max) * 120;
                                return `${x},${y}`;
                              })
                              .join(' ')}
                            stroke="#4ade80"
                            strokeWidth="4"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            fill="none"
                          />
                          {weeklyChart.data.map((value, index) => {
                            const x = 20 + index * ((480 - 20) / 6);
                            const y = 148 - (value / weeklyChart.max) * 120;
                            const isPeak = value === Math.max(...weeklyChart.data);
                            return (
                              <circle key={`pt-${index}`} cx={x} cy={y} r={isPeak ? 6 : 4} fill={isPeak ? '#22c55e' : '#86efac'} />
                            );
                          })}
                        </svg>
                        <div className="mt-1 grid grid-cols-7 text-center text-sm font-semibold text-slate-500">
                          {['จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส', 'อา'].map(day => (
                            <span key={day}>{day}</span>
                          ))}
                        </div>
                      </div>

                      <div className="mt-4 inline-flex rounded-2xl border border-cyan-100 bg-cyan-50 px-5 py-3 text-slate-700">
                        🎓 วิชาที่โดดเด่นตอนนี้ {studyStats.mostReviewedSubject?.subject_name ?? '—'} ({studyStats.totalStudyHours.toFixed(1)} ชม.)
                      </div>
                    </section>
                  </div>
                </div>

                <aside className="rounded-[34px] border border-white/70 bg-white/60 p-6 backdrop-blur-2xl shadow-[0_10px_40px_rgba(120,130,255,.08)]">
                  <h3 className="text-2xl font-bold text-violet-600">✦ ควิซล่าสุด</h3>
                  <div className="mt-5 flex items-end justify-between gap-4">
                    <div>
                      <p className="text-slate-500">คะแนนควิซล่าสุด</p>
                      <p className="mt-1 text-slate-400">ผ่านไป {latestQuiz ? 1 : 0} ควิซ</p>
                    </div>
                    <div className="text-5xl font-bold text-violet-600">{latestQuiz?.percentage ?? 0}%</div>
                  </div>
                </aside>
              </div>
            </div>
          </>
        )}
    </div>
  </div>
  );
};
