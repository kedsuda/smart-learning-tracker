import { BookOpen, Calendar, CheckCircle2, LoaderCircle, Mic, Paperclip, Square, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import Swal from 'sweetalert2';
import saveIcon from '../../img/savel.png';
import { api } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { uploadStudyFileToSupabase } from '../../utils/studyFiles';

type SubjectOption = {
  id: number;
  name: string;
};

type StudyLogEntry = {
  id: number;
  title: string;
  note: string;
  log_date: string;
  duration_minutes?: number | null;
  mood?: string | null;
};

type SpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

type BrowserSpeechRecognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: any) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
};

const formatThaiDate = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' });
};

export const StudyCapturePage = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [subjects, setSubjects] = useState<SubjectOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [todayLogs, setTodayLogs] = useState<Array<StudyLogEntry & { subjectName: string; subjectId: number }>>([]);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [voiceInputSupported, setVoiceInputSupported] = useState(false);
  const [activeVoiceField, setActiveVoiceField] = useState<'title' | 'note' | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const speechRecognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const speechRecognitionCtorRef = useRef<SpeechRecognitionConstructor | null>(null);
  const speechTranscriptBaseRef = useRef('');
  const voiceInputSilenceTimerRef = useRef<number | null>(null);
  const [form, setForm] = useState({
    subjectId: '',
    title: '',
    note: '',
    logDate: new Date().toISOString().slice(0, 10),
    durationMinutes: '60',
    mood: ''
  });

  const moodOptions = ['สนุก', 'เข้าใจมากขึ้น', 'ต้องทบทวน', 'ค่อนข้างยาก', 'มั่นใจขึ้น'];
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const clearVoiceInputSilenceTimer = () => {
    if (typeof window === 'undefined' || voiceInputSilenceTimerRef.current === null) return;

    window.clearTimeout(voiceInputSilenceTimerRef.current);
    voiceInputSilenceTimerRef.current = null;
  };

  const stopVoiceInput = () => {
    clearVoiceInputSilenceTimer();

    if (!speechRecognitionRef.current) {
      setActiveVoiceField(null);
      return;
    }

    try {
      speechRecognitionRef.current.stop();
    } catch {
      setActiveVoiceField(null);
      speechRecognitionRef.current = null;
    }
  };

  const scheduleVoiceInputSilenceTimer = () => {
    if (typeof window === 'undefined') return;

    clearVoiceInputSilenceTimer();
    voiceInputSilenceTimerRef.current = window.setTimeout(() => {
      stopVoiceInput();
    }, 3000);
  };

  const startVoiceInput = (field: 'title' | 'note') => {
    if (typeof window === 'undefined' || !speechRecognitionCtorRef.current || saving) return;

    if (activeVoiceField) {
      stopVoiceInput();
    }

    speechTranscriptBaseRef.current = form[field].trim();

    try {
      const recognition = new speechRecognitionCtorRef.current();
      recognition.lang = 'th-TH';
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onresult = event => {
        const transcript = Array.from(event.results ?? [])
          .map((item: any) => item?.[0]?.transcript ?? '')
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();

        const base = speechTranscriptBaseRef.current;
        const nextValue = transcript ? [base, transcript].filter(Boolean).join(base ? ' ' : '') : base;
        setForm(prev => ({ ...prev, [field]: nextValue }));
        scheduleVoiceInputSilenceTimer();
      };
      recognition.onerror = () => {
        clearVoiceInputSilenceTimer();
        setActiveVoiceField(null);
        speechRecognitionRef.current = null;
        setFeedback('ไมโครโฟนไม่พร้อมใช้งานในขณะนี้ ลองใหม่อีกครั้งได้เลย');
      };
      recognition.onend = () => {
        clearVoiceInputSilenceTimer();
        setActiveVoiceField(null);
        speechRecognitionRef.current = null;
      };

      recognition.start();
      speechRecognitionRef.current = recognition;
      setActiveVoiceField(field);
      scheduleVoiceInputSilenceTimer();
    } catch {
      clearVoiceInputSilenceTimer();
      setActiveVoiceField(null);
      speechRecognitionRef.current = null;
      setFeedback('อุปกรณ์หรือเบราว์เซอร์นี้ยังไม่รองรับการพูดเป็นข้อความ');
    }
  };

  const loadData = async () => {
    setLoading(true);
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
      setForm(prev => ({
        ...prev,
        subjectId: prev.subjectId || (nextSubjects[0] ? String(nextSubjects[0].id) : '')
      }));

      const logResponses = await Promise.all(
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

      const nextTodayLogs = logResponses.flatMap(({ subjectName, logs }, index) =>
        logs
          .filter((log: StudyLogEntry) => String(log.log_date).slice(0, 10) === today)
          .map((log: StudyLogEntry) => ({ ...log, subjectName, subjectId: nextSubjects[index].id }))
      );

      nextTodayLogs.sort((a, b) => new Date(b.log_date).getTime() - new Date(a.log_date).getTime());
      setTodayLogs(nextTodayLogs);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, [today]);

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

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form.subjectId || !form.title.trim()) {
      setFeedback('กรุณาเลือกวิชาและกรอกหัวข้อที่เรียนก่อน');
      return;
    }

    setSaving(true);
    setFeedback(null);
    try {
      const logResponse = await api.post(`/subjects/${form.subjectId}/study-logs`, {
        title: form.title.trim(),
        note: form.note.trim(),
        log_date: form.logDate,
        duration_minutes: Number(form.durationMinutes || 0),
        mood: form.mood.trim()
      });

      const logPayload = logResponse.data?.data ?? logResponse.data;
      const logId = Number(logPayload?.id);
      const selectedSubject = subjects.find(subject => String(subject.id) === form.subjectId) ?? null;

      if (Number.isFinite(logId) && selectedFiles.length > 0) {
        const uploadResults = await Promise.allSettled(
          selectedFiles.map(async file => {
            const uploaded = await uploadStudyFileToSupabase({
              file,
              userId: user?.id,
              subject: {
                id: selectedSubject?.id,
                name: selectedSubject?.name,
              },
            });

            await api.post(`/study-logs/${logId}/files`, {
              original_name: file.name,
              storage_path: uploaded.storagePath,
              file_type: uploaded.fileType,
              mime_type: file.type || null,
              file_size: file.size,
            });
          })
        );

        const failedUploads = uploadResults.filter(result => result.status === 'rejected').length;
        if (failedUploads > 0) {
          setFeedback(`บันทึกการเรียนแล้ว แต่มีไฟล์อัปโหลดไม่สำเร็จ ${failedUploads} ไฟล์`);
          await Swal.fire({
            icon: 'warning',
            title: 'บันทึกสำเร็จบางส่วน',
            text: `บันทึกการเรียนเรียบร้อยแล้ว แต่มีไฟล์อัปโหลดไม่สำเร็จ ${failedUploads} ไฟล์`,
            confirmButtonText: 'ตกลง',
          });
        } else {
          setFeedback('บันทึกการเรียนและแนบไฟล์เรียบร้อยแล้ว');
          await Swal.fire({
            icon: 'success',
            title: 'บันทึกสำเร็จ',
            text: 'บันทึกการเรียนและแนบไฟล์เรียบร้อยแล้ว',
            confirmButtonText: 'ตกลง',
          });
        }
      } else {
        setFeedback('บันทึกการเรียนเรียบร้อยแล้ว');
        await Swal.fire({
          icon: 'success',
          title: 'บันทึกสำเร็จ',
          text: 'บันทึกการเรียนเรียบร้อยแล้ว',
          confirmButtonText: 'ตกลง',
        });
      }

      setForm(prev => ({
        ...prev,
        title: '',
        note: '',
        durationMinutes: '60',
        mood: ''
      }));
      setSelectedFiles([]);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      await loadData();
    } catch {
      setFeedback('บันทึกการเรียนไม่สำเร็จ ลองอีกครั้งได้เลย');
      await Swal.fire({
        icon: 'error',
        title: 'บันทึกไม่สำเร็จ',
        text: 'บันทึกการเรียนไม่สำเร็จ ลองอีกครั้งได้เลย',
        confirmButtonText: 'ตกลง',
      });
    } finally {
      setSaving(false);
    }
  };

  const handlePickFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const nextFiles = Array.from(files);
    setSelectedFiles(prev => {
      const merged = [...prev];
      nextFiles.forEach(file => {
        const exists = merged.some(
          item => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified
        );
        if (!exists) merged.push(file);
      });
      return merged;
    });
  };

  const removeSelectedFile = (target: File) => {
    setSelectedFiles(prev =>
      prev.filter(
        file => !(file.name === target.name && file.size === target.size && file.lastModified === target.lastModified)
      )
    );
  };

  return (
    <div className="space-y-5 pb-1 text-[color:var(--text)]" style={{ background: 'var(--bg-gradient)' }}>
      {saving ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/30 backdrop-blur-sm">
          <div className="flex min-w-[220px] flex-col items-center gap-3 rounded-[1.75rem] bg-white px-6 py-7 text-center shadow-[0_24px_60px_rgba(15,23,42,0.18)]">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-sky-50 text-sky-600">
              <LoaderCircle size={28} className="animate-spin" />
            </div>
            <div>
              <p className="text-sm font-bold text-slate-800">กำลังบันทึกการเรียน</p>
              <p className="mt-1 text-xs text-slate-500">โปรดรอสักครู่ ระบบกำลังบันทึกข้อมูลและอัปโหลดไฟล์</p>
            </div>
          </div>
        </div>
      ) : null}

      <section className="rounded-b-[2.15rem] border-b px-5 pb-7 pt-2 sm:px-6" style={{ borderColor: 'var(--border)', background: 'var(--surface)', boxShadow: 'var(--shadow-soft)' }}>
        <button
          type="button"
          onClick={() => navigate('/ai-assistant')}
          className="group mb-5 inline-flex w-fit items-center gap-1.5 rounded-full border px-4 py-2 text-xs font-bold transition"
          style={{ borderColor: 'var(--border)', background: 'var(--surface-2)', color: 'var(--muted)' }}
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          กลับหน้าหลัก
        </button>

        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[0.32em] text-[color:var(--accent-ink)]">Study Log</p>
            <h1 className="mt-1.5 text-[1.8rem] font-bold leading-tight text-[color:var(--text)]">บันทึกการเรียน</h1>
            <p className="mt-2 max-w-lg text-sm leading-6 text-[color:var(--muted)]">จดสิ่งที่เรียนในวันนี้แบบสั้น กระชับ และกลับมาทบทวนได้ง่าย</p>
          </div>
          <img src={saveIcon} alt="บันทึกการเรียน" className="h-8 w-8 shrink-0 object-contain" />
        </div>
      </section>

      <div className="space-y-6 px-5 sm:px-6">
        <section className="rounded-[1.75rem] border p-5 backdrop-blur" style={{ borderColor: 'var(--border)', background: 'color-mix(in srgb, var(--surface) 94%, transparent)', boxShadow: 'var(--shadow-soft)' }}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-bold text-[color:var(--text)]">เพิ่มบันทึกใหม่</h2>
              <p className="mt-1 text-xs text-[color:var(--muted)]">ระบุวิชา หัวข้อ และสรุปสิ่งที่เข้าใจในวันนี้</p>
            </div>
            <span className="rounded-full border px-3 py-1.5 text-[10px] font-bold" style={{ borderColor: 'rgba(var(--accent-rgb),0.24)', background: 'rgba(var(--accent-rgb),0.12)', color: 'var(--accent-ink)' }}>วันนี้</span>
          </div>

          <form onSubmit={handleSubmit} className="mt-5 space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-bold text-[color:var(--text)]">วิชาที่เรียน</label>
              <select
                value={form.subjectId}
                onChange={event => setForm(prev => ({ ...prev, subjectId: event.target.value }))}
                className="w-full rounded-xl border px-4 py-3 text-sm text-[color:var(--text)] outline-none transition focus:border-sky-500"
                style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}
              >
                <option value="">เลือกวิชา</option>
                {subjects.map(subject => (
                  <option key={subject.id} value={subject.id}>
                    {subject.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-bold text-[color:var(--text)]">หัวข้อเนื้อหา</label>
              <div className="relative">
                <input
                  value={form.title}
                  onChange={event => setForm(prev => ({ ...prev, title: event.target.value }))}
                  placeholder="เช่น ทบทวนเรื่องอนุพันธ์ และทำโจทย์ท้ายบท"
                  className="w-full rounded-xl border px-4 py-3 pr-16 text-sm text-[color:var(--text)] outline-none transition focus:border-sky-500"
                  style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}
                />
                <button
                  type="button"
                  onClick={() => {
                    if (activeVoiceField === 'title') {
                      stopVoiceInput();
                    } else {
                      startVoiceInput('title');
                    }
                  }}
                  disabled={!voiceInputSupported || saving}
                  className={`absolute right-4 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center transition disabled:cursor-not-allowed disabled:opacity-50 ${
                    activeVoiceField === 'title'
                      ? 'text-rose-600'
                      : 'text-slate-400 hover:text-sky-600'
                  }`}
                  aria-label={activeVoiceField === 'title' ? 'หยุดพูดหัวข้อเนื้อหา' : 'พูดกรอกหัวข้อเนื้อหา'}
                >
                  {activeVoiceField === 'title' ? <Square size={16} /> : <Mic size={16} />}
                </button>
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-bold text-[color:var(--text)]">สรุป / บันทึกช่วยจำ</label>
              <div className="relative">
                <textarea
                  value={form.note}
                  onChange={event => setForm(prev => ({ ...prev, note: event.target.value }))}
                  placeholder="สรุปว่าวันนี้เรียนเนื้อหาอะไร เข้าใจตรงไหน หรือมีจุดไหนต้องกลับไปทบทวน"
                  className="h-32 w-full rounded-xl border px-4 py-3 pr-16 text-sm leading-6 text-[color:var(--text)] outline-none transition focus:border-sky-500"
                  style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}
                />
                <button
                  type="button"
                  onClick={() => {
                    if (activeVoiceField === 'note') {
                      stopVoiceInput();
                    } else {
                      startVoiceInput('note');
                    }
                  }}
                  disabled={!voiceInputSupported || saving}
                  className={`absolute right-4 top-4 inline-flex h-6 w-6 items-center justify-center transition disabled:cursor-not-allowed disabled:opacity-50 ${
                    activeVoiceField === 'note'
                      ? 'text-rose-600'
                      : 'text-slate-400 hover:text-sky-600'
                  }`}
                  aria-label={activeVoiceField === 'note' ? 'หยุดพูดสรุปบันทึกช่วยจำ' : 'พูดกรอกสรุปบันทึกช่วยจำ'}
                >
                  {activeVoiceField === 'note' ? <Square size={16} /> : <Mic size={16} />}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1.5 block text-xs font-bold text-[color:var(--text)]">วันที่</label>
                <input
                  type="date"
                  value={form.logDate}
                  onChange={event => setForm(prev => ({ ...prev, logDate: event.target.value }))}
                  className="w-full rounded-xl border px-4 py-3 text-sm text-[color:var(--text)] outline-none transition focus:border-sky-500"
                  style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-bold text-[color:var(--text)]">เวลาเรียน (นาที)</label>
                <input
                  type="number"
                  min="0"
                  value={form.durationMinutes}
                  onChange={event => setForm(prev => ({ ...prev, durationMinutes: event.target.value }))}
                  className="w-full rounded-xl border px-4 py-3 text-sm text-[color:var(--text)] outline-none transition focus:border-sky-500"
                  style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}
                />
              </div>
            </div>

            <div>
              <label className="mb-2 block text-xs font-bold text-[color:var(--text)]">ความรู้สึกหลังเรียน</label>
              <div className="flex flex-wrap gap-2 rounded-[1.2rem] p-2 ring-1" style={{ background: 'var(--surface-2)', borderColor: 'var(--border)' }}>
                {moodOptions.map(mood => (
                  <button
                    key={mood}
                    type="button"
                    onClick={() => setForm(prev => ({ ...prev, mood }))}
                    className={`rounded-full px-3.5 py-2 text-[11px] font-bold transition ${
                      form.mood === mood
                        ? 'text-white shadow-[0_10px_18px_rgba(var(--accent-rgb),0.24)]'
                        : 'ring-1 hover:opacity-90'
                    }`}
                    style={
                      form.mood === mood
                        ? {
                            background: 'rgb(var(--accent-rgb))'
                          }
                        : { background: 'var(--surface)', color: 'var(--muted)', borderColor: 'var(--border)' }
                    }
                  >
                    {mood}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="mb-2 block text-xs font-bold text-[color:var(--text)]">แนบไฟล์เพิ่มเติมเข้าคลัง</label>
              <label
                htmlFor="study-capture-files"
                className="flex cursor-pointer flex-wrap items-center justify-center gap-2 rounded-2xl border border-dashed px-4 py-3 text-sm font-bold text-[color:var(--text)] transition hover:border-[rgba(var(--accent-rgb),0.45)] hover:text-[color:var(--accent)]"
                style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}
              >
                <Paperclip size={16} />
                แนบไฟล์
                <span className="text-[11px] font-medium text-[color:var(--muted)]">รองรับรูปภาพ, PDF, เสียง, DOCX, TXT</span>
              </label>
              <input
                ref={fileInputRef}
                id="study-capture-files"
                type="file"
                multiple
                accept=".pdf,.doc,.docx,.txt,.mp3,.wav,.m4a,.jpg,.jpeg,.png,.gif,.webp,image/*,audio/*"
                className="hidden"
                onChange={event => handlePickFiles(event.target.files)}
              />
              {selectedFiles.length > 0 ? (
                <div className="mt-3 space-y-2">
                  {selectedFiles.map(file => (
                    <div
                      key={`${file.name}-${file.lastModified}-${file.size}`}
                      className="flex items-center justify-between gap-3 rounded-2xl border px-3 py-2.5 text-sm text-[color:var(--text)] shadow-sm"
                      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
                    >
                      <div className="min-w-0">
                        <p className="truncate font-semibold">{file.name}</p>
                        <p className="text-[11px] text-[color:var(--muted)]">{Math.max(1, Math.round(file.size / 1024))} KB</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeSelectedFile(file)}
                        className="rounded-full p-1 text-slate-400 transition hover:bg-rose-50 hover:text-rose-500"
                        aria-label={`ลบไฟล์ ${file.name}`}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>

            {feedback ? (
              <div className={`rounded-2xl px-4 py-3 text-sm font-medium ${
                feedback.includes('เรียบร้อย')
                  ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100'
                  : 'bg-rose-50 text-rose-600 ring-1 ring-rose-100'
              }`}>
                {feedback}
              </div>
            ) : null}

            <button
              type="submit"
              disabled={saving}
              className="inline-flex w-full items-center justify-center gap-2 rounded-2xl px-4 py-3.5 text-sm font-bold shadow-[0_14px_28px_rgba(var(--accent-rgb),0.28)] transition hover:brightness-105 disabled:opacity-60"
              style={{ background: 'rgb(var(--accent-rgb))', color: 'var(--on-accent)', WebkitTextFillColor: 'var(--on-accent)' }}
            >
              {saving ? <LoaderCircle size={18} className="animate-spin" /> : <CheckCircle2 size={18} />}
              {saving ? 'กำลังบันทึก...' : 'บันทึกการเรียน'}
            </button>
          </form>
        </section>

        <section className="rounded-[1.75rem] border p-5 backdrop-blur" style={{ borderColor: 'var(--border)', background: 'color-mix(in srgb, var(--surface) 94%, transparent)', boxShadow: 'var(--shadow-soft)' }}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-bold text-[color:var(--text)]">บันทึกของวันนี้</h2>
              <p className="mt-1 text-xs text-[color:var(--muted)]">รายการล่าสุดที่ถูกเก็บเข้าคลังการเรียน</p>
            </div>
            <span className="rounded-full px-3 py-1 text-[10px] font-bold" style={{ background: 'var(--surface-2)', color: 'var(--muted)' }}>{todayLogs.length} รายการ</span>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <div
              className="flex min-h-[100px] flex-col justify-end rounded-[1.4rem] p-4 shadow-[0_14px_24px_rgba(var(--accent-rgb),0.20)]"
              style={{
                background: 'linear-gradient(145deg, rgba(var(--accent-rgb),0.88) 0%, rgb(var(--accent-rgb)) 100%)',
                color: 'var(--on-accent)',
                WebkitTextFillColor: 'var(--on-accent)'
              }}
            >
              <span className="text-3xl font-bold leading-none">
                {Math.round((todayLogs.reduce((sum, log) => sum + Number(log.duration_minutes ?? 0), 0) / 60) * 10) / 10}
              </span>
              <span className="mt-1 text-xs opacity-85">ชั่วโมงวันนี้</span>
            </div>
            <div
              className="rounded-[1.4rem] border p-4"
              style={{
                borderColor: 'rgba(var(--accent-rgb),0.16)',
                background: 'linear-gradient(180deg, rgba(var(--accent-rgb),0.06) 0%, rgba(var(--accent-rgb),0.12) 100%)'
              }}
            >
              <div className="mb-2 flex items-center gap-1.5" style={{ color: 'rgb(var(--accent-rgb))' }}>
                <Calendar size={14} />
                <span className="text-[11px] font-bold">วันที่บันทึก</span>
              </div>
              <span className="text-lg font-bold text-[color:var(--text)]">{formatThaiDate(today)}</span>
              <p className="mt-1 text-[10px] text-[color:var(--muted)]">อัปเดตล่าสุด</p>
            </div>
          </div>

          <div className="mt-4 space-y-3">
            {loading ? (
              <div className="rounded-xl px-4 py-4 text-sm text-[color:var(--muted)]" style={{ background: 'var(--surface-2)' }}>กำลังโหลดข้อมูล...</div>
            ) : todayLogs.length > 0 ? (
              todayLogs.map(log => (
                <button
                  key={`${log.subjectName}-${log.id}`}
                  type="button"
                  onClick={() => navigate(`/subjects/${log.subjectId}`, { state: { selectedLogId: log.id } })}
                  className="w-full rounded-[1.35rem] border px-4 py-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-[color:var(--accent)]/30 hover:shadow-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]/35"
                  style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-sky-600 ring-1 ring-sky-100">
                        <BookOpen size={12} />
                        {log.subjectName}
                      </p>
                      <h3 className="mt-1 text-sm font-bold text-[color:var(--text)]">{log.title}</h3>
                    </div>
                    <span className="shrink-0 text-xs font-semibold text-[color:var(--muted)]">{Number(log.duration_minutes ?? 0)} นาที</span>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-[color:var(--muted)]">{log.note || 'ไม่มีรายละเอียดเพิ่มเติม'}</p>
                  <div className="mt-3 flex items-center justify-between gap-2 text-xs text-[color:var(--muted)]">
                    <span>{formatThaiDate(log.log_date)}</span>
                    <span className="rounded-full px-2 py-1" style={{ background: 'var(--surface-2)' }}>{log.mood || 'ไม่ระบุความรู้สึก'}</span>
                  </div>
                </button>
              ))
            ) : (
              <div
                className="rounded-xl border border-dashed px-4 py-6 text-center text-xs font-medium"
                style={{
                  borderColor: 'var(--border)',
                  background: 'color-mix(in srgb, var(--surface-2) 92%, transparent)',
                  color: 'var(--muted)'
                }}
              >
                วันนี้ยังไม่มีบันทึกการเรียน ลองเพิ่มรายการแรกได้เลย
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
