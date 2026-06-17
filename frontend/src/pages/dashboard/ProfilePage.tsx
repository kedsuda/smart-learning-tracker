import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppAlert } from '../../context/AppAlertContext';
import { useAuth } from '../../context/AuthContext';
import { api, apiFallbackClients, assetBaseURL } from '../../services/api';

type ProfileFormState = {
  name: string;
  education_level: string;
  profile_pic: File | null;
  previewUrl: string | null;
};

type CareerRecommendation = {
  career: string;
  skills: string;
  subjects: string;
  score: number;
  reason?: string | null;
};

type CareerInsight = {
  top_subjects?: Array<{
    subject_name: string;
    study_hours: number;
  }>;
  latest_quiz?: {
    subject_name: string;
    percentage: number;
    passed: boolean;
  } | null;
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

export const ProfilePage = () => {
  const { user, updateUser } = useAuth();
  const { success, error } = useAppAlert();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [form, setForm] = useState<ProfileFormState>({
    name: '',
    education_level: '',
    profile_pic: null,
    previewUrl: null
  });
  const [saving, setSaving] = useState(false);
  const [editingEnabled, setEditingEnabled] = useState(false);
  const [careerRecommendation, setCareerRecommendation] = useState<CareerRecommendation | null>(null);
  const [careerInsight, setCareerInsight] = useState<CareerInsight | null>(null);

  useEffect(() => {
    if (!user) return;
    setForm(prev => ({
      ...prev,
      name: user.name ?? '',
      education_level: user.education_level ?? '',
      previewUrl: resolveProfileUrl(user.profile_pic ?? user.avatar, assetBaseURL || api.defaults.baseURL)
    }));
  }, [user]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    const loadProfilePanels = async () => {
      try {
        const [careerResponse, insightsResponse] = await Promise.allSettled([
          api.post<CareerRecommendation[]>('/career/recommendations'),
          api.get<CareerInsight>('/career/insights')
        ]);

        if (cancelled) return;

        if (careerResponse.status === 'fulfilled') {
          const firstRecommendation = careerResponse.value.data?.[0] ?? null;
          setCareerRecommendation(firstRecommendation);
        }

        if (insightsResponse.status === 'fulfilled') {
          setCareerInsight(insightsResponse.value.data ?? null);
        }
      } catch {
        // Keep profile page usable even when secondary panels fail.
      }
    };

    void loadProfilePanels();

    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => {
    return () => {
      if (form.profile_pic && form.previewUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(form.previewUrl);
      }
    };
  }, [form.previewUrl, form.profile_pic]);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    if (form.profile_pic && form.previewUrl?.startsWith('blob:')) {
      URL.revokeObjectURL(form.previewUrl);
    }
        if (!file) {
      setForm(prev => ({
        ...prev,
        profile_pic: null,
        previewUrl: resolveProfileUrl(user?.profile_pic ?? user?.avatar, assetBaseURL || api.defaults.baseURL)
      }));
      return;
    }
    const previewUrl = URL.createObjectURL(file);
    setForm(prev => ({ ...prev, profile_pic: file, previewUrl }));
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!user) return;
    const trimmedName = form.name.trim();
    const trimmedEducationLevel = form.education_level.trim();
    if (!trimmedName) {
      error('กรุณากรอกชื่อผู้ใช้ก่อนบันทึก');
      return;
    }
    setSaving(true);
    try {
      const buildPayload = (useMethodOverride = false) => {
        const payload = new FormData();
        payload.append('name', trimmedName);
        payload.append('education_level', trimmedEducationLevel);
        if (useMethodOverride) {
          payload.append('_method', 'PUT');
        }
        if (form.profile_pic) {
          payload.append('profile_pic', form.profile_pic);
        }
        return payload;
      };

      let response: any = null;
      let lastError: unknown = null;

      for (const client of apiFallbackClients) {
        try {
          response = await client.put('/auth/profile', buildPayload());
          break;
        } catch (error: any) {
          const status = error?.response?.status;
          if (status === 404 || status === 405) {
            try {
              response = await client.post('/auth/profile', buildPayload(true));
              break;
            } catch (fallbackError: any) {
              lastError = fallbackError;
              const fallbackStatus = fallbackError?.response?.status;
              if (fallbackStatus && fallbackStatus !== 404 && fallbackStatus !== 405 && fallbackStatus !== 500) {
                throw fallbackError;
              }
              continue;
            }
          }

          lastError = error;
          if (status && status !== 404 && status !== 405 && status !== 500) {
            throw error;
          }
        }
      }

      if (!response) {
        throw lastError ?? new Error('อัปเดตโปรไฟล์ไม่สำเร็จ');
      }

      const responseMessage = response.data?.message ?? 'บันทึกข้อมูลโปรไฟล์เรียบร้อยแล้ว';
      const payload = response.data?.user ?? response.data?.data ?? response.data ?? {};
      const nextName = payload?.name ?? trimmedName;
      const nextEducationLevel = payload?.education_level ?? trimmedEducationLevel;
      const cacheBustedProfilePic =
        typeof payload?.profile_pic === 'string' && payload.profile_pic.trim() !== ''
          ? `${payload.profile_pic}${payload.profile_pic.includes('?') ? '&' : '?'}v=${Date.now()}`
          : payload?.profile_pic;
      updateUser({
        ...user,
        ...payload,
        profile_pic: cacheBustedProfilePic ?? user.profile_pic ?? null,
        name: nextName,
        education_level: nextEducationLevel
      });
      setForm(prev => ({
        ...prev,
        name: nextName,
        education_level: nextEducationLevel,
        profile_pic: null,
        previewUrl: cacheBustedProfilePic
          ? resolveProfileUrl(cacheBustedProfilePic, assetBaseURL || api.defaults.baseURL)
          : prev.previewUrl
      }));
      success(responseMessage);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      setEditingEnabled(false);
    } catch (err: any) {
      error(err?.response?.data?.message ?? 'อัปเดตชื่อผู้ใช้และระดับการศึกษาไม่สำเร็จ');
    } finally {
      setSaving(false);
    }
  };

  if (!user) {
    return (
      <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface)] p-4 text-[color:var(--text)]">
        กำลังโหลดโปรไฟล์...
      </div>
    );
  }

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileChange}
        className="hidden"
      />

      <div className="mx-auto w-full max-w-6xl space-y-6 pb-10 text-[color:var(--text)]">
        <section className="relative overflow-hidden rounded-[30px] border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-[0_18px_48px_rgba(15,23,42,0.12)] md:p-8">
          <div className="absolute right-0 top-0 h-48 w-48 rounded-full bg-[color:rgba(var(--accent-rgb),0.08)] blur-3xl" />
          <div className="relative z-10 flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-5">
              <div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-[26px] text-4xl font-bold text-white shadow-[0_18px_40px_rgba(37,99,235,0.28)]" style={{ background: 'linear-gradient(135deg, #4338ca, #2563eb)' }}>
                {form.previewUrl ? (
                  <img
                    src={form.previewUrl}
                    alt={user.name ?? 'Profile'}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  user.name?.charAt(0) ?? 'U'
                )}
              </div>
              <div>
                <p className="text-sm font-medium text-[color:var(--muted)]">{user.provider ?? 'อีเมล'}</p>
                <h1 className="mt-1 text-2xl font-bold text-[color:var(--text)] md:text-3xl">{user.name}</h1>
                <p className="mt-1 flex items-center gap-2 text-sm text-[color:var(--muted)]">
                  <span className="inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
                  {user.email}
                </p>
                <div className="mt-3 inline-flex rounded-full bg-[color:var(--surface-2)] px-3 py-1 text-xs font-semibold text-[color:var(--muted)]">
                  ระดับการศึกษา: {user.education_level || 'ยังไม่ได้ระบุ'}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setEditingEnabled(true)}
              className="inline-flex items-center justify-center gap-2 rounded-2xl px-5 py-3 text-sm font-semibold text-white shadow-[0_14px_30px_rgba(37,99,235,0.22)] transition hover:brightness-110"
              style={{ background: 'linear-gradient(135deg, #2563eb, #1d4ed8)' }}
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 5H7a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" />
                <path d="m16 5 3 3" />
                <path d="M14 10 19 5" />
              </svg>
              ตั้งค่าโปรไฟล์
            </button>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <section className="relative overflow-hidden rounded-[30px] border border-[color:rgba(var(--accent-rgb),0.25)] bg-[linear-gradient(135deg,rgba(var(--accent-rgb),0.16),rgba(var(--accent-rgb),0.06))] p-6 shadow-[0_18px_48px_rgba(15,23,42,0.10)] md:p-8">
              <div className="absolute right-4 top-4 text-sky-100">
                <svg viewBox="0 0 24 24" className="h-24 w-24" fill="none" stroke="currentColor" strokeWidth="1">
                  <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h15A1.5 1.5 0 0 1 21 7.5v9A1.5 1.5 0 0 1 19.5 18h-15A1.5 1.5 0 0 1 3 16.5Z" />
                  <path d="M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6" />
                  <path d="M3 11h18" />
                </svg>
              </div>
              <div className="relative z-10">
                <div className="inline-flex items-center gap-2 rounded-full bg-sky-100 px-3 py-1 text-sm font-semibold text-sky-700">
                  <span className="inline-flex h-2.5 w-2.5 rounded-full bg-sky-500" />
                  สรุปคำแนะนำ
                </div>
                <h2 className="mt-4 text-lg text-[color:var(--muted)]">เส้นทางอาชีพที่เหมาะกับคุณ</h2>
                <div className="mt-2 text-2xl font-bold text-sky-700 md:text-4xl">
                  {careerRecommendation?.career ?? 'ยังไม่มีคำแนะนำล่าสุด'}
                </div>
                <div className="mt-4 flex items-center gap-4">
                  <div className="h-2.5 w-full max-w-xs overflow-hidden rounded-full bg-[color:var(--surface-2)]">
                    <div
                      className="h-full rounded-full bg-sky-500"
                      style={{ width: `${Math.max(8, Math.round(careerRecommendation?.score ?? 0))}%` }}
                    />
                  </div>
                  <span className="text-sm font-medium text-[color:var(--muted)]">
                    ระดับความเหมาะสม {careerRecommendation ? `${Math.round(careerRecommendation.score)}%` : '--'}
                  </span>
                </div>
                <p className="mt-6 max-w-2xl text-sm leading-relaxed text-[color:var(--muted)]">
                  {careerRecommendation?.reason ||
                    careerRecommendation?.skills ||
                    'เมื่อมีข้อมูลการเรียนและผลแบบฝึกหัดมากขึ้น ระบบจะแนะนำสายอาชีพที่เหมาะกับคุณได้ชัดเจนขึ้น'}
                </p>
                <div className="mt-6">
                  <Link
                    to="/career-advisor"
                    className="inline-flex items-center gap-2 rounded-xl bg-[color:var(--surface)] px-4 py-2.5 text-sm font-semibold text-sky-700 shadow-sm ring-1 ring-[color:rgba(var(--accent-rgb),0.25)] transition hover:bg-[color:rgba(var(--accent-rgb),0.12)]"
                  >
                    ดูอาชีพแนะนำทั้งหมด
                    <span>›</span>
                  </Link>
                </div>
              </div>
            </section>

            <div className="grid gap-6 md:grid-cols-2">
              <section className="rounded-[28px] border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-[0_18px_48px_rgba(15,23,42,0.10)]">
                <div className="flex items-center gap-2">
                  <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-violet-100 text-violet-600">
                    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 20h9" />
                      <path d="M12 4h9" />
                      <path d="M4 9h16" />
                      <path d="M4 15h10" />
                    </svg>
                  </span>
                  <div>
                    <h3 className="text-lg font-bold text-[color:var(--text)]">ทักษะที่ควรเริ่มพัฒนาก่อน</h3>
                    <p className="text-sm text-[color:var(--muted)]">สรุปจากสายอาชีพที่เหมาะกับคุณตอนนี้</p>
                  </div>
                </div>
                <div className="mt-5 flex flex-wrap gap-2">
                  {(careerRecommendation?.skills?.split(',').map(skill => skill.trim()).filter(Boolean) ?? []).slice(0, 6).map(skill => (
                    <span
                      key={skill}
                      className="rounded-xl border border-violet-100 bg-violet-50 px-3 py-1.5 text-sm font-medium text-violet-700"
                    >
                      {skill}
                    </span>
                  ))}
                  {!careerRecommendation?.skills && (
                    <span className="text-sm text-[color:var(--muted)]">ยังไม่มีรายการทักษะที่สรุปได้</span>
                  )}
                </div>
              </section>

              <section className="rounded-[28px] border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-[0_18px_48px_rgba(15,23,42,0.10)]">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-bold text-[color:var(--text)]">สถิติชั่วโมงเรียน</h3>
                    <p className="text-sm text-[color:var(--muted)]">ภาพรวมจากภารกิจสัปดาห์นี้</p>
                  </div>
                  <span className="rounded-lg bg-[color:var(--surface-2)] px-2 py-1 text-xs font-semibold text-[color:var(--muted)]">
                    สัปดาห์นี้
                  </span>
                </div>
                <div className="mt-6 flex h-32 items-end gap-2 border-b border-[color:var(--border)] pb-2">
                  {[25, 48, 32, 72, 40, 18, 10].map((height, index) => (
                    <div key={index} className="flex flex-1 flex-col items-center gap-2">
                      <div
                        className={`w-full max-w-[2rem] rounded-t-md ${index === 3 ? 'bg-sky-500' : 'bg-[color:var(--surface-2)]'}`}
                        style={{ height: `${height}%` }}
                      />
                      <span className={`text-xs ${index === 3 ? 'font-bold text-sky-600' : 'text-[color:var(--muted)]'}`}>
                        {['จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส', 'อา'][index]}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="mt-4 rounded-2xl bg-[color:var(--surface-2)] px-4 py-3">
                  <p className="text-sm font-semibold text-[color:var(--text)]">วิชาที่โดดเด่นตอนนี้</p>
                  <p className="mt-1 text-sm text-[color:var(--muted)]">
                    {careerInsight?.top_subjects?.[0]
                      ? `${careerInsight.top_subjects[0].subject_name} (${Math.round((careerInsight.top_subjects[0].study_hours / 60) * 10) / 10} ชม.)`
                      : 'ยังไม่มีข้อมูลสถิติวิชาที่โดดเด่น'}
                  </p>
                </div>
              </section>
            </div>
          </div>

        </section>

      </div>

      {editingEnabled ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg overflow-hidden rounded-[28px] border border-[color:var(--border)] bg-[color:var(--surface)] shadow-[0_32px_80px_rgba(15,23,42,0.24)]">
            <div className="flex items-center justify-between border-b border-[color:var(--border)] px-6 py-4">
              <div>
                <h2 className="text-xl font-bold text-[color:var(--text)]">อัปเดตโปรไฟล์</h2>
                <p className="mt-1 text-sm text-[color:var(--muted)]">แก้ไขข้อมูลส่วนตัวของคุณจากหน้าต่างนี้</p>
              </div>
              <button
                type="button"
                onClick={() => setEditingEnabled(false)}
                className="flex h-10 w-10 items-center justify-center rounded-full bg-[color:var(--surface-2)] text-[color:var(--muted)] transition hover:brightness-95"
                aria-label="ปิด"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-6 px-6 py-6">
              <div className="flex items-center gap-4">
                <div className="relative h-20 w-20">
                  <div className="h-20 w-20 overflow-hidden rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-2)]">
                    {form.previewUrl ? (
                      <img
                        src={form.previewUrl}
                        alt="รูปโปรไฟล์"
                        className="h-full w-full object-cover"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-2xl font-semibold text-[color:var(--muted)]">
                        {user.name?.charAt(0) ?? 'U'}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="absolute -bottom-2 -right-2 flex h-9 w-9 items-center justify-center rounded-full border border-white bg-blue-600 text-white shadow-lg transition hover:scale-105 hover:bg-blue-700"
                    title="เลือกรูปโปรไฟล์"
                    aria-label="เลือกรูปโปรไฟล์"
                  >
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 5H7a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" />
                      <path d="m16 5 3 3" />
                      <path d="M14 10 19 5" />
                      <path d="M9 13h6" />
                    </svg>
                  </button>
                </div>
                <div>
                  <p className="text-sm font-semibold text-[color:var(--text)]">รูปโปรไฟล์</p>
                  <p className="mt-1 text-sm text-[color:var(--muted)]">เลือกรูปใหม่ได้จากหน้าต่างนี้เท่านั้น</p>
                </div>
              </div>

              <div className="space-y-4">
                <h3 className="text-sm font-bold text-[color:var(--text)]">ข้อมูลบัญชี</h3>
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs text-[color:var(--muted)]">ผู้ให้บริการ</label>
                    <input
                      type="text"
                      disabled
                      value={user.provider ?? 'อีเมล'}
                      className="w-full rounded-xl border border-[color:var(--border)] bg-[color:var(--surface-2)] px-4 py-2.5 text-sm text-[color:var(--muted)] outline-none"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-[color:var(--muted)]">อีเมล</label>
                    <input
                      type="text"
                      disabled
                      value={user.email}
                      className="w-full rounded-xl border border-[color:var(--border)] bg-[color:var(--surface-2)] px-4 py-2.5 text-sm text-[color:var(--muted)] outline-none"
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-4">
                <h3 className="text-sm font-bold text-[color:var(--text)]">ข้อมูลส่วนตัว</h3>
                <div>
                  <label className="mb-1.5 block text-sm text-[color:var(--text)]">ชื่อผู้ใช้</label>
                  <input
                    value={form.name}
                    onChange={event => setForm(prev => ({ ...prev, name: event.target.value }))}
                    className="w-full rounded-xl border border-[color:var(--border)] bg-[color:var(--surface-2)] px-4 py-2.5 text-sm text-[color:var(--text)] outline-none transition focus:border-[color:var(--accent)] focus:ring-2 focus:ring-[color:rgba(var(--accent-rgb),0.22)]"
                    placeholder="ชื่อของคุณ"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-sm text-[color:var(--text)]">ระดับการศึกษา</label>
                  <input
                    value={form.education_level}
                    onChange={event => setForm(prev => ({ ...prev, education_level: event.target.value }))}
                    className="w-full rounded-xl border border-[color:var(--border)] bg-[color:var(--surface-2)] px-4 py-2.5 text-sm text-[color:var(--text)] outline-none transition focus:border-[color:var(--accent)] focus:ring-2 focus:ring-[color:rgba(var(--accent-rgb),0.22)]"
                    placeholder="เช่น มัธยม / ปริญญาตรี"
                  />
                </div>
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingEnabled(false)}
                  className="flex-1 rounded-xl bg-[color:var(--surface-2)] px-4 py-3 font-medium text-[color:var(--text)] transition hover:brightness-95"
                >
                  ยกเลิก
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="flex-1 rounded-xl bg-blue-600 px-4 py-3 font-medium text-white shadow-sm shadow-blue-200 transition hover:bg-blue-700 disabled:opacity-60"
                >
                  {saving ? 'กำลังบันทึก...' : 'บันทึกโปรไฟล์'}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
};
