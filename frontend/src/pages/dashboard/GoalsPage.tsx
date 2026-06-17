import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, apiFallbackClients } from '../../services/api';
import { useSemesterOptions } from '../../hooks/useSemesterOptions';
import { filterBySemester, toNumberOrNull } from '../../utils/semester';

type SubjectSummary = {
  subject_id: number;
  subject_name: string;
  quiz_sets: number;
  question_count: number;
};

type QuestSummary = {
  id: number | null;
  quest_type: string;
  title: string;
  description: string;
  reward_points: number;
  status: 'pending' | 'completed' | 'failed';
  target_value: number;
  current_value: number;
  progress_percent: number;
  focus_subject_id: number | null;
  focus_subject_name: string | null;
  focus_lesson_title: string | null;
  focus_quiz_title: string | null;
  celebration_message: string;
  cta_path: string;
};

type GoalState = {
  target_questions: number;
  target_quiz_sets: number;
  current_questions: number;
  current_quiz_sets: number;
  progress_percent: number;
  status: 'achieved' | 'not_achieved' | 'not_set';
  achieved: boolean;
};

type PeriodSummary = {
  period_type: 'daily' | 'weekly' | 'monthly';
  period_start: string;
  period_end: string;
  total_quiz_sets: number;
  total_questions: number;
  subjects: SubjectSummary[];
  goal: GoalState;
  quest: QuestSummary;
};

type GoalSummary = {
  today: PeriodSummary;
  week: PeriodSummary;
  month: PeriodSummary;
};

type SubjectOption = {
  id: number;
  name: string;
  semester_id?: number | null;
  semester?: number | null;
  academic_year?: number | null;
};

type PeriodKey = 'today' | 'week' | 'month';

const periodCards: Array<{ key: PeriodKey; label: string; tint: string }> = [
  { key: 'today', label: 'ภารกิจวันนี้', tint: 'from-blue-500 to-blue-600' },
  { key: 'week', label: 'ภารกิจสัปดาห์นี้', tint: 'from-violet-500 to-violet-600' },
  { key: 'month', label: 'ภารกิจเดือนนี้', tint: 'from-fuchsia-500 to-fuchsia-600' },
];

const sectionThemes = {
  today: {
    icon: 'book',
    sectionBar: 'bg-blue-500',
    iconWrap: 'bg-blue-50 text-blue-600',
    tag: 'border-blue-100 bg-blue-50 text-blue-600',
    outline: 'border-slate-100',
    progressText: 'text-blue-600',
    button: 'bg-blue-600 text-white hover:bg-blue-700 shadow-[0_10px_24px_rgba(37,99,235,0.22)]',
  },
  week: {
    icon: 'target',
    sectionBar: 'bg-violet-500',
    iconWrap: 'bg-violet-50 text-violet-600',
    tag: 'border-violet-100 bg-violet-50 text-violet-600',
    outline: 'border-slate-100',
    progressText: 'text-violet-600',
    button: 'bg-blue-600 text-white hover:bg-blue-700 shadow-[0_10px_24px_rgba(37,99,235,0.22)]',
  },
  month: {
    icon: 'trophy',
    sectionBar: 'bg-fuchsia-500',
    iconWrap: 'bg-fuchsia-50 text-fuchsia-600',
    tag: 'border-fuchsia-100 bg-fuchsia-50 text-fuchsia-600',
    outline: 'border-slate-100',
    progressText: 'text-fuchsia-600',
    button: 'bg-blue-100 text-blue-700 border border-blue-200',
  },
} as const;

const GoalsIcon = ({
  name,
  className = 'h-5 w-5',
}: {
  name: 'target' | 'book' | 'check' | 'trophy' | 'refresh';
  className?: string;
}) => {
  if (name === 'book') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className}>
        <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H20v14H6.5A2.5 2.5 0 0 0 4 20.5v-14Z" />
        <path d="M12 4v14" />
      </svg>
    );
  }

  if (name === 'check') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className}>
        <circle cx="12" cy="12" r="9" />
        <path d="m8.5 12.5 2.3 2.3 4.7-5.3" />
      </svg>
    );
  }

  if (name === 'trophy') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className}>
        <path d="M8 4h8v3a4 4 0 0 1-8 0V4Z" />
        <path d="M6 6H4a2 2 0 0 0 2 2" />
        <path d="M18 6h2a2 2 0 0 1-2 2" />
        <path d="M12 11v3" />
        <path d="M9 21h6" />
        <path d="M10 14h4l1 7H9l1-7Z" />
      </svg>
    );
  }

  if (name === 'refresh') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className}>
        <path d="M3 12a9 9 0 1 0 3-6.7" />
        <path d="M3 4v4h4" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
};

export const GoalsPage = () => {
  const navigate = useNavigate();
  const semesterOptions = useSemesterOptions();
  const [subjects, setSubjects] = useState<SubjectOption[]>([]);
  const [selectedSemesterKey, setSelectedSemesterKey] = useState('all');
  const [selectedSubject, setSelectedSubject] = useState<number | null>(null);
  const [summary, setSummary] = useState<GoalSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [celebrating, setCelebrating] = useState(false);
  const [targetInputs, setTargetInputs] = useState<Record<PeriodKey, string>>({
    today: '',
    week: '',
    month: '',
  });
  const [savingTarget, setSavingTarget] = useState<PeriodKey | null>(null);
  const previousQuestStatusRef = useRef<string | null>(null);
  const inputRefs = useRef<Record<PeriodKey, HTMLInputElement | null>>({ today: null, week: null, month: null });

  const filteredSubjects = useMemo(
    () => filterBySemester(subjects, selectedSemesterKey),
    [subjects, selectedSemesterKey]
  );

  const selectedSubjectOption = useMemo(
    () => subjects.find(subject => subject.id === selectedSubject) ?? null,
    [selectedSubject, subjects]
  );

  const selectedSemesterOption = useMemo(
    () => semesterOptions.find(option => option.key === selectedSemesterKey) ?? semesterOptions[0],
    [semesterOptions, selectedSemesterKey]
  );

  const loadSubjects = async () => {
    for (const client of apiFallbackClients) {
      try {
        const res = await client.get('/subjects');
        const rows = Array.isArray(res.data)
          ? res.data
          : Array.isArray(res.data?.data)
            ? res.data.data
            : Array.isArray(res.data?.data?.data)
              ? res.data.data.data
              : [];

        const nextSubjects = rows
          .map((item: any) => {
            const id = Number(item?.id ?? item?.subject_id);
            const nameCandidate = item?.name ?? item?.subject_name ?? item?.title;
            const name = typeof nameCandidate === 'string' ? nameCandidate.trim() : '';

            if (!Number.isFinite(id) || name === '') return null;

            return {
              id,
              name,
              semester_id: toNumberOrNull(item?.semester_id),
              semester: toNumberOrNull(item?.semester),
              academic_year: toNumberOrNull(item?.academic_year),
            } as SubjectOption;
          })
          .filter((item: SubjectOption | null): item is SubjectOption => item !== null);

        setSubjects(nextSubjects);
        return;
      } catch {
        // try next client
      }
    }

    setSubjects([]);
  };

  const loadSummary = async (silent = false) => {
    if (!silent) {
      setLoading(true);
    }
    setError(null);

    try {
      const res = await api.get<GoalSummary>('/goals/summary', {
        params: {
          subject_id: selectedSubject ?? undefined,
          semester_id: selectedSubject ? undefined : selectedSemesterOption?.key !== 'all'
            ? Number(String(selectedSemesterOption?.key ?? '').replace('id:', '')) || undefined
            : undefined,
        },
      });
      const nextSummary = res.data;
      const nextStatus = nextSummary.today.quest.status;

      if (previousQuestStatusRef.current && previousQuestStatusRef.current !== 'completed' && nextStatus === 'completed') {
        setCelebrating(true);
        window.setTimeout(() => setCelebrating(false), 2600);
      }

      previousQuestStatusRef.current = nextStatus;
      setSummary(nextSummary);
      setTargetInputs({
        today: String(nextSummary.today.goal.target_quiz_sets || ''),
        week: String(nextSummary.week.goal.target_quiz_sets || ''),
        month: String(nextSummary.month.goal.target_quiz_sets || ''),
      });
    } catch (err: any) {
      setError(err.response?.data?.message ?? 'โหลดภารกิจไม่สำเร็จ');
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    void loadSubjects();
  }, []);

  useEffect(() => {
    void loadSummary();

    const intervalId = window.setInterval(() => {
      void loadSummary(true);
    }, 30000);

    const onFocus = () => {
      void loadSummary(true);
    };

    window.addEventListener('focus', onFocus);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', onFocus);
    };
  }, [selectedSubject, selectedSemesterKey]);

  useEffect(() => {
    if (selectedSubject && filteredSubjects.some(subject => subject.id === selectedSubject)) {
      return;
    }
    setSelectedSubject(filteredSubjects[0]?.id ?? null);
  }, [filteredSubjects, selectedSubject]);

  const saveTarget = async (periodType: PeriodKey) => {
    const rawValue = targetInputs[periodType]?.trim();
    const targetQuizSets = Number(rawValue);

    if (!rawValue || !Number.isFinite(targetQuizSets) || targetQuizSets < 1) {
      setError('กรุณาระบุจำนวนแบบทดสอบอย่างน้อย 1 ชุด');
      return;
    }

    try {
      setSavingTarget(periodType);
      setError(null);
      const res = await api.post('/goals/targets', {
        period_type: periodType === 'today' ? 'daily' : periodType === 'week' ? 'weekly' : 'monthly',
        target_quiz_sets: targetQuizSets,
        subject_id: selectedSubject ?? undefined,
        semester_id: selectedSubject ? undefined : selectedSemesterOption?.key !== 'all'
          ? Number(String(selectedSemesterOption?.key ?? '').replace('id:', '')) || undefined
          : undefined,
      });
      // Use server response to update UI canonical state
      const savedGoal = res.data?.goal ?? null;
      const serverValue = savedGoal ? Number(savedGoal.target_quiz_sets ?? savedGoal.target_sessions ?? targetQuizSets) : targetQuizSets;

      setSummary(prev => {
        if (!prev) return prev;
        return {
          today: periodType === 'today'
            ? { ...prev.today, goal: { ...prev.today.goal, target_quiz_sets: serverValue }, quest: { ...prev.today.quest, target_value: serverValue } }
            : prev.today,
          week: periodType === 'week'
            ? { ...prev.week, goal: { ...prev.week.goal, target_quiz_sets: serverValue }, quest: { ...prev.week.quest, target_value: serverValue } }
            : prev.week,
          month: periodType === 'month'
            ? { ...prev.month, goal: { ...prev.month.goal, target_quiz_sets: serverValue }, quest: { ...prev.month.quest, target_value: serverValue } }
            : prev.month,
        } as GoalSummary;
      });

      setTargetInputs(prev => ({ ...prev, [periodType]: String(serverValue) }));
    } catch (err: any) {
      setError(err.response?.data?.message ?? 'บันทึกเป้าหมายแบบทดสอบไม่สำเร็จ');
    } finally {
      setSavingTarget(null);
    }
  };

  const sections = summary
    ? [
        { card: periodCards[0], data: summary.today },
        { card: periodCards[1], data: summary.week },
        { card: periodCards[2], data: summary.month },
      ]
    : [];

  return (
    <div className="relative mx-auto max-w-3xl overflow-hidden pb-16 text-[color:var(--text)]">
      {celebrating ? (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 overflow-hidden">
          <div className="mx-auto flex max-w-4xl justify-center gap-3 py-4">
            {Array.from({ length: 18 }).map((_, index) => (
              <span
                key={index}
                className="h-3 w-3 animate-bounce rounded-full"
                style={{
                  backgroundColor: ['#14b8a6', '#3b82f6', '#8b5cf6', '#d946ef'][index % 4],
                  animationDelay: `${index * 70}ms`,
                }}
              />
            ))}
          </div>
        </div>
      ) : null}

      <div className="pointer-events-none absolute right-0 top-0 h-72 w-72 rounded-full bg-teal-100/50 blur-3xl" />
      <div className="pointer-events-none absolute -left-16 bottom-12 h-72 w-72 rounded-full bg-violet-100/40 blur-3xl" />

      <section className="relative z-10 text-center">
        <h1 className="text-[22px] font-semibold tracking-wide text-slate-700">ภารกิจของฉัน</h1>
      </section>

      <div className="relative z-10 mt-8 space-y-8">
        <section className="rounded-[20px] border border-slate-100 bg-white p-5 shadow-[0_4px_20px_-4px_rgba(0,0,0,0.03)]">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-slate-600">เทอม</span>
              <select
                value={selectedSemesterKey}
                onChange={event => setSelectedSemesterKey(event.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-200"
              >
                {semesterOptions.map(option => (
                  <option key={option.key} value={option.key}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-2 block text-sm font-medium text-slate-600">วิชา</span>
              <select
                value={selectedSubject ?? ''}
                onChange={event => setSelectedSubject(event.target.value ? Number(event.target.value) : null)}
                className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-200"
              >
                {filteredSubjects.length === 0 ? <option value="">ยังไม่มีวิชา</option> : null}
                {filteredSubjects.map(subject => (
                  <option key={subject.id} value={subject.id}>
                    {subject.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>

        {loading ? <p className="text-sm text-muted">กำลังโหลดภารกิจ...</p> : null}
        {error ? <p className="rounded-2xl border border-rose-500/20 bg-rose-500/8 px-4 py-3 text-sm text-rose-500">{error}</p> : null}

        {summary ? (
          <>
            {sections.map(({ card, data }) => {
              const theme = sectionThemes[card.key];
              const completedQuizSets = data.goal.current_quiz_sets;
              const inputTargetQuizSets = Number(targetInputs[card.key] || 0);
              const targetQuizSets = data.goal.target_quiz_sets > 0 ? data.goal.target_quiz_sets : inputTargetQuizSets;
              const hasTarget = targetQuizSets > 0;
              const isCompleted =
                data.quest.status === 'completed' || (hasTarget && completedQuizSets >= targetQuizSets);
              const canAct = !isCompleted && data.quest.status !== 'failed' && hasTarget;
              const resetLabel =
                card.key === 'today' ? 'รีเซ็ตเที่ยงคืน' : card.key === 'week' ? 'รีเซ็ตวันอาทิตย์' : 'รีเซ็ตสิ้นเดือน';
              const computedProgressPercent = hasTarget
                ? Math.round((completedQuizSets / targetQuizSets) * 100)
                : data.quest.progress_percent;
              const progressWidth = completedQuizSets > 0
                ? Math.max(8, Math.min(100, computedProgressPercent))
                : Math.max(0, Math.min(100, computedProgressPercent));
              const actionLabel = data.quest.current_value > 0 ? 'ไปทำภารกิจต่อ' : 'ไปทำภารกิจ';

              return (
                <section key={card.key}>
                  <div className="mb-5 flex items-center justify-between px-1">
                    <h2 className="flex items-center gap-3 text-xl font-bold text-slate-800">
                      <span className={`h-6 w-1.5 rounded-full ${theme.sectionBar}`} />
                      {card.label}
                    </h2>
                    <button type="button" className="flex items-center gap-1.5 text-[13px] font-medium text-slate-400 transition-colors hover:text-slate-600">
                      <GoalsIcon name="refresh" className="h-3.5 w-3.5" />
                      {resetLabel}
                    </button>
                  </div>

                  <div className={`group rounded-[20px] border p-5 transition-all duration-300 hover:-translate-y-[2px] hover:shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05)] ${isCompleted ? 'border-slate-100 bg-white/60 opacity-75' : `bg-white shadow-[0_4px_20px_-4px_rgba(0,0,0,0.03)] ${theme.outline}`}`}>
                    <div className="flex flex-col justify-between gap-6 md:flex-row md:items-center">
                      <div className="flex flex-1 items-center gap-5">
                        <div className={`flex h-[60px] w-[60px] shrink-0 items-center justify-center rounded-2xl border ${isCompleted ? 'border-slate-100 bg-slate-50 text-slate-400' : `${theme.iconWrap} border-current/10`}`}>
                          <GoalsIcon name={isCompleted ? 'check' : theme.icon} className="h-7 w-7" />
                        </div>

                        <div className="min-w-0">
                          <div className="mb-1 flex flex-wrap items-center gap-2">
                            <h3 className={`text-[16px] font-semibold ${isCompleted ? 'text-slate-600' : 'text-slate-800'}`}>
                              {data.quest.title}
                            </h3>
                          </div>
                          <p className={`text-[13.5px] leading-relaxed ${isCompleted ? 'text-slate-400' : 'text-slate-500'} ${isCompleted ? '' : 'mb-2.5'}`}>
                            {hasTarget
                              ? selectedSubjectOption
                                ? `วิชา ${selectedSubjectOption.name} ทำแบบทดสอบแล้ว ${completedQuizSets} ชุด จากเป้าหมาย ${targetQuizSets} ชุด`
                                : `ทำแบบทดสอบแล้ว ${completedQuizSets} ชุด จากเป้าหมาย ${targetQuizSets} ชุด`
                              : 'ยังไม่ได้ตั้งเป้าหมายแบบทดสอบสำหรับช่วงเวลานี้'}
                          </p>
                          <div className="flex flex-wrap items-center gap-2">
                            <label className="text-[12px] font-medium text-slate-500">ตั้งเป้าสำเร็จที่</label>
                            <input
                              type="number"
                              min={1}
                              inputMode="numeric"
                              value={targetInputs[card.key]}
                              onChange={event => setTargetInputs(prev => ({ ...prev, [card.key]: event.target.value }))}
                              ref={el => (inputRefs.current[card.key] = el)}
                              className="w-20 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-200"
                            />
                            <span className="text-[12px] text-slate-500">ชุด</span>
                            <button
                              type="button"
                              onClick={() => void saveTarget(card.key)}
                              disabled={savingTarget === card.key}
                              className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-[12px] font-medium text-blue-600 transition hover:bg-blue-100 disabled:opacity-60"
                            >
                              {savingTarget === card.key ? 'กำลังบันทึก...' : 'บันทึกเป้า'}
                            </button>
                          </div>
                        </div>
                      </div>

                      <div className={`w-full md:shrink-0 ${isCompleted ? 'sm:w-64 md:w-64' : 'sm:w-56 md:w-64'} ${isCompleted ? '' : 'mt-2 border-t border-slate-100 pt-4 md:mt-0 md:border-l md:border-t-0 md:pl-6 md:pt-0'}`}>
                        {isCompleted ? (
                          <div className="flex items-center justify-between sm:justify-end">
                            <div className="flex items-center gap-2 rounded-xl border border-emerald-100/50 bg-emerald-50 px-4 py-2 text-[14px] font-medium text-emerald-600">
                              <GoalsIcon name="check" className="h-4 w-4" />
                              บรรลุเป้าหมาย
                            </div>
                          </div>
                        ) : (
                          <div className="flex flex-col items-end gap-3">
                            <div className="w-full">
                              <div className={`mb-2 text-[13px] font-medium ${card.key === 'today' ? 'flex justify-end' : 'flex items-center justify-between gap-3'}`}>
                                {card.key === 'today' ? null : <span className="min-w-0 text-slate-400">ความคืบหน้า</span>}
                                <span className={`shrink-0 whitespace-nowrap text-right tabular-nums ${theme.progressText}`}>
                                  {completedQuizSets}/{hasTarget ? targetQuizSets : 0}
                                </span>
                              </div>
                              <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                                <div
                                  className={`h-full rounded-full bg-gradient-to-r ${card.tint}`}
                                  style={{
                                    width: `${progressWidth}%`,
                                    backgroundImage:
                                      card.key === 'week'
                                        ? 'linear-gradient(45deg, rgba(255,255,255,0.15) 25%, transparent 25%, transparent 50%, rgba(255,255,255,0.15) 50%, rgba(255,255,255,0.15) 75%, transparent 75%, transparent), linear-gradient(to right, rgb(139 92 246), rgb(124 58 237))'
                                        : undefined,
                                    backgroundSize: card.key === 'week' ? '1rem 1rem, auto' : undefined,
                                  }}
                                />
                              </div>
                            </div>

                            {canAct ? (
                              <button
                                type="button"
                                onClick={() => navigate(data.quest.cta_path)}
                                className={`w-full whitespace-nowrap rounded-xl px-7 py-2.5 text-[14px] font-medium transition-all active:scale-95 sm:w-auto ${theme.button}`}
                              >
                                {actionLabel}
                              </button>
                            ) : (
                              data.quest.status === 'failed' ? (
                                <button
                                  type="button"
                                  disabled
                                  className={`w-full whitespace-nowrap rounded-xl px-6 py-2.5 text-[14px] font-medium sm:w-auto ${theme.button}`}
                                >
                                  ภารกิจหมดเวลา
                                </button>
                              ) : hasTarget ? (
                                <button
                                  type="button"
                                  disabled
                                  className={`w-full whitespace-nowrap rounded-xl px-6 py-2.5 text-[14px] font-medium sm:w-auto ${theme.button}`}
                                >
                                  {`เป้าหมาย ${targetQuizSets} ชุด`}
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => inputRefs.current[card.key]?.focus()}
                                  className={`w-full whitespace-nowrap rounded-xl px-6 py-2.5 text-[14px] font-medium sm:w-auto ${theme.button}`}
                                >
                                  ตั้งเป้าหมายก่อน
                                </button>
                              )
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </section>
              );
            })}
          </>
        ) : null}
      </div>
    </div>
  );
};
