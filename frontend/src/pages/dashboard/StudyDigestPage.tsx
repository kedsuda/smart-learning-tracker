import { BarChart3, BookOpen, Bot, Calendar, FileText, Filter, PieChart, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../services/api';

type SubjectOption = {
  id: number;
  name: string;
};

type StudyLogEntry = {
  id: number;
  title?: string | null;
  note?: string | null;
  log_date: string;
  duration_minutes?: number | null;
  mood?: string | null;
};

type StudySummaryRange = 'today' | 'week' | 'month' | 'year';

type DecoratedLog = StudyLogEntry & {
  subjectName: string;
};

const rangeOptions: Array<{ key: StudySummaryRange; label: string }> = [
  { key: 'today', label: 'วันนี้' },
  { key: 'week', label: 'สัปดาห์นี้' },
  { key: 'month', label: 'เดือนนี้' },
  { key: 'year', label: 'ปีนี้' },
];

const getRangeBounds = (range: StudySummaryRange) => {
  const now = new Date();
  const start = new Date(now);
  const end = new Date(now);

  if (range === 'today') {
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }

  if (range === 'week') {
    const dayIndex = (now.getDay() + 6) % 7;
    start.setDate(now.getDate() - dayIndex);
    start.setHours(0, 0, 0, 0);
    end.setTime(start.getTime());
    end.setDate(start.getDate() + 6);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }

  if (range === 'month') {
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    end.setMonth(now.getMonth() + 1, 0);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }

  start.setMonth(0, 1);
  start.setHours(0, 0, 0, 0);
  end.setMonth(11, 31);
  end.setHours(23, 59, 59, 999);
  return { start, end };
};

const formatRangeLabel = (range: StudySummaryRange) =>
  range === 'today' ? 'วันนี้' : range === 'week' ? 'สัปดาห์นี้' : range === 'month' ? 'เดือนนี้' : 'ปีนี้';

const formatHours = (minutes: number) => Math.round((minutes / 60) * 10) / 10;

const safeTrim = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const formatThaiDate = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' });
};

const buildSummaryText = (logs: DecoratedLog[], range: StudySummaryRange) => {
  if (logs.length === 0) {
    return `ยังไม่มีบันทึกการเรียนในช่วง${formatRangeLabel(range)} ลองเพิ่มบันทึกการเรียนก่อนนะคะ`;
  }

  const totalMinutes = logs.reduce((sum, log) => sum + Number(log.duration_minutes ?? 0), 0);
  const subjectMinutes = new Map<string, number>();
  logs.forEach(log => {
    subjectMinutes.set(log.subjectName, (subjectMinutes.get(log.subjectName) ?? 0) + Number(log.duration_minutes ?? 0));
  });

  const topSubjects = [...subjectMinutes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, minutes]) => `${name} ${formatHours(minutes)} ชม.`);

  const highlights = logs
    .flatMap(log => [safeTrim(log.title), safeTrim(log.note)])
    .filter(Boolean)
    .slice(0, 6);

  const moods = [...new Set(logs.map(log => safeTrim(log.mood)).filter(Boolean))].slice(0, 3);

  return [
    `สรุปการเรียน${formatRangeLabel(range)}`,
    `- มีบันทึกทั้งหมด ${logs.length} รายการ ใช้เวลาเรียนรวม ${formatHours(totalMinutes)} ชั่วโมง`,
    `- วิชาที่ใช้เวลามากที่สุด: ${topSubjects.join(', ') || 'ยังไม่มีข้อมูลเพียงพอ'}`,
    `- เนื้อหาที่เรียน: ${highlights.join(' | ') || 'ยังไม่มีรายละเอียดในบันทึก'}`,
    `- อารมณ์การเรียนโดยรวม: ${moods.length ? moods.join(', ') : 'ยังไม่ได้ระบุอารมณ์ในบันทึก'}`
  ].join('\n');
};

export const StudyDigestPage = () => {
  const navigate = useNavigate();
  const [subjects, setSubjects] = useState<SubjectOption[]>([]);
  const [selectedSubject, setSelectedSubject] = useState('all');
  const [range, setRange] = useState<StudySummaryRange>('today');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<DecoratedLog[]>([]);
  const [mindMapText, setMindMapText] = useState('');
  const [mindMapError, setMindMapError] = useState<string | null>(null);
  const [isGeneratingMindMap, setIsGeneratingMindMap] = useState(false);

  const loadLogs = async (selectedRange: StudySummaryRange) => {
    setLoading(true);
    setError(null);
    try {
      const subjectResponse = await api.get('/subjects');
      const payload = Array.isArray(subjectResponse.data)
        ? subjectResponse.data
        : Array.isArray(subjectResponse.data?.data)
          ? subjectResponse.data.data
          : [];

      const nextSubjects: SubjectOption[] = payload
        .map((item: any) => ({
          id: Number(item.id),
          name: String(item.name ?? item.subject_name ?? '')
        }))
        .filter((item: SubjectOption) => Number.isFinite(item.id) && item.name.trim() !== '');

      setSubjects(nextSubjects);

      const responses = await Promise.all(
        nextSubjects.map(subject =>
          api.get(`/subjects/${subject.id}/study-logs`).then(response => ({
            subjectName: subject.name,
            logs: Array.isArray(response.data?.data)
              ? response.data.data
              : Array.isArray(response.data)
                ? response.data
                : []
          }))
        )
      );

      const { start, end } = getRangeBounds(selectedRange);
      const nextLogs = responses.flatMap(({ subjectName, logs }) =>
        logs
          .filter((log: StudyLogEntry) => {
            const logDate = new Date(log.log_date);
            return !Number.isNaN(logDate.getTime()) && logDate >= start && logDate <= end;
          })
          .map((log: StudyLogEntry) => ({
            ...log,
            title: safeTrim(log.title),
            note: safeTrim(log.note),
            mood: safeTrim(log.mood),
            subjectName,
          }))
      );

      nextLogs.sort((a, b) => new Date(b.log_date).getTime() - new Date(a.log_date).getTime());
      setLogs(nextLogs);
    } catch {
      setError('โหลดข้อมูลสรุปการเรียนไม่สำเร็จ ลองใหม่อีกครั้งได้เลย');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadLogs(range);
  }, [range]);

  const filteredLogs = useMemo(() => {
    if (selectedSubject === 'all') return logs;
    return logs.filter(log => String(log.subjectName) === selectedSubject);
  }, [logs, selectedSubject]);

  const summaryText = useMemo(() => buildSummaryText(filteredLogs, range), [filteredLogs, range]);
  const totalMinutes = useMemo(() => filteredLogs.reduce((sum, log) => sum + Number(log.duration_minutes ?? 0), 0), [filteredLogs]);

  const handleGenerateMindMap = async () => {
    setIsGeneratingMindMap(true);
    setMindMapError(null);
    try {
      const response = await api.post<{ mindmap?: string; model?: string; message?: string }>('/ai/mindmap', {
        text: summaryText,
      });
      const next = (response.data?.mindmap ?? '').trim();
      if (!next) {
        setMindMapError(response.data?.message ?? 'ไม่สามารถสร้างมายแมพได้');
        return;
      }
      setMindMapText(next);
    } catch (error: any) {
      setMindMapError(
        error?.response?.data?.message ||
          error?.message ||
          'ไม่สามารถสร้างมายแมพได้'
      );
    } finally {
      setIsGeneratingMindMap(false);
    }
  };

  return (
    <div className="space-y-6 bg-[var(--bg-gradient)] pb-6 text-[color:var(--text)]">
      <section className="mx-auto w-full max-w-6xl rounded-[2rem] border border-[color:var(--border)] bg-[color:var(--surface)] px-6 pb-8 pt-4 shadow-[0_14px_34px_rgba(15,23,42,0.12)]">
        <button
          type="button"
          onClick={() => navigate('/ai-assistant')}
          className="group mb-5 inline-flex w-fit items-center gap-1.5 rounded-full border border-slate-200/90 bg-slate-50/90 px-4 py-2 text-xs font-bold text-slate-600 shadow-[0_4px_12px_rgba(148,163,184,0.12)] transition"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          กลับหน้าหลัก
        </button>

        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[0.32em] text-[color:var(--accent-ink)]">Study Summary</p>
            <h1 className="mt-1.5 text-[2.1rem] font-bold leading-tight text-[color:var(--text)]">สรุปการเรียน</h1>
            <p className="mt-2 max-w-2xl text-base leading-7 text-[color:var(--muted)]">สรุปเป็นรายวัน รายสัปดาห์ รายเดือน หรือรายปีจากบันทึกการเรียนจริง</p>
          </div>
          <div
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full shadow-[0_8px_18px_rgba(var(--accent-rgb),0.18)] ring-1"
            style={{
              background: 'rgba(var(--accent-rgb),0.10)',
              color: 'var(--accent-ink)',
              borderColor: 'rgba(var(--accent-rgb),0.14)',
            }}
          >
            <PieChart size={18} />
          </div>
        </div>
      </section>

      <div className="mx-auto w-full max-w-6xl space-y-6 px-6">
        <section className="rounded-[1.75rem] border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-[0_10px_26px_rgba(15,23,42,0.10)] backdrop-blur">
          <div className="mb-4 flex items-center gap-3">
            <div
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border"
              style={{
                borderColor: 'rgba(var(--accent-rgb),0.16)',
                background: 'rgba(var(--accent-rgb),0.10)',
                color: 'var(--accent-ink)',
              }}
            >
              <Filter size={16} />
            </div>
            <select
              value={selectedSubject}
              onChange={event => setSelectedSubject(event.target.value)}
              className="rounded-full border border-[color:var(--border)] bg-[color:var(--surface-2)] px-4 py-2 text-sm font-bold text-[color:var(--text)] outline-none shadow-sm"
            >
              <option value="all">ทุกวิชา</option>
              {subjects.map(subject => (
                <option key={subject.id} value={subject.name}>
                  {subject.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex rounded-full bg-[color:var(--surface-2)] p-1.5">
            {rangeOptions.map(option => (
              <button
                key={option.key}
                type="button"
                onClick={() => setRange(option.key)}
                className={`flex-1 rounded-full px-4 py-2.5 text-sm font-bold transition ${range === option.key ? 'bg-[color:var(--surface)] shadow-sm' : 'text-[color:var(--muted)] hover:text-[color:var(--text)]'}`}
                style={
                  range === option.key
                    ? {
                        color: 'var(--accent-ink)',
                        boxShadow: '0 8px 18px rgba(var(--accent-rgb),0.12)',
                      }
                    : undefined
                }
              >
                {option.label}
              </button>
            ))}
          </div>
        </section>

        <section className="rounded-[1.75rem] border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-[0_10px_26px_rgba(15,23,42,0.10)] backdrop-blur">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-[color:var(--text)]">บทสรุป{formatRangeLabel(range)}</h2>
              <p className="mt-1 text-sm text-[color:var(--muted)]">อ่านภาพรวมแบบรวดเร็วจากบันทึกการเรียนของคุณ</p>
            </div>
            <span
              className="rounded-full border px-3 py-1 text-[10px] font-bold shadow-sm"
              style={{
                borderColor: 'rgba(var(--accent-rgb),0.18)',
                color: 'var(--accent-ink)',
                background: 'var(--surface-2)',
              }}
            >
              {filteredLogs.length} รายการ
            </span>
          </div>

          <div
            className="relative mt-4 overflow-hidden rounded-[1.5rem] border p-5"
            style={{
              borderColor: 'rgba(var(--accent-rgb),0.14)',
              background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface) 94%, white) 0%, rgba(var(--accent-rgb),0.10) 100%)',
            }}
          >
            <div
              className="absolute -bottom-10 -right-10 h-36 w-36 rounded-full"
              style={{ background: 'rgba(var(--accent-rgb),0.12)' }}
            />
            {loading ? (
              <div className="flex items-center gap-3 text-sm text-[color:var(--muted)]">
                <span
                  className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300"
                  style={{ borderTopColor: 'var(--accent)' }}
                />
                กำลังสรุปการเรียน...
              </div>
            ) : error ? (
              <div className="text-sm font-medium text-rose-600">{error}</div>
            ) : (
              <div className="relative z-10">
                <div
                  className="mb-4 inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-[10px] font-bold shadow-[0_10px_18px_rgba(var(--accent-rgb),0.22)]"
                  style={{ background: 'var(--accent)', color: 'var(--on-accent)', WebkitTextFillColor: 'var(--on-accent)' }}
                >
                  <Sparkles size={12} />
                  สรุปโดย AI
                </div>
                <pre className="whitespace-pre-wrap font-sans text-base font-medium leading-8 text-[color:var(--text)]">{summaryText}</pre>
              </div>
            )}
          </div>

          <div className="mt-4">
            <button
              type="button"
              onClick={() => void handleGenerateMindMap()}
              disabled={isGeneratingMindMap || loading || filteredLogs.length === 0}
              className="flex w-full items-center justify-center gap-2 rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-2)] px-4 py-3 text-sm font-bold text-[color:var(--text)] shadow-sm transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <FileText size={14} />
              {isGeneratingMindMap ? 'กำลังสร้างมายแมพ...' : 'มายแมพสรุป'}
            </button>
            {mindMapError ? <p className="mt-2 text-xs font-medium text-rose-600">{mindMapError}</p> : null}
          </div>
        </section>

        {mindMapText ? (
          <section className="rounded-[1.75rem] border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-[0_10px_26px_rgba(15,23,42,0.10)] backdrop-blur">
            <h3 className="text-lg font-bold text-[color:var(--text)]">มายแมพสรุป</h3>
            <pre className="mt-3 whitespace-pre-wrap rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-2)] p-4 text-sm leading-7 text-[color:var(--text)]">{mindMapText}</pre>
          </section>
        ) : null}

        <section className="rounded-[1.75rem] border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-[0_10px_26px_rgba(15,23,42,0.10)] backdrop-blur">
          <h3 className="text-lg font-bold text-[color:var(--text)]">ภาพรวมช่วงนี้</h3>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div
              className="rounded-[1.4rem] border p-4"
              style={{
                borderColor: 'rgba(var(--accent-rgb),0.14)',
                background: 'linear-gradient(180deg, var(--surface) 0%, rgba(var(--accent-rgb),0.08) 100%)',
              }}
            >
              <div className="mb-3 flex items-center gap-1.5" style={{ color: 'var(--accent-ink)' }}>
                <BookOpen size={14} />
                <span className="text-[11px] font-bold">บันทึก</span>
              </div>
              <span className="text-3xl font-bold leading-none text-[color:var(--text)]">{filteredLogs.length}</span>
              <p className="mt-1 text-xs text-[color:var(--muted)]">รายการ</p>
            </div>
            <div
              className="rounded-[1.4rem] border p-4"
              style={{
                borderColor: 'rgba(var(--accent-rgb),0.14)',
                background: 'linear-gradient(180deg, var(--surface) 0%, rgba(var(--accent-rgb),0.08) 100%)',
              }}
            >
              <div className="mb-3 flex items-center gap-1.5" style={{ color: 'var(--accent-ink)' }}>
                <BarChart3 size={14} />
                <span className="text-[11px] font-bold">เวลาเรียนรวม</span>
              </div>
              <span className="text-3xl font-bold leading-none text-[color:var(--text)]">{formatHours(totalMinutes)}</span>
              <p className="mt-1 text-xs text-[color:var(--muted)]">ชั่วโมง</p>
            </div>
          </div>

          <div className="mt-4 flex items-center gap-4 rounded-[1.4rem] border border-[color:var(--border)] bg-[color:var(--surface-2)] p-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-full border border-[color:var(--border)] bg-[color:var(--surface)] text-[color:var(--muted)] shadow-sm">
              <Calendar size={16} />
            </div>
            <div>
              <h4 className="text-sm font-bold text-[color:var(--text)]">ช่วงเวลาที่กำลังสรุป</h4>
              <p className="mt-0.5 text-xs text-[color:var(--muted)]">{formatRangeLabel(range)} {selectedSubject === 'all' ? '• ทุกวิชา' : `• ${selectedSubject}`}</p>
            </div>
          </div>
        </section>

        <section className="rounded-[1.75rem] border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-[0_10px_26px_rgba(15,23,42,0.10)] backdrop-blur">
          <h3 className="text-lg font-bold text-[color:var(--text)]">รายการที่นำมาสรุป</h3>
          <div className="mt-4 space-y-3">
            {loading ? (
              <div className="rounded-xl bg-[color:var(--surface-2)] px-4 py-4 text-sm text-[color:var(--muted)]">กำลังโหลดรายการ...</div>
            ) : filteredLogs.length > 0 ? (
              filteredLogs.slice(0, 8).map(log => (
                <article key={`${log.subjectName}-${log.id}`} className="rounded-[1.35rem] border border-[color:var(--border)] bg-[color:var(--surface-2)] px-4 py-4 shadow-[0_8px_22px_rgba(15,23,42,0.10)]">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p
                        className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.16em] ring-1"
                        style={{
                          background: 'rgba(var(--accent-rgb),0.10)',
                          color: 'var(--accent-ink)',
                          borderColor: 'rgba(var(--accent-rgb),0.14)',
                        }}
                      >
                        <Bot size={12} />
                        {log.subjectName}
                      </p>
                      <h4 className="mt-1 text-base font-bold text-[color:var(--text)]">{log.title}</h4>
                    </div>
                    <span className="shrink-0 text-sm font-semibold text-[color:var(--muted)]">{Number(log.duration_minutes ?? 0)} นาที</span>
                  </div>
                  <p className="mt-2 line-clamp-3 text-sm leading-6 text-[color:var(--muted)]">{log.note || 'ไม่มีรายละเอียดเพิ่มเติม'}</p>
                  <div className="mt-3 flex items-center justify-between gap-2 text-xs text-[color:var(--muted)]">
                    <span>{formatThaiDate(log.log_date)}</span>
                    <span className="rounded-full bg-[color:var(--surface-2)] px-2 py-1">{log.mood || 'ไม่ระบุความรู้สึก'}</span>
                  </div>
                </article>
              ))
            ) : (
              <div className="rounded-xl border border-dashed border-[color:var(--border)] bg-[color:var(--surface-2)] px-4 py-6 text-center text-xs font-medium text-[color:var(--muted)]">
                ยังไม่มีบันทึกในช่วงเวลานี้
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
