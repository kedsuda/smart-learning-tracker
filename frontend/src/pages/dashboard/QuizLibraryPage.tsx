import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api, apiFallbackClients } from '../../services/api';
import { useAppAlert } from '../../context/AppAlertContext';
import { useAuth } from '../../context/AuthContext';
import { useSemesterOptions } from '../../hooks/useSemesterOptions';
import { filterBySemester, toNumberOrNull } from '../../utils/semester';
import { subscribeSubjectsUpdated } from '../../utils/subjectSync';

interface SubjectOption {
  id: number;
  name: string;
  semester_id?: number | null;
  semester?: number | null;
  academic_year?: number | null;
}

interface QuizQuestion {
  id: number;
  question_text: string;
  question_type: string;
  options?: string[];
  correct_answer?: string | null;
  explanation?: string | null;
}

interface Quiz {
  id: number;
  title: string;
  description?: string | null;
  subject_id: number;
  questions?: QuizQuestion[];
  latest_attempt?: {
    score: number;
    total: number;
    percentage: number;
    answered_at: string;
  } | null;
}

const allowedTypes = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain'
];

const allowedExtensions = ['pdf', 'doc', 'docx', 'txt'];

const isAllowedFile = (file: File) => {
  if (allowedTypes.includes(file.type)) return true;
  const ext = file.name.split('.').pop()?.toLowerCase();
  return !!ext && allowedExtensions.includes(ext);
};

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

const unwrapCollection = (payload: any) => {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.data)) return payload.data.data;
  if (Array.isArray(payload?.subjects)) return payload.subjects;
  if (Array.isArray(payload?.result)) return payload.result;
  return [];
};

const toSubjectOption = (item: any): SubjectOption | null => {
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
  };
};

const normalizeSubjects = (payload: any): SubjectOption[] => {
  const rows = unwrapCollection(payload);
  if (!Array.isArray(rows)) return [];
  const seen = new Set<number>();
  const normalized: SubjectOption[] = [];

  rows.forEach((item: any) => {
    const mapped = toSubjectOption(item);
    if (!mapped || seen.has(mapped.id)) return;
    seen.add(mapped.id);
    normalized.push(mapped);
  });

  return normalized;
};

const stripTrailingEllipsis = (value?: string | null) => {
  if (typeof value !== 'string') return '';
  return value.replace(/\s*\.\.\.\s*$/, '').trimEnd();
};

export const QuizLibraryPage = () => {
  const { success, error: showError } = useAppAlert();
  const { user } = useAuth();
  const [subjects, setSubjects] = useState<SubjectOption[]>([]);
  const [selectedSemesterKey, setSelectedSemesterKey] = useState('all');
  const [quizzes, setQuizzes] = useState<Quiz[]>([]);
  const [selectedSubject, setSelectedSubject] = useState<number | null>(null);
  const [fileTitle, setFileTitle] = useState('');
  const [fileDifficulty, setFileDifficulty] = useState<'easy' | 'medium' | 'hard'>('medium');
  const [fileQuestionCount, setFileQuestionCount] = useState(5);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileStatus, setFileStatus] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [isFileSubmitting, setIsFileSubmitting] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewQuiz, setPreviewQuiz] = useState<Quiz | null>(null);
  const [deletingQuizId, setDeletingQuizId] = useState<number | null>(null);
  const semesterOptions = useSemesterOptions();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const fileInfo = useMemo(() => {
    if (!selectedFile) return null;
    return `${selectedFile.name} · ${formatFileSize(selectedFile.size)}`;
  }, [selectedFile]);
  const subjectNameMap = useMemo(
    () => new Map(subjects.map(subject => [subject.id, subject.name])),
    [subjects]
  );
  const filteredSubjects = useMemo(() => filterBySemester(subjects, selectedSemesterKey), [subjects, selectedSemesterKey]);
  const attemptedQuizCount = useMemo(
    () => quizzes.filter(quiz => Boolean(quiz.latest_attempt)).length,
    [quizzes]
  );
  const averageScore = useMemo(() => {
    const attempts = quizzes
      .map(quiz => quiz.latest_attempt?.percentage)
      .filter((value): value is number => Number.isFinite(value));
    if (attempts.length === 0) return null;
    return Math.round(attempts.reduce((sum, value) => sum + value, 0) / attempts.length);
  }, [quizzes]);
  const selectedSubjectName = useMemo(
    () => (selectedSubject ? subjectNameMap.get(selectedSubject) ?? 'ยังไม่ได้เลือกวิชา' : 'ยังไม่ได้เลือกวิชา'),
    [selectedSubject, subjectNameMap]
  );
  const hasSubjects = filteredSubjects.length > 0;

  const fetchSubjects = async (cancelledRef?: { current: boolean }) => {
    const requestConfigs =
      user?.role === 'admin'
        ? [{ params: { include_all: 1 } }, undefined]
        : [undefined];

    for (const client of apiFallbackClients) {
      for (const config of requestConfigs) {
        try {
          const res = await client.get('/subjects', config);
          const list = normalizeSubjects(res.data);

          if (cancelledRef?.current) return;

          setSubjects(list);
          setSelectedSubject(prev => {
            if (prev && list.some(subject => subject.id === prev)) return prev;
            return list[0]?.id ?? null;
          });
          return;
        } catch {
          // try next config / client
        }
      }
    }

    if (!cancelledRef?.current) {
      setSubjects([]);
      setSelectedSubject(null);
    }
  };

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
  }, []);

  useEffect(() => {
    if (!selectedSubject && filteredSubjects[0]) {
      setSelectedSubject(filteredSubjects[0].id);
    }
  }, [filteredSubjects, selectedSubject]);

  useEffect(() => {
    if (selectedSubject && filteredSubjects.some(subject => subject.id === selectedSubject)) return;
    const fallback = filteredSubjects[0];
    setSelectedSubject(fallback ? fallback.id : null);
  }, [filteredSubjects, selectedSubject]);

  useEffect(() => {
    if (!selectedSubject) return;
    api.get(`/subjects/${selectedSubject}/quizzes`).then(res => {
      const payload = Array.isArray(res.data) ? res.data : res.data?.data;
      setQuizzes(Array.isArray(payload) ? payload : []);
    });
  }, [selectedSubject]);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!isAllowedFile(file)) {
      setFileError('รองรับเฉพาะไฟล์ PDF, DOC, DOCX หรือ TXT เท่านั้น');
      setFileStatus(null);
      setSelectedFile(null);
      return;
    }
    setSelectedFile(file);
    setFileError(null);
    setFileStatus(`เลือกไฟล์แล้ว: ${file.name}`);
    event.target.value = '';
  };

  const handleFileSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedSubject) {
      setFileError('กรุณาเลือกวิชาที่ต้องการสร้างแบบฝึกหัดจากเอกสาร');
      setFileStatus(null);
      return;
    }
    if (!selectedFile) {
      setFileError('กรุณาเลือกไฟล์เอกสารก่อนสร้างแบบฝึกหัดจากเอกสาร');
      setFileStatus(null);
      return;
    }

    setIsFileSubmitting(true);
    setFileError(null);
    setFileStatus('กำลังอัปโหลดไฟล์และสร้างแบบฝึกหัดจากเอกสาร...');

    const formData = new FormData();
    formData.append('file', selectedFile);
    if (fileTitle.trim()) {
      formData.append('title', fileTitle.trim());
    }
    formData.append('difficulty', fileDifficulty);
    formData.append('question_count', String(fileQuestionCount));

    try {
      const response = await api.post<Quiz>(`/subjects/${selectedSubject}/quizzes/from-file`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      setFileStatus('สร้างแบบฝึกหัดจากเอกสารเรียบร้อยแล้ว');
      setSelectedFile(null);
      setFileTitle('');
      if (selectedSubject === response.data.subject_id) {
        setQuizzes(prev => [response.data, ...prev]);
      }
    } catch (error) {
      setFileError(extractErrorMessage(error, 'ไม่สามารถสร้างแบบฝึกหัดจากเอกสารได้'));
      setFileStatus(null);
    } finally {
      setIsFileSubmitting(false);
    }
  };

  const openPreview = async (quizId: number) => {
    setPreviewOpen(true);
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const res = await api.get(`/quizzes/${quizId}`);
      const payload = res.data?.data ?? res.data;
      setPreviewQuiz(payload ?? null);
    } catch (error) {
      setPreviewError(extractErrorMessage(error, 'ไม่สามารถโหลดแบบฝึกหัดจากเอกสารได้'));
      setPreviewQuiz(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  const deleteQuiz = async (quiz: Quiz) => {
    const confirmed = window.confirm(`ต้องการลบแบบฝึกหัด "${quiz.title}" ใช่หรือไม่?`);
    if (!confirmed) return;

    setDeletingQuizId(quiz.id);
    setPreviewError(null);
    try {
      await api.delete(`/quizzes/${quiz.id}`);
      setQuizzes(prev => prev.filter(item => item.id !== quiz.id));
      if (previewQuiz?.id === quiz.id) {
        setPreviewQuiz(null);
        setPreviewOpen(false);
      }
      success('ลบแบบฝึกหัดเรียบร้อยแล้ว');
    } catch (error) {
      showError(extractErrorMessage(error, 'ลบแบบฝึกหัดไม่สำเร็จ'));
    } finally {
      setDeletingQuizId(null);
    }
  };

  const handlePrintQuiz = () => {
    if (!previewQuiz) return;
    window.print();
  };

  return (
    <div>
      <div className="hidden print:block">
        <h1 className="text-2xl font-semibold">{previewQuiz?.title ?? 'แบบฝึกหัด'}</h1>
        {previewQuiz?.description ? <p className="mt-2 text-sm">{previewQuiz.description}</p> : null}
        <ol className="mt-6 space-y-6 text-sm">
          {(previewQuiz?.questions ?? []).map((question, index) => (
            <li key={question.id} className="space-y-3">
              <p className="font-semibold">{index + 1}. {question.question_text}</p>
              {question.question_type === 'multiple_choice' && (
                <div className="space-y-2">
                  {(question.options ?? []).map(option => (
                    <div key={option} className="flex items-start gap-2">
                      <span className="mt-1 inline-block h-3 w-3 shrink-0 rounded border border-slate-400"></span>
                      <span className="min-w-0 whitespace-pre-wrap break-words">{option}</span>
                    </div>
                  ))}
                </div>
              )}
              {question.question_type === 'true_false' && (
                <div className="flex items-center gap-6">
                  <div className="flex items-center gap-2">
                    <span className="inline-block h-3 w-3 rounded border border-slate-400"></span>
                    <span>ถูก</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="inline-block h-3 w-3 rounded border border-slate-400"></span>
                    <span>ผิด</span>
                  </div>
                </div>
              )}
              {question.question_type === 'short_answer' && (
                <div className="space-y-2">
                  <div className="border-b border-slate-300 pb-6"></div>
                  <div className="border-b border-slate-300 pb-6"></div>
                </div>
              )}
            </li>
          ))}
        </ol>
      </div>

      <div className="quiz-library-page px-4 pb-10 pt-4 print:hidden sm:px-0 sm:pt-0 lg:pb-0">
        <div className="mx-auto w-full max-w-6xl space-y-6">
          <section className="quiz-hero quiz-fade-in rounded-[1.75rem] p-5 shadow-soft md:p-6">
            <div className="grid gap-4 lg:grid-cols-[1.25fr,0.9fr] lg:items-end">
              <div className="space-y-3">
                <span className="quiz-hero__label">Practice Studio</span>
                <div className="space-y-2">
                  <h2 className="text-2xl font-bold leading-tight tracking-[-0.03em] md:text-4xl">
                    แบบฝึกหัดจากเอกสารที่พร้อมทำทันที
                  </h2>
           
                </div>
                <div className="flex flex-wrap gap-2 text-xs text-muted md:text-sm">
                  <span className="quiz-hero__chip">วิชาที่เลือก: {selectedSubjectName}</span>
                  <span className="quiz-hero__chip">แบบฝึกหัดจากเอกสารทั้งหมด {quizzes.length} ชุด</span>
                </div>
              </div>
              <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
                <div className="quiz-stat p-3 md:p-4">
                  <p className="text-xs uppercase tracking-[0.2em] text-muted">วิชาที่พร้อมใช้</p>
                  <p className="mt-1.5 text-2xl font-bold text-[color:var(--text)]">{filteredSubjects.length}</p>
                </div>
                <div className="quiz-stat p-3 md:p-4">
                  <p className="text-xs uppercase tracking-[0.2em] text-muted">เคยทำแล้ว</p>
                  <p className="mt-1.5 text-2xl font-bold text-[color:var(--text)]">{attemptedQuizCount}</p>
                </div>
                <div className="quiz-stat p-3 md:p-4">
                  <p className="text-xs uppercase tracking-[0.2em] text-muted">คะแนนเฉลี่ย</p>
                  <p className="mt-1.5 text-2xl font-bold text-[color:var(--text)]">{averageScore !== null ? `${averageScore}%` : '-'}</p>
                </div>
              </div>
            </div>
          </section>

          <div className="grid gap-6">
            <section className="quiz-fade-in-delayed">
              <form onSubmit={handleFileSubmit} className="space-y-6">
                <div className="grid gap-6 lg:grid-cols-2 lg:items-stretch">
                  <div className="quiz-card rounded-[2.25rem] p-6 md:p-8">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h3 className="text-2xl font-bold tracking-[-0.03em] text-[color:var(--text)]">ตั้งค่าแบบฝึกหัด</h3>
                        <p className="mt-1 text-sm text-muted">กำหนดรายละเอียดเพื่อให้ AI สร้างคำถามที่ตรงจุด</p>
                      </div>
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-[color:var(--border)] bg-[color:rgba(var(--accent-rgb),0.08)] text-accent shadow-sm">
                        <SlidersHorizontal className="h-6 w-6" strokeWidth={2} aria-hidden="true" />
                      </div>
                    </div>

                    <div className="mt-6 grid gap-5">
                      <div className="grid gap-4 md:grid-cols-2">
                        <div>
                          <label className="mb-1.5 block text-sm font-semibold text-muted">ภาคเรียน</label>
                          <select
                            className="w-full rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-2)] px-4 py-3 text-sm text-[color:var(--text)] shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
                            value={selectedSemesterKey}
                            onChange={event => setSelectedSemesterKey(event.target.value)}
                          >
                            {semesterOptions.map(option => (
                              <option key={option.key} value={option.key}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div>
                          <label className="mb-1.5 block text-sm font-semibold text-muted">รายวิชา</label>
                          <select
                            className="w-full rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-2)] px-4 py-3 text-sm text-[color:var(--text)] shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
                            value={selectedSubject ?? ''}
                            onChange={event => setSelectedSubject(Number(event.target.value))}
                            disabled={!hasSubjects}
                          >
                            {!hasSubjects ? <option value="">ไม่พบรายวิชา</option> : null}
                            {filteredSubjects.map(subject => (
                              <option key={subject.id} value={subject.id}>
                                {subject.name}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div>
                        <label className="mb-1.5 block text-sm font-semibold text-muted">ชื่อแบบฝึกหัด (ทางเลือก)</label>
                        <input
                          className="w-full rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-2)] px-4 py-3 text-sm text-[color:var(--text)] shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
                          value={fileTitle}
                          onChange={event => setFileTitle(event.target.value)}
                          placeholder="เช่น สรุปเนื้อหาก่อนสอบ Midterm บทที่ 1-3"
                        />
                      </div>

                      <div className="grid gap-4 md:grid-cols-2">
                        <div>
                          <label className="mb-1.5 block text-sm font-semibold text-muted">ระดับความยาก</label>
                          <div className="grid w-full grid-cols-3 items-center gap-1 rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-2)] p-1 shadow-sm">
                            {(
                              [
                                { value: 'easy' as const, label: 'ง่าย' },
                                { value: 'medium' as const, label: 'ปานกลาง' },
                                { value: 'hard' as const, label: 'ยาก' }
                              ] as const
                            ).map(option => {
                              const isActive = fileDifficulty === option.value;
                              return (
                                <button
                                  key={option.value}
                                  type="button"
                                  onClick={() => setFileDifficulty(option.value)}
                                  className={`min-w-0 w-full rounded-xl px-2 py-2 text-center text-xs font-semibold leading-none transition sm:px-3 sm:py-2.5 sm:text-sm ${
                                    isActive
                                      ? 'bg-[color:rgba(var(--accent-rgb),0.10)] text-accent shadow-sm'
                                      : 'text-muted hover:bg-[color:var(--surface)] hover:text-[color:var(--text)]'
                                  }`}
                                  aria-pressed={isActive}
                                >
                                  {option.label}
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        <div>
                          <label className="mb-1.5 block text-sm font-semibold text-muted">จำนวนข้อ</label>
                          <input
                            type="number"
                            min={3}
                            max={50}
                            className="w-full rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-2)] px-4 py-3 text-center text-sm font-semibold text-[color:var(--text)] shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
                            value={fileQuestionCount}
                            onChange={event => setFileQuestionCount(Number(event.target.value))}
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="quiz-card rounded-[2.25rem] p-4 md:p-6">
                    <div className="h-full rounded-[2rem] border-2 border-dashed p-6 md:p-8" style={{ borderColor: 'rgba(var(--accent-rgb),0.35)', background: 'color-mix(in srgb, var(--surface-2) 88%, rgba(var(--accent-rgb),0.08))' }}>
                      <div className="flex h-full flex-col items-center justify-center text-center">
                        <div className="flex h-20 w-20 items-center justify-center rounded-[1.5rem] bg-[color:rgba(var(--accent-rgb),0.10)] text-accent shadow-soft md:h-24 md:w-24 md:rounded-[1.75rem]">
                          <svg viewBox="0 0 24 24" className="h-11 w-11" fill="none" stroke="currentColor" strokeWidth={1.8}>
                            <path
                              d="M8 18h8a4 4 0 1 0-.8-7.9 5 5 0 0 0-9.4 1.5A3.5 3.5 0 0 0 8 18Z"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </div>

                        <h4 className="mt-6 text-3xl font-black tracking-[-0.03em] text-[color:var(--text)] md:mt-7 md:text-4xl">อัปโหลดไฟล์</h4>
                        <p className="mt-3 max-w-sm text-base text-muted">
                          ลากไฟล์มาวาง หรือ{' '}
                          <button
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                            className="font-semibold text-accent underline decoration-[color:rgba(var(--accent-rgb),0.5)] underline-offset-2"
                          >
                            คลิกเพื่อเลือก
                          </button>
                          <br />
                          รองรับรูปแบบ PDF, DOCX
                        </p>

                        <div className="mt-8 flex flex-col items-center gap-2">
                          <button
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                            className="inline-flex w-full max-w-xs items-center justify-center rounded-[1.1rem] px-8 py-3.5 text-lg font-bold text-[color:var(--on-accent)] shadow-[0_16px_30px_rgba(var(--accent-rgb),0.24)] transition hover:-translate-y-0.5 hover:opacity-95 sm:w-auto sm:px-14 sm:text-xl"
                            style={{
                              background: 'var(--accent)',
                              border: '1px solid color-mix(in srgb, var(--accent) 70%, var(--border))'
                            }}
                          >
                            เลือกไฟล์
                          </button>
                          <input
                            ref={fileInputRef}
                            type="file"
                            accept=".pdf,.doc,.docx,.txt"
                            className="hidden"
                            onChange={handleFileChange}
                          />
                          <p className="mt-1 text-xs text-muted">ระบบจะวิเคราะห์เนื้อหาก่อนสร้างคำถามอัตโนมัติ</p>
                          {fileInfo ? (
                            <p className="mt-2 rounded-full border border-[color:var(--border)] bg-[color:var(--surface)] px-4 py-2 text-xs font-semibold text-[color:var(--text)]">
                              {fileInfo}
                            </p>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {fileStatus ? (
                  <div className="rounded-2xl border border-primary/20 bg-primary/10 p-4 text-sm text-primary">
                    {fileStatus}
                  </div>
                ) : null}

                {fileError ? (
                  <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-500">
                    {fileError}
                  </div>
                ) : null}

                <button
                  type="submit"
                  disabled={isFileSubmitting}
                  className="mb-2 inline-flex w-full items-center justify-center gap-3 rounded-[1.5rem] bg-[color:var(--accent)] px-8 py-4 text-base font-semibold text-[color:var(--on-accent)] shadow-[0_18px_40px_rgba(var(--accent-rgb),0.22)] transition hover:-translate-y-0.5 hover:shadow-glow disabled:cursor-not-allowed disabled:opacity-70 sm:mb-0"
                >
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path d="M12 2l1.6 6.2L20 10l-6.4 1.8L12 18l-1.6-6.2L4 10l6.4-1.8L12 2Z" strokeLinejoin="round" />
                    <path d="M19 15l.9 3.5L23 20l-3.1.9L19 24l-.9-3.1L15 20l3.1-1.5L19 15Z" strokeLinejoin="round" />
                  </svg>
                  <span>{isFileSubmitting ? 'กำลังสร้าง...' : 'สร้างแบบฝึกหัดทันที'}</span>
                </button>
              </form>
            </section>
          </div>

          <section className="space-y-4 quiz-fade-in-delayed-2" id="quiz-list">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-2xl font-bold text-[color:var(--text)]">แบบฝึกหัดล่าสุด</h3>
           
              </div>
              <div className="flex items-center gap-2">
            <select
              className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-2)] px-4 py-2.5 text-sm text-[color:var(--text)] shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
              value={selectedSubject ?? ''}
              onChange={event => setSelectedSubject(Number(event.target.value))}
              disabled={!hasSubjects}
            >
              {!hasSubjects ? <option value="">ไม่พบรายวิชา</option> : null}
              {filteredSubjects.map(subject => (
                <option key={subject.id} value={subject.id}>
                  {subject.name}
                </option>
              ))}
            </select>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
          {quizzes.map(quiz => (
            <article key={quiz.id} className="quiz-card rounded-[2rem] p-6 transition hover:-translate-y-1 hover:shadow-glow">
              <header>
                <p className="text-xs font-medium uppercase tracking-[0.3em] text-primary/60">
                  {subjectNameMap.get(quiz.subject_id) ?? `วิชา ${quiz.subject_id}`}
                </p>
                <h4 className="mt-2 text-lg font-semibold text-[color:var(--text)]">{quiz.title}</h4>
                <p className="mt-1 text-sm text-muted">{quiz.description ?? 'ไม่มีคำอธิบาย'}</p>
              </header>
              {quiz.latest_attempt ? (
                <div className="mt-4 flex items-center justify-between rounded-2xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-primary">
                  <span>คะแนนล่าสุด: {quiz.latest_attempt.score} / {quiz.latest_attempt.total}</span>
                  <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold">
                    {quiz.latest_attempt.percentage}%
                  </span>
                </div>
              ) : (
                <p className="mt-4 rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-2)] px-4 py-3 text-sm text-muted">ยังไม่ได้ทำแบบฝึกหัดนี้</p>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => openPreview(quiz.id)}
                  className="quiz-outline-btn inline-flex w-fit items-center text-sm"
                >
                  <span>ดูแบบฝึกหัดจากเอกสาร</span>
                </button>
                <Link
                  to={`/quizzes/${quiz.id}`}
                  className="inline-flex w-fit items-center space-x-2 rounded-full bg-[color:var(--accent)] px-4 py-2 text-sm font-medium text-[color:var(--on-accent)] shadow-soft transition hover:-translate-y-0.5 hover:shadow-glow"
                >
                  <span>ทำแบบฝึกหัด</span>
                </Link>
                <button
                  type="button"
                  onClick={() => void deleteQuiz(quiz)}
                  disabled={deletingQuizId === quiz.id}
                  className="inline-flex w-fit items-center rounded-full border border-rose-400/30 bg-rose-400/10 px-4 py-2 text-sm font-medium text-rose-300 transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <span>{deletingQuizId === quiz.id ? 'กำลังลบ...' : 'ลบ'}</span>
                </button>
              </div>
            </article>
          ))}
          {quizzes.length === 0 && (
            <article className="quiz-card md:col-span-2 rounded-[2rem] p-12 text-center">
              <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-[color:rgba(var(--accent-rgb),0.12)] text-accent">
                <svg viewBox="0 0 24 24" className="h-9 w-9" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M8 3h6l5 5v11a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M14 3v5h5" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M9 13h6" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M9 17h4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <h4 className="mt-5 text-2xl font-bold text-[color:var(--text)]">ยังไม่มีแบบฝึกหัดล่าสุด</h4>
        
            </article>
          )}
            </div>
          </section>
        </div>
      </div>
      {previewOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 px-4 pb-8 pt-10 backdrop-blur sm:items-center">
          <div className="w-full max-w-3xl rounded-3xl border border-muted surface p-6 shadow-glow">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-[0.35em] text-primary/70">Quiz Preview</p>
                <h3 className="mt-2 text-2xl font-semibold text-[color:var(--text)]">
                  {previewQuiz?.title ?? 'แบบฝึกหัด'}
                </h3>
                {previewQuiz?.description ? (
                  <p className="mt-1 text-sm text-muted">{previewQuiz.description}</p>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handlePrintQuiz}
                  className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-semibold text-[color:var(--text)] transition hover:bg-white/10"
                >
                  พิมพ์แบบฝึกหัด
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPreviewOpen(false);
                    setPreviewQuiz(null);
                  }}
                  className="rounded-full border border-muted surface-2 px-3 py-1 text-xs font-semibold text-muted hover:text-[color:var(--text)]"
                >
                  ปิด
                </button>
              </div>
            </div>

            <div className="mt-5 max-h-[60vh] space-y-3 overflow-y-auto pr-2 text-sm text-muted">
              {previewLoading ? (
                <div className="rounded-2xl border border-muted surface-2 px-4 py-6 text-center text-sm text-muted">
                  กำลังโหลดแบบฝึกหัดจากเอกสาร...
                </div>
              ) : previewError ? (
                <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-500">
                  {previewError}
                </div>
              ) : previewQuiz?.questions?.length ? (
                previewQuiz.questions.map((question, index) => (
                  <div key={question.id} className="rounded-2xl border border-muted surface-2 px-4 py-4">
                    <p className="text-xs font-medium uppercase tracking-widest text-muted">ข้อที่ {index + 1}</p>
                    <p className="mt-2 whitespace-pre-wrap break-words font-medium text-[color:var(--text)]">
                      {stripTrailingEllipsis(question.question_text)}
                    </p>
                    {question.question_type === 'multiple_choice' && (
                      <div className="mt-3 space-y-2 text-sm text-muted">
                        {(question.options ?? []).map(option => (
                          <div key={option} className="flex items-start gap-2">
                            <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-primary/60"></span>
                            <span className="min-w-0 whitespace-pre-wrap break-words">
                              {stripTrailingEllipsis(option)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {question.question_type === 'true_false' && (
                      <div className="mt-3 flex items-center gap-4 text-sm text-muted">
                        <span>ถูก</span>
                        <span>ผิด</span>
                      </div>
                    )}
                    {question.question_type === 'short_answer' && (
                      <div className="mt-3 rounded-xl border border-dashed border-muted surface px-3 py-3 text-xs text-muted">
                        คำตอบแบบเขียน
                      </div>
                    )}
                    {question.correct_answer ? (
                      <div className="mt-3 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 text-sm text-primary">
                        <p className="text-xs uppercase tracking-widest text-primary/70">คำตอบ</p>
                        <p className="mt-1 whitespace-pre-wrap text-[color:var(--text)]">
                          {stripTrailingEllipsis(question.correct_answer)}
                        </p>
                      </div>
                    ) : null}
                    {question.explanation ? (
                      <div className="mt-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-muted">
                        {stripTrailingEllipsis(question.explanation)}
                      </div>
                    ) : null}
                  </div>
                ))
              ) : (
                <div className="rounded-2xl border border-dashed border-muted surface-2 px-4 py-6 text-center text-sm text-muted">
                  ไม่มีคำถามในแบบฝึกหัดนี้
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
