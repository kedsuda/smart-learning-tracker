<?php

namespace App\Http\Controllers\API;

use App\Http\Controllers\Controller;
use App\Models\CareerPath;
use App\Models\CareerRecommendation;
use App\Models\Summary;
use App\Models\User;
use App\Services\AI\AIService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Str;

class CareerAdvisorController extends Controller
{
    public function __construct(private readonly AIService $aiService)
    {
    }

    public function insights(Request $request): JsonResponse
    {
        $user = $request->user();
        $topSubjects = $this->topSubjects($user->id);
        $weakSubjects = $this->weakSubjects($user->id, collect($topSubjects)->pluck('id')->all());
        $latestQuiz = $this->latestQuizAttempt($user->id);
        $latestQuizAnalysis = $this->latestQuizAnalysis($user->id);

        return response()->json([
            'top_subjects' => $topSubjects->values(),
            'weak_subjects' => $weakSubjects->values(),
            'latest_quiz' => $latestQuiz,
            'latest_quiz_analysis' => $latestQuizAnalysis,
        ]);
    }

    public function recommendations(Request $request): JsonResponse
    {
        $user = $request->user();

        if (! Schema::hasTable('career_recommendations')) {
            return response()->json([]);
        }

        $topSubjects = $this->topSubjects($user->id);
        if ($topSubjects->isEmpty()) {
            CareerRecommendation::query()->where('user_id', $user->id)->delete();
            return response()->json([]);
        }

        $defaultSubjectsText = collect($topSubjects)
            ->pluck('subject_name')
            ->filter(fn ($name) => is_string($name) && trim($name) !== '')
            ->take(6)
            ->map(fn ($name) => trim((string) $name))
            ->implode(', ');

        $items = CareerRecommendation::query()
            ->with('careerPath')
            ->where('user_id', $user->id)
            ->orderByDesc('id')
            ->limit(5)
            ->get()
            ->map(fn (CareerRecommendation $rec) => $this->mapRecommendation($rec, $defaultSubjectsText))
            ->filter()
            ->values();

        return response()->json($items);
    }

    public function analyze(Request $request): JsonResponse
    {
        $user = $request->user();
        $topSubjects = $this->topSubjects($user->id);
        $latestQuiz = $this->latestQuizAttempt($user->id);
        $latestQuizAnalysis = $this->latestQuizAnalysis($user->id);

        $subjectProfiles = $this->buildSubjectProfiles($topSubjects);

        if ($subjectProfiles === []) {
            if (Schema::hasTable('career_recommendations')) {
                CareerRecommendation::query()->where('user_id', $user->id)->delete();
            }
            return response()->json([
                'top_subjects' => [],
                'recommendations' => [],
                'message' => 'ยังไม่มีผลแบบฝึกหัดเพียงพอสำหรับวิเคราะห์อาชีพ',
            ]);
        }

        $recommendations = [];
        $message = null;
        $weakSubjects = $this->weakSubjects($user->id, collect($topSubjects)->pluck('id')->all());

        try {
            $recommendations = $this->aiService->generateCareerRecommendations($user, $subjectProfiles, [
                'latest_quiz' => $latestQuiz,
                'latest_quiz_analysis' => $latestQuizAnalysis,
                'weak_subjects' => $weakSubjects->values()->all(),
            ]);
        } catch (\Throwable $e) {
            $message = $e->getMessage() ?: 'ไม่สามารถวิเคราะห์อาชีพด้วย AI ได้ (ยังไม่ได้ตั้งค่า AI หรือเซิร์ฟเวอร์ไม่พร้อม)';
        }

        if ($recommendations === []) {
            $message = $message ?: 'ยังไม่สามารถสร้างคำแนะนำอาชีพจาก AI ได้ในขณะนี้';
        }

        if ($recommendations !== []) {
            $this->storeRecommendations($user, $topSubjects, $recommendations);
        }

        return response()->json([
            'top_subjects' => $topSubjects->values(),
            'weak_subjects' => $weakSubjects->values(),
            'latest_quiz' => $latestQuiz,
            'latest_quiz_analysis' => $latestQuizAnalysis,
            'recommendations' => $recommendations,
            'message' => $message,
        ]);
    }

    private function topSubjects(int $userId): Collection
    {
        $stats = $this->subjectStats($userId);
        $highestLatestQuizScore = (float) ($stats->max('latest_quiz_score') ?? 0);

        $ranked = $stats
            ->filter(function (array $row) {
                return ($row['quiz_attempt_count'] ?? 0) > 0;
            })
            ->map(function (array $row) use ($highestLatestQuizScore) {
                $minutes = (int) ($row['total_minutes'] ?? 0);
                $studyHours = $minutes > 0 ? $minutes / 60 : 0.0;
                $latestQuiz = (float) ($row['latest_quiz_score'] ?? 0);
                $avgQuiz = (float) ($row['avg_quiz_score'] ?? 0);
                $attempts = (int) ($row['quiz_attempt_count'] ?? 0);
                $passedCount = (int) ($row['passed_count'] ?? 0);
                $passRate = $attempts > 0 ? $passedCount / $attempts : 0;
                $isLatestTop = $latestQuiz > 0 && $highestLatestQuizScore > 0 && abs($latestQuiz - $highestLatestQuizScore) < 0.001;

                // Career evidence must come from actual quiz performance.
                $score = ($avgQuiz * 0.55)
                    + ($latestQuiz * 0.25)
                    + ($passRate * 15)
                    + min(5, $attempts);
                $row['strength_score'] = round($score, 3);
                $row['is_latest_top_score'] = $isLatestTop;

                // normalise hours for UI
                $row['study_hours'] = $studyHours > 0 ? round($studyHours, 1) : 0.0;
                unset($row['total_minutes']);

                return $row;
            })
            ->sortByDesc('strength_score')
            ->values()
            ->take(5)
            ->map(function (array $row) {
                unset($row['strength_score']);
                return $row;
            });

        return $this->attachMoodScores($ranked, $userId);
    }

    /**
     * @param  Collection<int, array<string,mixed>>  $subjects
     * @return Collection<int, array<string,mixed>>
     */
    private function attachMoodScores(Collection $subjects, int $userId): Collection
    {
        if ($subjects->isEmpty()) {
            return $subjects;
        }

        if (! Schema::hasTable('mood_logs')) {
            return $subjects;
        }

        $ids = $subjects->pluck('id')->all();
        $moods = DB::table('mood_logs')
            ->where('user_id', $userId)
            ->whereIn('subject_id', $ids)
            ->selectRaw('subject_id, AVG((energy_level + focus_level) / 2.0) as avg_mood_score')
            ->groupBy('subject_id')
            ->get()
            ->mapWithKeys(fn ($row) => [(int) $row->subject_id => (float) $row->avg_mood_score]);

        return $subjects->map(function (array $subject) use ($moods) {
            $subjectId = (int) ($subject['id'] ?? 0);
            if ($subjectId && $moods->has($subjectId)) {
                $subject['avg_mood_score'] = round((float) $moods->get($subjectId), 1);
            }
            return $subject;
        });
    }

    /**
     * @param  array<int,int>  $excludeSubjectIds
     */
    private function weakSubjects(int $userId, array $excludeSubjectIds = []): Collection
    {
        $stats = $this->subjectStats($userId);

        if ($excludeSubjectIds !== []) {
            $stats = $stats->reject(fn (array $row) => in_array((int) ($row['id'] ?? 0), $excludeSubjectIds, true))->values();
        }

        $ranked = $stats
            ->map(function (array $row) {
                $summaryCount = (int) ($row['summary_count'] ?? 0);
                $minutes = (int) ($row['total_minutes'] ?? 0);
                $studyHours = $minutes > 0 ? $minutes / 60 : 0.0;
                $latestQuiz = (float) ($row['latest_quiz_score'] ?? 0);
                $attempts = (int) ($row['quiz_attempt_count'] ?? 0);

                $score = ($summaryCount * 1.15)
                    + ($studyHours * 0.2)
                    + (($latestQuiz / 100) * 4.0)
                    + ((((float) ($row['avg_quiz_score'] ?? 0)) / 100) * 2.2)
                    + min(1.4, $attempts * 0.15);
                $row['strength_score'] = round($score, 3);
                return $row;
            })
            ->sortBy('strength_score')
            ->values()
            ->take(2);

        return $ranked->map(function (array $row) {
            $summaryCount = (int) ($row['summary_count'] ?? 0);
            $logCount = (int) ($row['study_log_count'] ?? 0);
            $minutes = (int) ($row['total_minutes'] ?? 0);
            $attempts = (int) ($row['quiz_attempt_count'] ?? 0);
            $latestQuiz = (float) ($row['latest_quiz_score'] ?? 0);

            $hint = 'ยังทบทวนน้อยหรือทำสรุปน้อย แนะนำเพิ่มความถี่ในการทบทวนและทำสรุปให้สม่ำเสมอ';
            if ($attempts > 0 && $latestQuiz > 0 && $latestQuiz < 60) {
                $hint = 'ทำแบบทดสอบแล้วแต่คะแนนยังต่ำ แนะนำทวนสรุปและทำโจทย์เพิ่มก่อนลองทำข้อสอบใหม่';
            } elseif ($summaryCount === 0 && $logCount === 0 && $minutes === 0 && $attempts === 0) {
                $hint = 'ยังไม่มีข้อมูลการเรียน/สรุป/ข้อสอบในวิชานี้ ลองเริ่มจากทบทวนบทพื้นฐานและทำสรุปสั้น ๆ';
            } elseif ($summaryCount === 0 && ($logCount > 0 || $minutes > 0)) {
                $hint = 'มีการบันทึกการเรียนแล้ว แต่ยังไม่มีสรุป ลองสรุป 1 หน้าเพื่อจับประเด็นสำคัญ';
            } elseif ($minutes < 60) {
                $hint = 'เวลาเรียนรวมยังน้อย ลองเพิ่มเวลาเรียน/ทบทวนให้มากขึ้นเพื่อความเข้าใจที่ต่อเนื่อง';
            }

            return [
                'id' => (int) ($row['id'] ?? 0),
                'subject_name' => (string) ($row['subject_name'] ?? ''),
                'hint' => $hint,
                'next_steps' => [
                    'ทวนสรุป 20-30 นาที',
                    'ทำแบบฝึกหัด 5 ข้อ',
                    'ลองทำแบบทดสอบอีก 1 ครั้ง',
                ],
            ];
        });
    }

    /**
     * รวมสถิติต่อวิชา (สรุป/เวลาเรียน/ผลสอบ) เพื่อใช้จัดอันดับจุดแข็ง
     *
     * @return Collection<int, array<string,mixed>>
     */
    private function subjectStats(int $userId): Collection
    {
        if (! Schema::hasTable('subjects')) {
            return collect();
        }

        $hasLogs = Schema::hasTable('study_logs');
        $hasSummaries = $hasLogs && Schema::hasTable('summaries');
        $hasQuizzes = Schema::hasTable('quizzes');
        $hasQuizAttempts = $hasQuizzes && Schema::hasTable('quiz_attempts');

        $logsAgg = $hasLogs
            ? DB::table('study_logs')
                ->selectRaw('subject_id, COUNT(*) as study_log_count, COALESCE(SUM(duration_minutes), 0) as total_minutes')
                ->groupBy('subject_id')
            : null;

        $summariesAgg = $hasSummaries
            ? DB::table('summaries')
                ->join('study_logs', 'study_logs.id', '=', 'summaries.study_log_id')
                ->selectRaw('study_logs.subject_id as subject_id, COUNT(summaries.id) as summary_count')
                ->groupBy('study_logs.subject_id')
            : null;

        $quizAgg = $hasQuizAttempts
            ? DB::table('quiz_attempts')
                ->join('quizzes', 'quizzes.id', '=', 'quiz_attempts.quiz_id')
                ->where('quiz_attempts.user_id', $userId)
                ->selectRaw('quizzes.subject_id as subject_id')
                ->selectRaw('COUNT(*) as quiz_attempt_count')
                ->selectRaw('AVG(CASE WHEN JSON_LENGTH(quiz_attempts.answers) > 0 THEN (quiz_attempts.score / JSON_LENGTH(quiz_attempts.answers)) * 100 ELSE 0 END) as avg_quiz_score')
                ->selectRaw('MAX(CASE WHEN JSON_LENGTH(quiz_attempts.answers) > 0 THEN (quiz_attempts.score / JSON_LENGTH(quiz_attempts.answers)) * 100 ELSE 0 END) as max_quiz_score')
                ->selectRaw('SUM(CASE WHEN quiz_attempts.passed = 1 THEN 1 ELSE 0 END) as passed_count')
                ->groupBy('quizzes.subject_id')
            : null;

        $latestQuizIdsAgg = $hasQuizAttempts
            ? DB::table('quiz_attempts')
                ->join('quizzes', 'quizzes.id', '=', 'quiz_attempts.quiz_id')
                ->where('quiz_attempts.user_id', $userId)
                ->selectRaw('quizzes.subject_id as subject_id, MAX(quiz_attempts.id) as latest_attempt_id')
                ->groupBy('quizzes.subject_id')
            : null;

        $latestQuizAgg = $latestQuizIdsAgg
            ? DB::query()
                ->fromSub($latestQuizIdsAgg, 'lqid')
                ->join('quiz_attempts', 'quiz_attempts.id', '=', 'lqid.latest_attempt_id')
                ->selectRaw('lqid.subject_id as subject_id')
                ->selectRaw('CASE WHEN JSON_LENGTH(quiz_attempts.answers) > 0 THEN (quiz_attempts.score / JSON_LENGTH(quiz_attempts.answers)) * 100 ELSE 0 END as latest_quiz_score')
            : null;

        $query = DB::table('subjects')
            ->where('subjects.user_id', $userId)
            ->selectRaw('subjects.id, subjects.name as subject_name');

        if ($logsAgg) {
            $query->leftJoinSub($logsAgg, 'logs', 'logs.subject_id', '=', 'subjects.id');
            $query->selectRaw('COALESCE(logs.study_log_count, 0) as study_log_count');
            $query->selectRaw('COALESCE(logs.total_minutes, 0) as total_minutes');
        } else {
            $query->selectRaw('0 as study_log_count');
            $query->selectRaw('0 as total_minutes');
        }

        if ($summariesAgg) {
            $query->leftJoinSub($summariesAgg, 'sum', 'sum.subject_id', '=', 'subjects.id');
            $query->selectRaw('COALESCE(sum.summary_count, 0) as summary_count');
        } else {
            $query->selectRaw('0 as summary_count');
        }

        if ($quizAgg) {
            $query->leftJoinSub($quizAgg, 'qa', 'qa.subject_id', '=', 'subjects.id');
            $query->selectRaw('COALESCE(qa.quiz_attempt_count, 0) as quiz_attempt_count');
            $query->selectRaw('COALESCE(qa.avg_quiz_score, 0) as avg_quiz_score');
            $query->selectRaw('COALESCE(qa.max_quiz_score, 0) as max_quiz_score');
            $query->selectRaw('COALESCE(qa.passed_count, 0) as passed_count');
        } else {
            $query->selectRaw('0 as quiz_attempt_count');
            $query->selectRaw('0 as avg_quiz_score');
            $query->selectRaw('0 as max_quiz_score');
            $query->selectRaw('0 as passed_count');
        }

        if ($latestQuizAgg) {
            $query->leftJoinSub($latestQuizAgg, 'lqa', 'lqa.subject_id', '=', 'subjects.id');
            $query->selectRaw('COALESCE(lqa.latest_quiz_score, 0) as latest_quiz_score');
        } else {
            $query->selectRaw('0 as latest_quiz_score');
        }

        try {
            return collect($query->get())->map(function ($row) {
                return [
                    'id' => (int) $row->id,
                    'subject_name' => (string) ($row->subject_name ?? ''),
                    'summary_count' => (int) ($row->summary_count ?? 0),
                    'study_log_count' => (int) ($row->study_log_count ?? 0),
                    'total_minutes' => (int) ($row->total_minutes ?? 0),
                    'quiz_attempt_count' => (int) ($row->quiz_attempt_count ?? 0),
                    'avg_quiz_score' => is_null($row->avg_quiz_score) ? null : round((float) $row->avg_quiz_score, 1),
                    'max_quiz_score' => (int) ($row->max_quiz_score ?? 0),
                    'latest_quiz_score' => (int) ($row->latest_quiz_score ?? 0),
                    'passed_count' => (int) ($row->passed_count ?? 0),
                ];
            })->values();
        } catch (\Throwable $e) {
            return collect();
        }
    }

    /**
     * @param  Collection<int, array<string,mixed>>  $topSubjects
     * @return array<int, array<string,mixed>>
     */
    private function buildSubjectProfiles(Collection $topSubjects): array
    {
        $subjectIds = $topSubjects->pluck('id')->all();
        $summarySnippets = Summary::query()
            ->select('summaries.content', 'study_logs.subject_id')
            ->join('study_logs', 'summaries.study_log_id', '=', 'study_logs.id')
            ->whereIn('study_logs.subject_id', $subjectIds)
            ->orderByDesc('summaries.created_at')
            ->get()
            ->groupBy('subject_id')
            ->map(function (Collection $items) {
                $content = (string) optional($items->first())->content;
                return Str::limit(trim($content), 400, '...');
            });

        return $topSubjects->map(function (array $subject) use ($summarySnippets) {
            $snippet = $summarySnippets->get($subject['id']);
            return [
                'id' => $subject['id'],
                'name' => $subject['subject_name'],
                'summary_count' => $subject['summary_count'],
                'study_hours' => $subject['study_hours'],
                'study_log_count' => $subject['study_log_count'],
                'quiz_attempt_count' => $subject['quiz_attempt_count'] ?? 0,
                'avg_quiz_score' => $subject['avg_quiz_score'] ?? null,
                'latest_quiz_score' => $subject['latest_quiz_score'] ?? null,
                'summary_excerpt' => $snippet ?: null,
            ];
        })->values()->all();
    }

    private function latestQuizAttempt(int $userId): ?array
    {
        if (! Schema::hasTable('quiz_attempts') || ! Schema::hasTable('quizzes') || ! Schema::hasTable('subjects')) {
            return null;
        }

        $row = DB::table('quiz_attempts')
            ->join('quizzes', 'quizzes.id', '=', 'quiz_attempts.quiz_id')
            ->join('subjects', 'subjects.id', '=', 'quizzes.subject_id')
            ->where('quiz_attempts.user_id', $userId)
            ->orderByDesc('quiz_attempts.id')
            ->selectRaw('quiz_attempts.score, quiz_attempts.passed, quiz_attempts.answers, quiz_attempts.created_at')
            ->selectRaw('quizzes.title as quiz_title')
            ->selectRaw('subjects.name as subject_name')
            ->first();

        if (! $row) {
            return null;
        }

        $answers = json_decode((string) ($row->answers ?? '[]'), true);
        $total = is_array($answers) ? count($answers) : 0;
        $score = (int) ($row->score ?? 0);
        $percentage = $total > 0 ? (int) round(($score / $total) * 100) : 0;

        return [
            'quiz_title' => (string) ($row->quiz_title ?? ''),
            'subject_name' => (string) ($row->subject_name ?? ''),
            'score' => $score,
            'total' => $total,
            'percentage' => $percentage,
            'passed' => (bool) ($row->passed ?? false),
            'created_at' => (string) ($row->created_at ?? ''),
        ];
    }

    private function latestQuizAnalysis(int $userId): ?array
    {
        if (! Schema::hasTable('quiz_attempts') || ! Schema::hasTable('quiz_questions') || ! Schema::hasTable('quizzes')) {
            return null;
        }

        $attempt = DB::table('quiz_attempts')
            ->join('quizzes', 'quizzes.id', '=', 'quiz_attempts.quiz_id')
            ->where('quiz_attempts.user_id', $userId)
            ->orderByDesc('quiz_attempts.id')
            ->select('quiz_attempts.answers', 'quiz_attempts.score', 'quizzes.title as quiz_title')
            ->first();

        if (! $attempt) {
            return null;
        }

        $answerRows = json_decode((string) ($attempt->answers ?? '[]'), true);
        if (! is_array($answerRows) || $answerRows === []) {
            return null;
        }

        $questionIds = collect($answerRows)->pluck('question_id')->filter()->map(fn ($id) => (int) $id)->all();
        if ($questionIds === []) {
            return null;
        }

        $questions = DB::table('quiz_questions')
            ->whereIn('id', $questionIds)
            ->select('id', 'question_text', 'correct_answer')
            ->get()
            ->keyBy('id');

        $weakPoints = [];
        $wrongCount = 0;
        foreach ($answerRows as $row) {
            $qid = (int) ($row['question_id'] ?? 0);
            $selected = trim((string) ($row['selected_answer'] ?? ''));
            $q = $questions->get($qid);
            if (! $q) {
                continue;
            }
            $correct = trim((string) ($q->correct_answer ?? ''));
            if ($selected === '' || mb_strtolower($selected, 'UTF-8') !== mb_strtolower($correct, 'UTF-8')) {
                $wrongCount++;
                $weakPoints[] = Str::limit(trim((string) ($q->question_text ?? '')), 120, '...');
            }
        }

        $total = count($answerRows);
        if ($total <= 0) {
            return null;
        }

        $percentage = (int) round((((int) ($attempt->score ?? 0)) / $total) * 100);
        $performance = $percentage >= 80 ? 'ดีมาก' : ($percentage >= 60 ? 'ปานกลาง' : 'ควรปรับปรุง');

        return [
            'quiz_title' => (string) ($attempt->quiz_title ?? ''),
            'performance' => $performance,
            'score_percent' => $percentage,
            'wrong_count' => $wrongCount,
            'total' => $total,
            'weak_points' => array_values(array_slice(array_unique($weakPoints), 0, 6)),
        ];
    }

    /**
     * @param  Collection<int, array<string,mixed>>  $topSubjects
     * @param  array<int, array<string,mixed>>  $recommendations
     */
    private function storeRecommendations(User $user, Collection $topSubjects, array $recommendations): void
    {
        if (! Schema::hasTable('career_recommendations')) {
            return;
        }
        $columns = Schema::getColumnListing('career_recommendations');
        $hasCareerColumn = in_array('career', $columns, true);
        $hasCareerPathId = in_array('career_path_id', $columns, true);
        $hasCareerPathsTable = Schema::hasTable('career_paths');

        CareerRecommendation::query()->where('user_id', $user->id)->delete();

        $subjectNameMap = collect($topSubjects)
            ->filter(fn (array $subject) => ! empty($subject['subject_name']))
            ->mapWithKeys(fn (array $subject) => [Str::lower($subject['subject_name']) => $subject['id']]);

        foreach ($recommendations as $recommendation) {
            $careerName = trim((string) ($recommendation['career'] ?? 'Career Path'));

            $subjectsText = (string) ($recommendation['subjects'] ?? '');
            $subjectId = $this->matchSubjectId($subjectNameMap, $subjectsText);

            $payload = [
                'user_id' => $user->id,
                'subject_id' => $subjectId,
                'score' => $recommendation['score'] ?? null,
                'reason' => $this->fitDbVarchar((string) ($recommendation['reason'] ?? ''), 255),
                'metadata' => $this->normalizeRecommendationMetadata($recommendation),
            ];

            if ($hasCareerColumn) {
                $payload['career'] = $this->fitDbVarchar($careerName, 255);
            }

            // Backward-compatible: if legacy schema still requires career_path_id, always provide it.
            if ($hasCareerPathId && $hasCareerPathsTable) {
                $careerPath = CareerPath::firstOrCreate(
                    ['name' => $careerName],
                    ['description' => $recommendation['reason'] ?? null]
                );
                $payload['career_path_id'] = $careerPath->id;
            }

            try {
                CareerRecommendation::create($payload);
            } catch (\Throwable $exception) {
                Log::warning('Skipping career recommendation persistence after database error.', [
                    'user_id' => $user->id,
                    'career' => $careerName,
                    'error' => $exception->getMessage(),
                ]);
            }
        }
    }

    /**
     * @param  Collection<string, int>  $subjectNameMap
     */
    private function matchSubjectId(Collection $subjectNameMap, string $subjectsText): ?int
    {
        if ($subjectsText === '') {
            return null;
        }

        $haystack = Str::lower($subjectsText);
        foreach ($subjectNameMap as $subjectName => $subjectId) {
            if ($subjectName !== '' && Str::contains($haystack, $subjectName)) {
                return (int) $subjectId;
            }
        }

        return null;
    }

    private function mapRecommendation(CareerRecommendation $rec, string $defaultSubjectsText): ?array
    {
        $career = trim((string) ($rec->career ?? ''));
        if ($career === '') {
            $career = trim((string) ($rec->careerPath?->name ?? ''));
        }
        if ($career === '') {
            $rawMetadata = $rec->getRawOriginal('metadata');
            if (is_string($rawMetadata) && trim($rawMetadata) !== '') {
                $decoded = json_decode($rawMetadata, true);
                if (is_array($decoded) && ! empty($decoded['career']) && is_string($decoded['career'])) {
                    $career = trim($decoded['career']);
                }
            } elseif (is_array($rec->metadata)) {
                $metaCareer = data_get($rec->metadata, 'career');
                if (is_string($metaCareer)) {
                    $career = trim($metaCareer);
                }
            }
        }
        if ($career === '') {
            return null;
        }

        $skills = null;
        $subjects = null;
        $rawMetadata = $rec->getRawOriginal('metadata');
        if (is_string($rawMetadata) && trim($rawMetadata) !== '') {
            $decoded = json_decode($rawMetadata, true);
            if (is_array($decoded)) {
                if (! empty($decoded['skills']) && is_string($decoded['skills'])) {
                    $skills = $decoded['skills'];
                }
                if (! empty($decoded['subjects']) && is_string($decoded['subjects'])) {
                    $subjects = $decoded['subjects'];
                }
            }
        } elseif (is_array($rec->metadata)) {
            $skills = is_string(data_get($rec->metadata, 'skills')) ? (string) data_get($rec->metadata, 'skills') : null;
            $subjects = is_string(data_get($rec->metadata, 'subjects')) ? (string) data_get($rec->metadata, 'subjects') : null;
        }

        $skills = trim((string) ($skills ?? ''));
        $subjects = trim((string) ($subjects ?? ''));
        if ($skills === '' || $subjects === '') {
            return null;
        }

        return [
            'id' => $rec->id,
            'career' => $career,
            'skills' => $skills,
            'subjects' => $subjects !== '' ? $subjects : $defaultSubjectsText,
            'score' => $rec->score ?? 0,
            'reason' => $rec->reason,
            'created_at' => optional($rec->created_at)->toDateTimeString(),
        ];
    }

    private function normalizeRecommendationMetadata(array $recommendation): ?array
    {
        $skills = trim((string) ($recommendation['skills'] ?? ''));
        $subjects = trim((string) ($recommendation['subjects'] ?? ''));
        if ($skills === '' || $subjects === '') {
            return null;
        }

        $metadata = [
            'skills' => $this->fitDbVarchar($skills, 80),
            'subjects' => $this->fitDbVarchar($subjects, 80),
        ];

        $encoded = json_encode($metadata);
        if ($encoded !== false && strlen($encoded) <= 240) {
            return $metadata;
        }

        $skillsLimit = 72;
        $subjectsLimit = 72;
        for ($i = 0; $i < 18; $i++) {
            $metadata['skills'] = $this->fitDbVarchar($skills, $skillsLimit);
            $metadata['subjects'] = $this->fitDbVarchar($subjects, $subjectsLimit);
            $encoded = json_encode($metadata);
            if ($encoded !== false && strlen($encoded) <= 240) {
                return $metadata;
            }
            $skillsLimit = max(12, $skillsLimit - 6);
            $subjectsLimit = max(12, $subjectsLimit - 6);
        }

        return null;
    }

    private function fitDbVarchar(string $value, int $maxBytes): ?string
    {
        $text = trim($value);
        if ($text === '') {
            return null;
        }

        if (strlen($text) <= $maxBytes) {
            return $text;
        }

        $limit = max(4, $maxBytes - 3);
        $cut = mb_strcut($text, 0, $limit, 'UTF-8');
        return rtrim($cut)."...";
    }
}
