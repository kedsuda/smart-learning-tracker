<?php

namespace App\Services\AI;

use App\Models\FileAttachment;
use App\Models\Quiz;
use App\Models\QuizAnswer;
use App\Models\QuizQuestion;
use App\Models\Schedule;
use App\Models\StudyCalendarEvent;
use App\Models\StudyLog;
use App\Models\Subject;
use App\Models\Summary;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Str;
use RuntimeException;
use ZipArchive;
use function collect;

class AIService
{
    private const ASSISTANT_TIMEZONE = 'Asia/Bangkok';

    public function __construct(private readonly AIClientFactory $factory)
    {
    }

    public function generateSummary(StudyLog $studyLog): Summary
    {
        $contextPieces = [
            'Study Subject: '.$studyLog->subject->name,
            'Study Title: '.$studyLog->title,
            'Date: '.$studyLog->log_date?->toDateString(),
            'Notes: '.$studyLog->note,
        ];
        $content = '';
        $metadata = [];
        $model = $this->summaryModel();

        if ($this->useGemini()) {
            $prompt = "You summarise study notes into concise learning summaries with highlights and action items.\n\n"
                .implode("\n\n", array_filter($contextPieces));
            $content = $this->callGemini($prompt);
            $metadata['provider'] = 'gemini';
        } else {
            $client = $this->textClient();
            $response = $client->chat()->create([
                'model' => $model,
                'messages' => [
                    ['role' => 'system', 'content' => 'You summarise study notes into concise learning summaries with highlights and action items.'],
                    ['role' => 'user', 'content' => implode("\n\n", array_filter($contextPieces))],
                ],
            ]);

            $content = trim($response->choices[0]->message->content ?? '');
            $metadata['prompt_tokens'] = $response->usage->promptTokens ?? null;
            $metadata['completion_tokens'] = $response->usage->completionTokens ?? null;
        }

        return $studyLog->summaries()->create([
            'content' => $content,
            'ai_model' => $model,
            'metadata' => $metadata,
        ]);
    }

    /**
     * @param  array<string,mixed>  $preferences
     * @return array<string,mixed>
     */
    public function generateQuiz(Subject $subject, array $preferences): array
    {
        $questionCount = $preferences['question_count'] ?? 5;
        $difficulty = $preferences['difficulty'] ?? 'medium';
        $types = $preferences['question_types'] ?? ['multiple_choice', 'short_answer'];
        $contextPayload = $this->quizSourceContext($subject);
        $typeHint = implode(', ', $types);
        $typeMixHint = in_array('multiple_choice', $types, true) && in_array('short_answer', $types, true)
            ? 'Include a mix of multiple_choice and short_answer questions (at least 1 of each).'
            : 'Use only the allowed question types.';
        $thaiOutputRules = "All generated content must be in Thai language only.\n"
            ."Return Thai for title, description, question_text, options, correct_answer, and explanation.\n"
            ."Do not use English unless it is a necessary proper noun.";
        $prompt = sprintf(
            "Generate a %s difficulty quiz for the subject \"%s\" with %d questions.\nAllowed question types: %s.\n%s\n%s\nUse ONLY the information from the study summaries below.\n\nSummaries:\n%s\n\nRespond in JSON with title, description, and questions (question_text, question_type, options, correct_answer, explanation). For multiple_choice questions, provide 4 options.",
            $difficulty,
            $subject->name,
            $questionCount,
            $typeHint,
            $typeMixHint,
            $thaiOutputRules,
            $contextPayload['context']
        );

        $decoded = null;
        if ($this->hasAnyAIKey()) {
            try {
                if ($this->useGeminiForQuiz()) {
                    $content = $this->callGemini("You generate structured JSON quizzes with questions array.\nAlways output Thai language only for all learner-facing text.\n\n{$prompt}");
                } else {
                    $client = $this->textClient();
                    $response = $client->chat()->create([
                        'model' => $this->quizModel(),
                        'messages' => [
                            ['role' => 'system', 'content' => 'You generate structured JSON quizzes with questions array. Always output Thai language only for all learner-facing text.'],
                            ['role' => 'user', 'content' => $prompt],
                        ],
                        'response_format' => ['type' => 'json_object'],
                    ]);
                    $content = $response->choices[0]->message->content ?? '{}';
                }

                $decoded = $this->decodeJsonPayload($content, 'quiz');
            } catch (\Throwable $e) {
                $decoded = null;
            }
        }

        if (! is_array($decoded)) {
            $decoded = $this->fallbackQuizFromText(
                $contextPayload['context'],
                $questionCount,
                $types,
                $subject->name !== '' ? 'แบบฝึกหัด '.$subject->name : 'แบบฝึกหัด'
            );
        }

        return $this->buildQuizPayload($decoded, $subject, $questionCount, $difficulty, $types, [
            'source' => $contextPayload['source'],
            'summary_ids' => $contextPayload['summary_ids'],
        ]);
    }

    /**
     * @param  array<string,mixed>  $preferences
     * @return array<string,mixed>
     */
    public function generateQuizFromText(Subject $subject, string $text, array $preferences): array
    {
        $text = $this->normalizeToUtf8($text);
        $questionCount = $preferences['question_count'] ?? 5;
        $difficulty = $preferences['difficulty'] ?? 'medium';
        $types = $preferences['question_types'] ?? ['multiple_choice', 'short_answer'];
        $titleHint = trim((string) ($preferences['title'] ?? ''));
        $context = $this->trimContext($text, 4000);
        $typeHint = implode(', ', $types);
        $typeMixHint = in_array('multiple_choice', $types, true) && in_array('short_answer', $types, true)
            ? 'Include a mix of multiple_choice and short_answer questions (at least 1 of each).'
            : 'Use only the allowed question types.';
        $thaiOutputRules = "All generated content must be in Thai language only.\n"
            ."Return Thai for title, description, question_text, options, correct_answer, and explanation.\n"
            ."Do not use English unless it is a necessary proper noun.";
        $titleLine = $titleHint !== '' ? "Use the title \"{$titleHint}\" if possible.\n" : '';
        $prompt = sprintf(
            "Generate a %s difficulty quiz for the subject \"%s\" with %d questions.\n%sAllowed question types: %s.\n%s\n%s\nUse ONLY the information from the document text below.\n\nDocument text:\n%s\n\nRespond in JSON with title, description, and questions (question_text, question_type, options, correct_answer, explanation). For multiple_choice questions, provide 4 options.",
            $difficulty,
            $subject->name,
            $questionCount,
            $titleLine,
            $typeHint,
            $typeMixHint,
            $thaiOutputRules,
            $context
        );

        $decoded = null;
        if ($this->hasAnyAIKey()) {
            try {
                if ($this->useGeminiForQuiz()) {
                    $content = $this->callGemini("You generate structured JSON quizzes with questions array.\nAlways output Thai language only for all learner-facing text.\n\n{$prompt}");
                } else {
                    $client = $this->textClient();
                    $response = $client->chat()->create([
                        'model' => $this->quizModel(),
                        'messages' => [
                            ['role' => 'system', 'content' => 'You generate structured JSON quizzes with questions array. Always output Thai language only for all learner-facing text.'],
                            ['role' => 'user', 'content' => $prompt],
                        ],
                        'response_format' => ['type' => 'json_object'],
                    ]);
                    $content = $response->choices[0]->message->content ?? '{}';
                }

                $decoded = $this->decodeJsonPayload($content, 'quiz');
            } catch (\Throwable $e) {
                $decoded = null;
            }
        }

        if (! is_array($decoded)) {
            $decoded = $this->fallbackQuizFromText(
                $text,
                $questionCount,
                $types,
                $titleHint !== '' ? $titleHint : ($subject->name !== '' ? 'แบบฝึกหัด '.$subject->name : 'แบบฝึกหัดจากเอกสาร')
            );
        }

        if ($titleHint !== '' && empty($decoded['title'])) {
            $decoded['title'] = $titleHint;
        }

        return $this->buildQuizPayload($decoded, $subject, $questionCount, $difficulty, $types, [
            'source' => 'document',
        ]);
    }

    /**
     * @return array{mindmap:string,model:string}
     */
    public function generateMindMapFromText(string $text): array
    {
        $source = trim($text);
        if ($source === '') {
            throw new RuntimeException('ไม่มีเนื้อหาเพียงพอสำหรับสร้างมายแมพ');
        }

        $prompt = "สร้างมายแมพการเรียนเป็นภาษาไทยจากข้อมูลด้านล่าง\n"
            ."ข้อกำหนด:\n"
            ."- ตอบเป็นข้อความล้วน อ่านง่าย\n"
            ."- รูปแบบเป็นต้นไม้ด้วย bullet และย่อหน้า (ไม่ใช้ markdown code block)\n"
            ."- แบ่งหัวข้อหลัก 3-6 หัวข้อ และหัวข้อย่อยที่ actionable\n"
            ."- กระชับ ชัดเจน ใช้ภาษานักศึกษา\n\n"
            ."ข้อมูล:\n{$source}";

        if ($this->useGemini()) {
            $mindmap = trim($this->callGemini($prompt));
        } else {
            $mindmap = trim($this->callOpenAISummary(
                'You are an expert Thai learning coach. Return concise plain-text mind maps only.',
                $prompt
            ));
        }

        if ($mindmap === '') {
            throw new RuntimeException('AI ไม่สามารถสร้างมายแมพได้ในขณะนี้');
        }

        return [
            'mindmap' => $mindmap,
            'model' => $this->summaryModel(),
        ];
    }

    /**
     * @param  array<int, array<string,mixed>>  $subjects
     * @return array<int, array<string,mixed>>
     */
    public function generateCareerRecommendations(User $user, array $subjects, array $context = []): array
    {
        if ($subjects === []) {
            return [];
        }

        $lines = collect($subjects)->map(function (array $subject) {
            $name = $subject['name'] ?? 'Subject';
            $summaryCount = $subject['summary_count'] ?? 0;
            $studyHours = $subject['study_hours'] ?? 0;
            $logCount = $subject['study_log_count'] ?? 0;
            $summaryExcerpt = $subject['summary_excerpt'] ?? null;
            $latestQuizScore = $subject['latest_quiz_score'] ?? null;
            $avgQuizScore = $subject['avg_quiz_score'] ?? null;
            $quizAttemptCount = $subject['quiz_attempt_count'] ?? 0;

            $line = "- {$name} (สรุป {$summaryCount} ครั้ง, เรียน {$studyHours} ชม., บันทึก {$logCount} ครั้ง, ทำข้อสอบ {$quizAttemptCount} ครั้ง";
            if ($latestQuizScore !== null && $latestQuizScore !== '') {
                $line .= ", คะแนนล่าสุด {$latestQuizScore}";
            }
            if ($avgQuizScore !== null && $avgQuizScore !== '') {
                $line .= ", คะแนนเฉลี่ย {$avgQuizScore}";
            }
            $line .= ')';
            if ($summaryExcerpt) {
                $line .= "\n  ตัวอย่างสรุป: ".$this->trimContext((string) $summaryExcerpt, 300);
            }
            return $line;
        })->implode("\n");

        $latestQuizSection = '';
        if (! empty($context['latest_quiz']) && is_array($context['latest_quiz'])) {
            $latestQuizSection = "ผลข้อสอบล่าสุดของผู้ใช้:\n"
                ."- วิชา: ".($context['latest_quiz']['subject_name'] ?? '-')."\n"
                ."- ชื่อแบบฝึกหัด: ".($context['latest_quiz']['quiz_title'] ?? '-')."\n"
                ."- คะแนน: ".($context['latest_quiz']['score'] ?? '-')."/".($context['latest_quiz']['total'] ?? '-')." (".($context['latest_quiz']['percentage'] ?? '-')."%)\n";
        }

        $weakSubjectsSection = '';
        if (! empty($context['weak_subjects']) && is_array($context['weak_subjects'])) {
            $weakLines = collect($context['weak_subjects'])
                ->take(3)
                ->map(function (array $subject) {
                    $name = $subject['subject_name'] ?? 'Subject';
                    $hint = $subject['hint'] ?? '';
                    return "- {$name}: {$hint}";
                })
                ->implode("\n");
            if ($weakLines !== '') {
                $weakSubjectsSection = "จุดที่ยังควรพัฒนา:\n{$weakLines}\n";
            }
        }

        $latestQuizAnalysisSection = '';
        if (! empty($context['latest_quiz_analysis']) && is_array($context['latest_quiz_analysis'])) {
            $weakPoints = $context['latest_quiz_analysis']['weak_points'] ?? [];
            $weakPointText = is_array($weakPoints) && $weakPoints !== []
                ? implode(' | ', array_slice(array_map(fn ($v) => (string) $v, $weakPoints), 0, 6))
                : 'ไม่พบจุดอ่อนที่สรุปได้ชัดเจน';
            $latestQuizAnalysisSection = "วิเคราะห์จากแบบฝึกหัดล่าสุด:\n"
                ."- สถานะ: ".($context['latest_quiz_analysis']['performance'] ?? '-')."\n"
                ."- ประเด็นที่ควรพัฒนา: {$weakPointText}\n";
        }

        $prompt = "หลักฐานผลแบบฝึกหัดจริง แยกตามรายวิชา (เรียงจากผลงานดีที่สุด):\n{$lines}\n\n"
            .$latestQuizSection
            .$latestQuizAnalysisSection
            .$weakSubjectsSection
            ."ช่วยแนะนำเส้นทางอาชีพที่เหมาะสมไม่เกิน 3 รายการ โดยใช้เฉพาะผลแบบฝึกหัดจริงเป็นหลัก: คะแนนเฉลี่ย คะแนนล่าสุด อัตราผ่าน และจำนวนครั้งที่ทำ "
            ."ข้อมูลการเรียนหรือสรุปใช้เป็นบริบทเสริมเท่านั้น ห้ามใช้แทนหลักฐานจากแบบฝึกหัด "
            ."ให้ระบุทักษะที่ควรพัฒนาเพิ่มเติมแบบเฉพาะเจาะจง และเหตุผลสั้น ๆ\n\n"
            ."ห้ามอ้างรายวิชา ความถนัด ประสบการณ์ หรืออาชีพจากข้อมูลที่ไม่มีในหลักฐานด้านบน "
            ."subjects ของทุกคำแนะนำต้องเป็นชื่อวิชาที่ปรากฏในหลักฐานเท่านั้น "
            ."ถ้าหลักฐานไม่พอหรือคะแนนยังไม่ชี้ความถนัดอย่างน่าเชื่อถือ ให้คืน recommendations เป็น [] และห้ามเดา "
            ."ถ้าคะแนนล่าสุดยังไม่สูง ให้สะท้อนเป็นทักษะที่ควรพัฒนา ไม่ใช่กล่าวว่าผู้ใช้ถนัดวิชานั้น\n\n"
            ."ตอบกลับเป็น JSON เท่านั้นในรูปแบบ:\n{\n  \"recommendations\": [\n    {\n      \"career\": \"ชื่ออาชีพ\",\n      \"skills\": \"ทักษะที่ควรพัฒนา (คั่นด้วยจุลภาค)\",\n      \"subjects\": \"รายวิชาที่เกี่ยวข้อง (คั่นด้วยจุลภาค)\",\n      \"score\": 0-100,\n      \"reason\": \"เหตุผลสั้น ๆ\"\n    }\n  ]\n}\n\nกำหนด score เป็นตัวเลข 0-100 และให้ครบ 3 รายการ";

        if ($this->shouldUseGroqForCareer()) {
            if (! $this->hasGroqKey()) {
                throw new RuntimeException('ยังไม่ได้ตั้งค่า GROQ_API_KEY สำหรับวิเคราะห์อาชีพ');
            }
            $client = $this->factory->groq();
            $response = $client->chat()->create([
                'model' => $this->groqModel(),
                'messages' => [
                    [
                        'role' => 'system',
                        'content' => 'You are a career advisor. Provide concise, practical recommendations in Thai. Reply with JSON only.',
                    ],
                    [
                        'role' => 'user',
                        'content' => $prompt."\n\nสำคัญ: ตอบเป็น JSON object เท่านั้น ห้ามมีข้อความอื่นก่อนหรือหลัง JSON",
                    ],
                ],
            ]);
            $content = $response->choices[0]->message->content ?? '{}';
        } elseif ($this->hasGroqKey()) {
            $client = $this->factory->groq();
            $response = $client->chat()->create([
                'model' => $this->groqModel(),
                'messages' => [
                    [
                        'role' => 'system',
                        'content' => 'You are a career advisor. Provide concise, practical recommendations in Thai. Reply with JSON only.',
                    ],
                    [
                        'role' => 'user',
                        'content' => $prompt."\n\nสำคัญ: ตอบเป็น JSON object เท่านั้น ห้ามมีข้อความอื่นก่อนหรือหลัง JSON",
                    ],
                ],
            ]);
            $content = $response->choices[0]->message->content ?? '{}';
        } elseif ($this->useGemini()) {
            $content = $this->callGemini(
                "You are a career advisor. Provide concise, practical recommendations in Thai.\n\n{$prompt}"
            );
        } else {
            $client = $this->textClient();
            $response = $client->chat()->create([
                'model' => $this->summaryModel(),
                'messages' => [
                    [
                        'role' => 'system',
                        'content' => 'You are a career advisor. Provide concise, practical recommendations in Thai.',
                    ],
                    [
                        'role' => 'user',
                        'content' => $prompt,
                    ],
                ],
                'response_format' => ['type' => 'json_object'],
            ]);
            $content = $response->choices[0]->message->content ?? '{}';
        }

        $decoded = $this->decodeJsonPayload($content, 'career');
        $items = $decoded['recommendations'] ?? [];

        if (! is_array($items)) {
            return [];
        }

        $allowedSubjects = collect($subjects)
            ->pluck('name')
            ->filter(fn ($name) => is_string($name) && trim($name) !== '')
            ->map(fn ($name) => trim((string) $name))
            ->values();

        return collect($items)->map(function (array $item) use ($allowedSubjects) {
            $career = trim((string) ($item['career'] ?? ''));
            $skills = $item['skills'] ?? '';
            $subjects = $item['subjects'] ?? '';
            $reason = trim((string) ($item['reason'] ?? ''));

            if (is_array($skills)) {
                $skills = implode(', ', array_filter(array_map('trim', $skills)));
            }
            if (is_array($subjects)) {
                $subjects = implode(', ', array_filter(array_map('trim', $subjects)));
            }

            $matchedSubjects = collect(preg_split('/[,|]+/u', (string) $subjects) ?: [])
                ->map(fn ($name) => trim($name))
                ->filter(fn ($name) => $name !== '' && $allowedSubjects->contains($name))
                ->values();

            if ($career === '' || $matchedSubjects->isEmpty() || $reason === '') {
                return null;
            }

            $score = (float) ($item['score'] ?? 0);
            $score = max(0, min(100, $score));

            return [
                'career' => $career,
                'skills' => (string) $skills,
                'subjects' => $matchedSubjects->implode(', '),
                'score' => $score,
                'reason' => $reason,
            ];
        })->filter()->take(3)->values()->all();
    }

    private function shouldUseGroqForCareer(): bool
    {
        return strtolower((string) config('ai.career_provider')) === 'groq';
    }

    /**
     * @param  array<int, array<string, string>>  $history
     */
    public function chatWithAssistant(User $user, string $message, array $history = [], ?string $tool = null): string
    {
        $cleanMessage = trim($message);
        if ($cleanMessage === '') {
            throw new RuntimeException('Message cannot be empty.');
        }

        $commandReply = $this->handleAssistantActionCommand($user, $cleanMessage);
        if ($commandReply !== null) {
            return $commandReply;
        }

        $toolLabel = trim((string) $tool);
        $assistantContext = $this->buildAssistantContext($user);
        $systemPrompt = "You are Smart Room, a Thai study assistant for university students.\n"
            ."Respond in Thai unless the user explicitly asks for another language.\n"
            ."Adopt a polite female persona when replying in Thai and naturally end sentences with 'ค่ะ' where appropriate.\n"
            ."Be concise, practical, and friendly.\n"
            ."Help with study planning, summaries, homework guidance, revision, and learning motivation.\n"
            ."If the user asks to record or remember something, acknowledge it clearly.\n"
            ."You may use the provided current date/time and study database context as factual context for the reply.\n"
            ."Treat the provided current date/time as Thailand local time (UTC+7). Do not convert it to UTC unless the user explicitly asks.\n"
            ."Do not invent data beyond the provided context.\n"
            ."Current user: {$user->name} ({$user->email}).\n"
            ."{$assistantContext}";

        if ($toolLabel !== '') {
            $systemPrompt .= "\nPreferred tool context: {$toolLabel}.";
        }

        try {
            if ($this->useGemini()) {
                $historyText = collect($history)
                    ->take(-12)
                    ->map(function (array $item) {
                        $role = ($item['sender_type'] ?? 'user') === 'assistant' ? 'Assistant' : 'User';
                        $text = trim((string) ($item['message'] ?? ''));
                        return $text !== '' ? "{$role}: {$text}" : null;
                    })
                    ->filter()
                    ->implode("\n");

                $prompt = $systemPrompt
                    ."\n\nConversation history:\n"
                    .($historyText !== '' ? $historyText : 'No previous messages.')
                    ."\n\nLatest user message:\n{$cleanMessage}\n\nReply with only the assistant response text.";

                $reply = trim($this->callGemini($prompt));
            } else {
                $messages = [
                    ['role' => 'system', 'content' => $systemPrompt],
                ];

                foreach (collect($history)->take(-12) as $item) {
                    $text = trim((string) ($item['message'] ?? ''));
                    if ($text === '') {
                        continue;
                    }

                    $messages[] = [
                        'role' => ($item['sender_type'] ?? 'user') === 'assistant' ? 'assistant' : 'user',
                        'content' => $text,
                    ];
                }

                if (($messages[array_key_last($messages)]['role'] ?? null) !== 'user'
                    || ($messages[array_key_last($messages)]['content'] ?? null) !== $cleanMessage) {
                    $messages[] = ['role' => 'user', 'content' => $cleanMessage];
                }

                $client = $this->textClient();
                $response = $client->chat()->create([
                    'model' => $this->summaryModel(),
                    'messages' => $messages,
                ]);

                $reply = trim((string) ($response->choices[0]->message->content ?? ''));
            }
        } catch (\Throwable $e) {
            // Keep assistant usable even if upstream AI provider is unavailable.
            report($e);
            $reply = $this->buildAssistantOfflineReply($cleanMessage);
        }

        if ($reply === '') {
            throw new RuntimeException('AI returned an empty reply.');
        }

        if (! $this->assistantAskedForNonThai($cleanMessage)) {
            $reply = $this->sanitizeAssistantThaiReply($reply);
        }

        return $reply;
    }

    private function assistantAskedForNonThai(string $message): bool
    {
        $text = mb_strtolower(trim($message), 'UTF-8');
        if ($text === '') {
            return false;
        }

        return (bool) preg_match('/\b(english|eng|chinese|china|japanese|korean)\b/u', $text)
            || str_contains($text, 'ภาษาอังกฤษ')
            || str_contains($text, 'ภาษาจีน')
            || str_contains($text, 'ภาษาญี่ปุ่น')
            || str_contains($text, 'ภาษาเกาหลี')
            || str_contains($text, 'ตอบอังกฤษ')
            || str_contains($text, 'ตอบจีน');
    }

    private function sanitizeAssistantThaiReply(string $reply): string
    {
        $clean = trim($reply);
        if ($clean === '') {
            return $reply;
        }

        // Remove CJK ideographs when user did not request another language.
        $clean = preg_replace('/\p{Han}+/u', '', $clean) ?? $clean;
        $clean = preg_replace('/[ \t]{2,}/u', ' ', $clean) ?? $clean;
        $clean = preg_replace("/\n{3,}/u", "\n\n", $clean) ?? $clean;
        $clean = trim($clean);

        if ($clean === '') {
            return 'ขออภัยค่ะ ระบบตอบกลับผิดรูปแบบเล็กน้อย กรุณาพิมพ์อีกครั้งได้เลยค่ะ';
        }

        return $clean;
    }

    private function handleAssistantActionCommand(User $user, string $message): ?string
    {
        if (preg_match('/เพิ่มวิชา(?:เรียน)?/u', $message)) {
            return $this->handleCreateSubjectCommand($user, $message);
        }

        if (preg_match('/ลบวิชา/u', $message)) {
            return $this->handleDeleteSubjectCommand($user, $message);
        }

        if (preg_match('/(?:ตาราง|schedule).*(?:วันนี้|today)/iu', $message)) {
            return $this->handleShowScheduleCommand($user, 0);
        }

        if (preg_match('/(?:ตาราง|schedule).*(?:พรุ่งนี้|tomorrow)/iu', $message)) {
            return $this->handleShowScheduleCommand($user, 1);
        }

        if (preg_match('/(?:วิชาทั้งหมด|รายการวิชา|มีวิชาอะไร|list subjects)/iu', $message)) {
            return $this->handleListSubjectsCommand($user);
        }

        if (preg_match('/(?:คำสั่ง|ช่วยเหลือ|help)/iu', $message)) {
            return $this->assistantCommandHelpText();
        }

        return null;
    }

    private function handleCreateSubjectCommand(User $user, string $message): string
    {
        $parsed = $this->parseCreateSubjectCommand($message);
        if (($parsed['ok'] ?? false) !== true) {
            return 'ได้ค่ะ หากต้องการเพิ่มวิชาผ่านแชต กรุณาพิมพ์รูปแบบนี้: เพิ่มวิชา [ชื่อวิชา] วัน[วันเรียน] [เวลาเริ่ม]-[เวลาเลิก] ห้อง [ห้องเรียน] เช่น เพิ่มวิชา คณิต วันจันทร์ 09:00-12:00 ห้อง 102 ค่ะ';
        }

        $subjectName = (string) $parsed['subject_name'];
        $dayLabel = (string) $parsed['day_label'];
        $dayIndex = (int) $parsed['day_index'];
        $startTime = (string) $parsed['start_time'];
        $endTime = (string) $parsed['end_time'];
        $room = (string) ($parsed['room'] ?? '');

        $tz = self::ASSISTANT_TIMEZONE;
        $nextDate = $this->nextDateForDayIndex($dayIndex, $tz);
        $startAt = Carbon::parse($nextDate->format('Y-m-d').' '.$startTime, $tz);
        $endAt = Carbon::parse($nextDate->format('Y-m-d').' '.$endTime, $tz);

        if ($endAt->lessThanOrEqualTo($startAt)) {
            return 'เวลาเลิกต้องมากกว่าเวลาเริ่มค่ะ กรุณาระบุใหม่ เช่น 09:00-12:00 ค่ะ';
        }

        try {
            DB::transaction(function () use ($user, $subjectName, $room, $nextDate, $startTime, $endTime, $dayLabel, $startAt, $endAt) {
                $subjectPayload = [
                    'user_id' => $user->id,
                    'name' => $subjectName,
                    'description' => '-',
                    'color' => '#2563eb',
                    'start_date' => $nextDate->format('Y-m-d'),
                    'start_time' => $startTime,
                    'end_time' => $endTime,
                ];
                if ($room !== '' && $this->hasColumnSafe('subjects', 'room')) {
                    $subjectPayload['room'] = $room;
                }

                $subject = Subject::withoutGlobalScopes()->create($subjectPayload);

                $schedulePayload = [
                    'user_id' => $user->id,
                    'subject_id' => $subject->id,
                    'day_of_week' => $dayLabel,
                    'start_time' => $startAt,
                    'end_time' => $endAt,
                    'schedule_type' => 'class',
                ];
                if ($room !== '' && $this->hasColumnSafe('schedules', 'room')) {
                    $schedulePayload['room'] = $room;
                }
                Schedule::withoutGlobalScopes()->create($schedulePayload);

                $eventPayload = [
                    'user_id' => $user->id,
                    'subject_id' => $subject->id,
                    'title' => $subjectName,
                    'start_time' => $startAt,
                    'end_time' => $endAt,
                    'status' => 'planned',
                    'metadata' => [
                        'type' => 'class',
                        'all_day' => false,
                        'source' => 'assistant_chat',
                        'room' => $room !== '' ? $room : null,
                    ],
                ];
                if ($this->hasColumnSafe('study_calendar_events', 'event_type')) {
                    $eventPayload['event_type'] = 'class';
                }
                if ($room !== '' && $this->hasColumnSafe('study_calendar_events', 'room')) {
                    $eventPayload['room'] = $room;
                }
                StudyCalendarEvent::withoutGlobalScopes()->create($eventPayload);
            });
        } catch (\Throwable $e) {
            report($e);
            return 'ยังไม่สามารถเพิ่มวิชาได้ในตอนนี้ กรุณาลองใหม่อีกครั้งค่ะ';
        }

        $roomText = $room !== '' ? " ห้อง {$room}" : '';
        return "เพิ่มวิชา {$subjectName} เรียบร้อยแล้วค่ะ\nตารางเรียน: {$dayLabel} {$startTime}-{$endTime}{$roomText}\nและบันทึกลงปฏิทินเรียนเรียบร้อยแล้วค่ะ";
    }

    private function handleDeleteSubjectCommand(User $user, string $message): string
    {
        if (! preg_match('/ลบวิชา\s*[:\-]?\s*(.+)$/u', $message, $m)) {
            return 'หากต้องการลบวิชา พิมพ์: ลบวิชา [ชื่อวิชา] ค่ะ';
        }

        $subjectName = trim((string) ($m[1] ?? ''));
        if ($subjectName === '') {
            return 'หากต้องการลบวิชา พิมพ์: ลบวิชา [ชื่อวิชา] ค่ะ';
        }

        $subject = Subject::withoutGlobalScopes()
            ->where('user_id', $user->id)
            ->where('name', $subjectName)
            ->first();

        if (! $subject) {
            return "ไม่พบวิชา {$subjectName} ค่ะ ลองตรวจสอบชื่อวิชาอีกครั้ง";
        }

        $subjectId = (int) $subject->id;
        DB::transaction(function () use ($subjectId, $user) {
            StudyCalendarEvent::withoutGlobalScopes()
                ->where('user_id', $user->id)
                ->where('subject_id', $subjectId)
                ->delete();
            Schedule::withoutGlobalScopes()
                ->where('user_id', $user->id)
                ->where('subject_id', $subjectId)
                ->delete();
            Subject::withoutGlobalScopes()
                ->where('user_id', $user->id)
                ->where('id', $subjectId)
                ->delete();
        });

        return "ลบวิชา {$subjectName} และลบออกจากตารางเรียนเรียบร้อยแล้วค่ะ";
    }

    private function handleShowScheduleCommand(User $user, int $daysOffset): string
    {
        $date = Carbon::now(self::ASSISTANT_TIMEZONE)->addDays($daysOffset)->startOfDay();
        $start = $date->copy();
        $end = $date->copy()->endOfDay();

        $events = StudyCalendarEvent::withoutGlobalScopes()
            ->where('user_id', $user->id)
            ->whereBetween('start_time', [$start, $end])
            ->orderBy('start_time')
            ->limit(20)
            ->get();

        $dayText = $daysOffset === 0 ? 'วันนี้' : 'พรุ่งนี้';
        if ($events->isEmpty()) {
            return "{$dayText} คุณไม่มีตารางเรียนค่ะ";
        }

        $lines = $events->map(function (StudyCalendarEvent $event) {
            $startText = optional($event->start_time)?->timezone(self::ASSISTANT_TIMEZONE)->format('H:i') ?? '--:--';
            $endText = optional($event->end_time)?->timezone(self::ASSISTANT_TIMEZONE)->format('H:i') ?? '--:--';
            return "- {$event->title} {$startText}-{$endText}";
        })->implode("\n");

        return "{$dayText} มีตารางเรียนดังนี้:\n{$lines}";
    }

    private function handleListSubjectsCommand(User $user): string
    {
        $subjects = Subject::withoutGlobalScopes()
            ->where('user_id', $user->id)
            ->orderBy('name')
            ->limit(50)
            ->get(['name']);

        if ($subjects->isEmpty()) {
            return 'ตอนนี้ยังไม่มีวิชาในระบบค่ะ';
        }

        $lines = $subjects->map(fn (Subject $subject) => "- {$subject->name}")->implode("\n");
        return "รายการวิชาของคุณ:\n{$lines}";
    }

    private function assistantCommandHelpText(): string
    {
        return "คำสั่งที่ทำได้ผ่านแชตตอนนี้:\n"
            ."- เพิ่มวิชา [ชื่อวิชา] วัน[วัน] [เวลาเริ่ม]-[เวลาเลิก] ห้อง [ห้อง]\n"
            ."- ลบวิชา [ชื่อวิชา]\n"
            ."- ดูตารางวันนี้\n"
            ."- ดูตารางพรุ่งนี้\n"
            ."- รายการวิชา";
    }

    /**
     * @return array{ok:bool, subject_name?:string, day_label?:string, day_index?:int, start_time?:string, end_time?:string, room?:string}
     */
    private function parseCreateSubjectCommand(string $message): array
    {
        if (! preg_match('/เพิ่มวิชา(?:เรียน)?\s*[:\-]?\s*(.+)$/iu', $message, $m)) {
            return ['ok' => false];
        }

        $payload = trim((string) ($m[1] ?? ''));
        if ($payload === '') {
            return ['ok' => false];
        }

        if (! preg_match('/(?:วัน)?(วันนี้|พรุ่งนี้|today|tomorrow|จันทร์|อังคาร|พุธ|พฤหัสบดี|ศุกร์|เสาร์|อาทิตย์|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)/iu', $payload, $dayMatch, PREG_OFFSET_CAPTURE)) {
            return ['ok' => false];
        }

        $dayToken = Str::lower((string) $dayMatch[1][0]);
        $dayOffset = (int) $dayMatch[0][1];
        // preg_match offset is byte-based; use substr/mb_strcut instead of mb_substr.
        $subjectName = trim(substr($payload, 0, $dayOffset));
        $subjectName = trim($subjectName, " \t\n\r\0\x0B-:|");
        if (preg_match('/(?:ชื่อวิชา|subject)\s*[:：]?\s*(.+?)\s*(?:วัน|เวลา|ห้อง|$)/iu', $payload, $subjectMatch)) {
            $subjectName = trim((string) ($subjectMatch[1] ?? ''));
        }
        $subjectName = preg_replace('/^(?:เรียน|วิชา|ชื่อวิชา|น้อง)\s*/u', '', $subjectName) ?? $subjectName;
        $subjectName = trim($subjectName, " \t\n\r\0\x0B-:|");
        if ($subjectName === '') {
            return ['ok' => false];
        }

        $today = Carbon::now(self::ASSISTANT_TIMEZONE);
        $day = match ($dayToken) {
            'วันนี้', 'today' => ['label' => 'วันนี้', 'index' => $today->dayOfWeek],
            'พรุ่งนี้', 'tomorrow' => ['label' => 'วันพรุ่งนี้', 'index' => $today->copy()->addDay()->dayOfWeek],
            'จันทร์', 'monday', 'mon' => ['label' => 'วันจันทร์', 'index' => 1],
            'อังคาร', 'tuesday', 'tue' => ['label' => 'วันอังคาร', 'index' => 2],
            'พุธ', 'wednesday', 'wed' => ['label' => 'วันพุธ', 'index' => 3],
            'พฤหัสบดี', 'thursday', 'thu' => ['label' => 'วันพฤหัสบดี', 'index' => 4],
            'ศุกร์', 'friday', 'fri' => ['label' => 'วันศุกร์', 'index' => 5],
            'เสาร์', 'saturday', 'sat' => ['label' => 'วันเสาร์', 'index' => 6],
            'อาทิตย์', 'sunday', 'sun' => ['label' => 'วันอาทิตย์', 'index' => 0],
            default => null,
        };
        if ($day === null) {
            return ['ok' => false];
        }

        if (! preg_match('/(\d{1,2}(?:[:.]\d{2})?\s*(?:โมง|น|น\.)?)\s*(?:\-|ถึง|to)\s*(\d{1,2}(?:[:.]\d{2})?\s*(?:โมง|น|น\.)?)/u', $payload, $timeMatch)) {
            return ['ok' => false];
        }

        $startTime = $this->normalizeTimeToken((string) ($timeMatch[1] ?? ''));
        $endTime = $this->normalizeTimeToken((string) ($timeMatch[2] ?? ''));
        if ($startTime === null || $endTime === null) {
            return ['ok' => false];
        }

        $room = '';
        if (preg_match('/(?:ห้อง(?:เรียน)?|room)\s*[:：]?\s*([A-Za-z0-9ก-๙\-\/]+)/iu', $payload, $roomMatch)) {
            $room = trim((string) ($roomMatch[1] ?? ''));
        }

        return [
            'ok' => true,
            'subject_name' => $subjectName,
            'day_label' => $day['label'],
            'day_index' => $day['index'],
            'start_time' => $startTime,
            'end_time' => $endTime,
            'room' => $room,
        ];
    }

    private function normalizeTimeToken(string $value): ?string
    {
        $value = trim(Str::lower($value));
        $value = str_replace(['น.', 'น'], '', $value);
        $value = preg_replace('/\s*โมง\s*/u', ':00', $value) ?? $value;
        $value = str_replace('.', ':', trim($value));

        if (preg_match('/^(\d{1,2})$/', $value, $hm)) {
            $value = $hm[1].':00';
        }

        if (! preg_match('/^(\d{1,2}):(\d{2})$/', $value, $m)) {
            return null;
        }

        $hour = (int) $m[1];
        $minute = (int) $m[2];
        if ($hour < 0 || $hour > 23 || $minute < 0 || $minute > 59) {
            return null;
        }

        return sprintf('%02d:%02d:00', $hour, $minute);
    }

    private function nextDateForDayIndex(int $dayIndex, string $timezone): Carbon
    {
        $now = Carbon::now($timezone)->startOfDay();
        $diff = ($dayIndex - $now->dayOfWeek + 7) % 7;
        return $now->copy()->addDays($diff);
    }

    private function hasColumnSafe(string $table, string $column): bool
    {
        try {
            return Schema::hasTable($table) && Schema::hasColumn($table, $column);
        } catch (\Throwable) {
            return false;
        }
    }

    private function buildAssistantOfflineReply(string $message): string
    {
        $text = mb_strtolower(trim($message), 'UTF-8');

        if ($text === '') {
            return 'รับทราบค่ะ ตอนนี้ยังไม่มีข้อความคำถาม หากต้องการให้ช่วยวางแผนหรือสรุปบทเรียน พิมพ์หัวข้อที่ต้องการได้เลยค่ะ';
        }

        if (str_contains($text, 'สรุป') || str_contains($text, 'summary')) {
            return 'ได้ค่ะ ส่งหัวข้อหรือเนื้อหาที่ต้องการสรุปมาได้เลย แล้วฉันจะช่วยจัดสรุปแบบสั้น กระชับ และอ่านทบทวนง่ายให้ทันทีค่ะ';
        }

        if (str_contains($text, 'แบบฝึกหัด') || str_contains($text, 'quiz') || str_contains($text, 'ข้อสอบ')) {
            return 'ได้ค่ะ ไปที่เมนูแบบฝึกหัด เลือกวิชา ระดับความยาก และจำนวนข้อ จากนั้นกดสร้างได้เลย หากต้องการฉันช่วยออกแนวข้อสอบก่อนสร้าง พิมพ์หัวข้อที่อยากฝึกมาได้ค่ะ';
        }

        if (str_contains($text, 'ตาราง') || str_contains($text, 'แผน') || str_contains($text, 'อ่านหนังสือ')) {
            return 'ได้ค่ะ แนะนำเริ่มจากแบ่งเวลา 25-30 นาทีต่อรอบ แล้วพัก 5 นาที ทำ 4 รอบต่อวิชา และทบทวนสรุปสั้นท้ายวัน 10 นาที หากบอกเวลาว่างของคุณ ฉันจะจัดตารางรายวันให้ละเอียดได้ค่ะ';
        }

        return 'รับทราบค่ะ ตอนนี้ระบบ AI ภายนอกมีปัญหาชั่วคราว แต่ฉันยังช่วยวางแผนการเรียน สรุปหัวข้อ และจัดแนวฝึกให้ได้ พิมพ์สิ่งที่อยากให้ช่วยต่อได้เลยค่ะ';
    }

    private function buildAssistantContext(User $user): string
    {
        $now = Carbon::now(self::ASSISTANT_TIMEZONE);
        $subjects = Subject::withoutGlobalScopes()
            ->where('user_id', $user->id)
            ->orderBy('name')
            ->get();

        if ($subjects->isEmpty()) {
            return "Current local datetime in Thailand (UTC+7): {$now->format('Y-m-d H:i:s')} ({$now->timezoneName}).\nNo study subjects found in the database for this user.";
        }

        $subjectIds = $subjects->pluck('id')->all();
        $studyLogs = StudyLog::withoutGlobalScopes()
            ->where('user_id', $user->id)
            ->whereIn('subject_id', $subjectIds)
            ->orderByDesc('log_date')
            ->orderByDesc('id')
            ->get();

        $studyLogIds = $studyLogs->pluck('id')->all();
        $files = empty($studyLogIds)
            ? collect()
            : FileAttachment::query()
                ->whereIn('study_log_id', $studyLogIds)
                ->orderByDesc('id')
                ->get();

        $summaries = empty($studyLogIds)
            ? collect()
            : Summary::query()
                ->whereIn('study_log_id', $studyLogIds)
                ->orderByDesc('id')
                ->get();

        $calendarEvents = StudyCalendarEvent::withoutGlobalScopes()
            ->where('user_id', $user->id)
            ->whereIn('subject_id', $subjectIds)
            ->orderBy('start_time')
            ->get();

        $logsBySubject = $studyLogs->groupBy('subject_id');
        $filesByStudyLog = $files->groupBy('study_log_id');
        $summariesByStudyLog = $summaries->groupBy('study_log_id');
        $eventsBySubject = $calendarEvents->groupBy('subject_id');
        $schedules = Schedule::query()
            ->where('user_id', $user->id)
            ->whereIn('subject_id', $subjectIds)
            ->orderBy('day_of_week')
            ->orderBy('start_time')
            ->get();

        $weeklyTimetable = $this->buildAssistantWeeklyTimetable($subjects, $calendarEvents, $schedules);

        $subjectLines = $subjects->map(function (Subject $subject) use ($logsBySubject, $filesByStudyLog, $summariesByStudyLog, $eventsBySubject) {
            $subjectLogs = $logsBySubject->get($subject->id, collect());
            $events = $eventsBySubject->get($subject->id, collect());

            $studyCount = $subjectLogs->where('log_type', StudyLog::TYPE_STUDY)->count();
            $documentSummaryCount = $subjectLogs->where('log_type', StudyLog::TYPE_DOCUMENT_SUMMARY)->count();
            $audioSummaryCount = $subjectLogs->where('log_type', StudyLog::TYPE_AUDIO_SUMMARY)->count();

            $recentFiles = $subjectLogs
                ->flatMap(fn (StudyLog $log) => $filesByStudyLog->get($log->id, collect()))
                ->take(3)
                ->map(fn (FileAttachment $file) => "{$file->original_name} [{$file->file_type}]")
                ->values()
                ->all();

            $recentSummaries = $subjectLogs
                ->flatMap(function (StudyLog $log) use ($summariesByStudyLog) {
                    return $summariesByStudyLog->get($log->id, collect())->map(function (Summary $summary) use ($log) {
                        $preview = Str::limit(preg_replace('/\s+/', ' ', trim((string) $summary->content)), 120, '...');
                        return "{$log->title}: {$preview}";
                    });
                })
                ->take(2)
                ->values()
                ->all();

            $upcomingEvents = $events
                ->take(3)
                ->map(function (StudyCalendarEvent $event) {
                    $start = $event->start_time?->format('Y-m-d H:i') ?? 'unknown time';
                    $end = $event->end_time?->format('H:i');
                    return $end ? "{$event->title} ({$start}-{$end})" : "{$event->title} ({$start})";
                })
                ->values()
                ->all();

            $subjectSchedule = array_filter([
                $subject->start_date ? "date {$subject->start_date}" : null,
                $subject->start_time ? "start {$subject->start_time}" : null,
                $subject->end_time ? "end {$subject->end_time}" : null,
                $subject->room ? "room {$subject->room}" : null,
            ]);

            $parts = [
                "Subject {$subject->id}: {$subject->name}",
                ! empty($subjectSchedule) ? 'schedule '.implode(', ', $subjectSchedule) : 'schedule not set',
                "logs study={$studyCount}, document_summary={$documentSummaryCount}, audio_summary={$audioSummaryCount}",
                'upcoming events: '.(! empty($upcomingEvents) ? implode(' | ', $upcomingEvents) : 'none'),
                'recent files: '.(! empty($recentFiles) ? implode(' | ', $recentFiles) : 'none'),
                'recent summaries: '.(! empty($recentSummaries) ? implode(' | ', $recentSummaries) : 'none'),
            ];

            return '- '.implode(' ; ', $parts);
        })->implode("\n");

        return "Current local datetime in Thailand (UTC+7): {$now->format('Y-m-d H:i:s')} ({$now->timezoneName}).\n"
            ."Subject count: {$subjects->count()}.\n"
            ."Weekly timetable summary:\n{$weeklyTimetable}\n"
            ."Study database context:\n{$subjectLines}";
    }

    private function buildAssistantWeeklyTimetable($subjects, $calendarEvents, $schedules): string
    {
        $weekdayMap = [
            0 => 'วันอาทิตย์',
            1 => 'วันจันทร์',
            2 => 'วันอังคาร',
            3 => 'วันพุธ',
            4 => 'วันพฤหัสบดี',
            5 => 'วันศุกร์',
            6 => 'วันเสาร์',
        ];

        $grouped = [];
        foreach ($weekdayMap as $index => $label) {
            $grouped[$index] = [
                'label' => $label,
                'items' => [],
            ];
        }

        foreach ($schedules as $schedule) {
            $rawDay = Str::lower(trim((string) ($schedule->day_of_week ?? '')));
            if ($rawDay === '') {
                continue;
            }

            $dayIndex = match ($rawDay) {
                'monday', 'mon', 'วันจันทร์' => 1,
                'tuesday', 'tue', 'วันอังคาร' => 2,
                'wednesday', 'wed', 'วันพุธ' => 3,
                'thursday', 'thu', 'วันพฤหัสบดี' => 4,
                'friday', 'fri', 'วันศุกร์' => 5,
                'saturday', 'sat', 'วันเสาร์' => 6,
                'sunday', 'sun', 'วันอาทิตย์' => 0,
                default => null,
            };

            if ($dayIndex === null) {
                continue;
            }

            $subject = $subjects->firstWhere('id', $schedule->subject_id);
            $subjectName = trim((string) ($subject?->name ?? ''));
            if ($subjectName === '') {
                continue;
            }

            $timeLabel = $this->formatAssistantTimeRange(
                is_string($schedule->start_time) ? $schedule->start_time : optional($schedule->start_time)->format('H:i:s'),
                is_string($schedule->end_time) ? $schedule->end_time : optional($schedule->end_time)->format('H:i:s')
            );
            $roomLabel = trim((string) ($schedule->room ?? ''));

            $parts = [$subjectName];
            if ($timeLabel !== '') {
                $parts[] = $timeLabel;
            }
            if ($roomLabel !== '') {
                $parts[] = "ห้อง {$roomLabel}";
            }

            $grouped[$dayIndex]['items'][] = implode(' • ', $parts);
        }

        $hasScheduleRows = collect($grouped)->contains(fn (array $day) => ! empty($day['items']));
        if (! $hasScheduleRows) {
            foreach ($calendarEvents as $event) {
            try {
                // Datetime in this project is stored/used as local Thailand wall time.
                // Do not convert timezone here, otherwise times can be shifted +7 hours.
                $date = $event->start_time instanceof Carbon
                    ? $event->start_time->copy()
                    : Carbon::parse($event->start_time, self::ASSISTANT_TIMEZONE);
            } catch (\Throwable) {
                continue;
            }

            if (! empty($event->study_log_id)) {
                continue;
            }

            $source = Str::lower((string) data_get($event->metadata, 'source', ''));
            if ($source === 'study_log') {
                continue;
            }

            $dayIndex = $date->dayOfWeek;
            $eventType = Str::lower((string) ($event->event_type ?? data_get($event->metadata, 'type') ?? ''));
            if ($eventType !== '' && $eventType !== 'class') {
                continue;
            }

            $subject = $subjects->firstWhere('id', $event->subject_id);
            $subjectName = trim((string) ($subject?->name ?? $event->title ?? ''));
            if ($subjectName === '') {
                continue;
            }

            $timeLabel = $this->formatAssistantTimeRange(
                $event->all_day ?? data_get($event->metadata, 'all_day') ? null : optional($date)->format('H:i:s'),
                $event->all_day ?? data_get($event->metadata, 'all_day')
                    ? null
                    : ($event->end_time instanceof Carbon
                        ? $event->end_time->copy()->format('H:i:s')
                        : (is_string($event->end_time) ? $event->end_time : null))
            );
            $roomLabel = trim((string) ($event->room ?? data_get($event->metadata, 'room') ?? $subject?->room ?? ''));

            $parts = [$subjectName];
            if ($timeLabel !== '') {
                $parts[] = $timeLabel;
            }
            if ($roomLabel !== '') {
                $parts[] = "ห้อง {$roomLabel}";
            }

                $grouped[$dayIndex]['items'][] = implode(' • ', $parts);
            }
        }

        $hasRows = collect($grouped)->contains(fn (array $day) => ! empty($day['items']));
        if (! $hasRows) {
            foreach ($subjects as $subject) {
                if (! $subject->start_date) {
                    continue;
                }

                try {
                    $date = Carbon::parse($subject->start_date, self::ASSISTANT_TIMEZONE);
                } catch (\Throwable) {
                    continue;
                }

                $dayIndex = $date->dayOfWeek;
                $timeLabel = $this->formatAssistantTimeRange($subject->start_time, $subject->end_time);
                $roomLabel = trim((string) ($subject->room ?? ''));

                $parts = [$subject->name];
                if ($timeLabel !== '') {
                    $parts[] = $timeLabel;
                }
                if ($roomLabel !== '') {
                    $parts[] = "ห้อง {$roomLabel}";
                }

                $grouped[$dayIndex]['items'][] = implode(' • ', $parts);
            }
        }

        $lines = [];
        foreach ($grouped as $day) {
            $items = $day['items'];
            $lines[] = $day['label'].': '.(! empty($items) ? implode(' | ', $items) : 'ไม่มีวิชา');
        }

        return implode("\n", $lines);
    }

    private function formatAssistantTimeRange(?string $startTime, ?string $endTime): string
    {
        $start = trim((string) $startTime);
        $end = trim((string) $endTime);

        if ($start === '' && $end === '') {
            return '';
        }

        $normalize = function (string $value): string {
            if ($value === '') {
                return '';
            }

            try {
                return Carbon::createFromFormat('H:i:s', $value, self::ASSISTANT_TIMEZONE)->format('H:i');
            } catch (\Throwable) {
                try {
                    return Carbon::parse($value, self::ASSISTANT_TIMEZONE)->format('H:i');
                } catch (\Throwable) {
                    return $value;
                }
            }
        };

        $startLabel = $normalize($start);
        $endLabel = $normalize($end);

        if ($startLabel !== '' && $endLabel !== '') {
            return "{$startLabel}-{$endLabel}";
        }

        return $startLabel !== '' ? $startLabel : $endLabel;
    }

    /**
     * @param  array<int, array<string,mixed>>  $rawAnswers
     * @return array<string,mixed>
     */
    public function gradeQuiz(Quiz $quiz, User $user, array $rawAnswers): array
    {
        $answers = collect($rawAnswers)->keyBy('question_id');
        $records = [];
        $score = 0;

        foreach ($quiz->questions as $question) {
            /** @var QuizQuestion $question */
            $payload = $answers->get($question->id, []);
            $selected = $payload['selected_answer'] ?? null;
            $isCorrect = $this->isQuizAnswerCorrect($question, $selected);
            $questionScore = $isCorrect ? 1 : 0;

            $answer = QuizAnswer::updateOrCreate(
                [
                    'user_id' => $user->id,
                    'question_id' => $question->id,
                ],
                [
                    'selected_answer' => $selected,
                    'is_correct' => $isCorrect,
                    'score' => $questionScore,
                    'answered_at' => now(),
                ]
            );

            $records[] = $answer->loadMissing('question');
            $score += $questionScore;
        }

        return [
            'score' => $score,
            'total' => $quiz->questions->count(),
            'answers' => $records,
        ];
    }

    private function isQuizAnswerCorrect(QuizQuestion $question, mixed $selected): bool
    {
        if ($selected === null) {
            return false;
        }

        $selectedText = trim((string) $selected);
        $correctText = trim((string) $question->correct_answer);

        if ($selectedText === '' || $correctText === '') {
            return false;
        }

        if (Str::lower($selectedText) === Str::lower($correctText)) {
            return true;
        }

        if ($question->question_type !== 'short_answer') {
            return false;
        }

        return $this->isSimilarShortAnswer($selectedText, $correctText);
    }

    private function isSimilarShortAnswer(string $selected, string $correct): bool
    {
        $normalizedSelected = $this->normalizeQuizAnswerText($selected);
        $normalizedCorrect = $this->normalizeQuizAnswerText($correct);

        if ($normalizedSelected === '' || $normalizedCorrect === '') {
            return false;
        }

        if ($normalizedSelected === $normalizedCorrect) {
            return true;
        }

        if (str_contains($normalizedSelected, $normalizedCorrect) || str_contains($normalizedCorrect, $normalizedSelected)) {
            return true;
        }

        similar_text($normalizedSelected, $normalizedCorrect, $percent);

        $maxLength = max(mb_strlen($normalizedSelected, 'UTF-8'), mb_strlen($normalizedCorrect, 'UTF-8'));
        $distance = levenshtein($this->toAsciiComparable($normalizedSelected), $this->toAsciiComparable($normalizedCorrect));

        if ($maxLength <= 8) {
            return $percent >= 85.0 || $distance <= 1;
        }

        return $percent >= 78.0 || $distance <= 2;
    }

    private function normalizeQuizAnswerText(string $text): string
    {
        $text = mb_strtolower(trim($text), 'UTF-8');
        $text = preg_replace('/[[:punct:]]+/u', ' ', $text) ?? $text;
        $text = preg_replace('/\s+/u', ' ', $text) ?? $text;

        return trim($text);
    }

    private function toAsciiComparable(string $text): string
    {
        $encoded = @iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $text);

        if ($encoded === false || $encoded === '') {
            return $text;
        }

        return $encoded;
    }

    public function transcribeAudio(UploadedFile $file): array
    {
        $errors = [];

        // Prefer dedicated ASR engines for per-file reliability.
        $openAIKey = (string) config('ai.openai.api_key');
        if (filled($openAIKey)) {
            try {
                $openAI = $this->transcribeAudioWithOpenAI($file, $openAIKey);
                $text = $this->normalizeAudioTranscriptText((string) ($openAI['text'] ?? ''));
                if ($this->isUsableTranscript($text)) {
                    return [
                        'text' => $text,
                        'language' => $openAI['language'] ?? null,
                    ];
                }
                $errors[] = 'OpenAI: low-confidence transcript';
            } catch (\Throwable $e) {
                $errors[] = 'OpenAI: '.($e->getMessage() ?: 'unknown error');
            }
        }

        if (filled((string) config('ai.google.speech_api_key'))) {
            try {
                $googleText = $this->normalizeAudioTranscriptText((string) $this->transcribeAudioWithGoogleSpeech($file));
                if ($this->isUsableTranscript($googleText)) {
                    return [
                        'text' => $googleText,
                        'language' => null,
                    ];
                }
                $errors[] = 'Google Speech: low-confidence transcript';
            } catch (\Throwable $e) {
                $errors[] = 'Google Speech: '.($e->getMessage() ?: 'unknown error');
            }
        }

        if ($this->hasGeminiKey()) {
            try {
                $geminiText = $this->normalizeAudioTranscriptText($this->transcribeAudioWithGemini($file));
                if ($this->isUsableTranscript($geminiText)) {
                    return [
                        'text' => $geminiText,
                        'language' => null,
                    ];
                }
                $errors[] = 'Gemini: low-confidence transcript';
            } catch (\Throwable $e) {
                $errors[] = 'Gemini: '.($e->getMessage() ?: 'unknown error');
            }
        }

        if ($errors === []) {
            throw new RuntimeException('ไม่สามารถถอดเสียงได้ กรุณาตั้งค่า OpenAI/Google Speech/Gemini ให้พร้อมใช้งาน');
        }

        throw new RuntimeException('ไม่สามารถถอดเสียงจากไฟล์นี้ได้: '.implode(' | ', $errors));
    }

    public function summarizeAudio(UploadedFile $file): array
    {
        $transcript = $this->transcribeAudio($file);
        $text = trim((string) ($transcript['text'] ?? ''));

        if (! $this->isUsableTranscript($text)) {
            throw new RuntimeException('ไม่สามารถถอดเสียงจากไฟล์นี้ได้อย่างน่าเชื่อถือ');
        }

        $summary = $this->summarizeText(
            $text,
            'สรุปใจความจากเสียงแบบไฟล์ต่อไฟล์ตาม transcript ที่ให้มา โดยกระชับ เป็น bullet และคงคำสำคัญจากต้นฉบับ'
        );
        if (trim($summary) === '') {
            $summary = $this->fallbackSummaryFromText($text);
        }
        $summary = $this->normalizeAudioDisplayText($summary);

        return [
            'transcript' => $text,
            'summary' => $this->normalizeAudioSummary($summary, $text),
            'model' => $this->summaryModel(),
        ];
    }

    private function transcribeAudioWithGemini(UploadedFile $file): string
    {
        $content = $this->callGemini(
            "ถอดเสียงจากไฟล์เสียงที่แนบมาให้ตรงต้นฉบับมากที่สุด\n"
            ."ถ้ามีหลายภาษา (เช่น ไทยและอังกฤษ) ให้คงภาษาตามที่ได้ยินจริง ห้ามแปล\n\n"
            ."รองรับเฉพาะภาษาไทยและภาษาอังกฤษเท่านั้น หากมีอักขระแปลกหรือภาษาอื่นที่ไม่ใช่เนื้อหาจริง ให้ตัดออก\n\n"
            ."ตอบเป็น JSON เท่านั้นในรูปแบบ:\n"
            ."{\"transcript\":\"...\"}",
            $file
        );

        $decoded = $this->decodeJsonPayload($content, 'audio transcription');
        $transcript = $this->normalizeAudioTranscriptText((string) ($decoded['transcript'] ?? ''));
        if (! $this->isUsableTranscript($transcript)) {
            throw new RuntimeException('Gemini audio transcription returned an empty transcript.');
        }

        return $transcript;
    }

    public function extractDocumentText(UploadedFile $file): array
    {
        $extension = strtolower($file->getClientOriginalExtension() ?? '');
        $localText = $this->extractLocalText($file);
        if ($this->isUsableLocalText($localText, $extension)) {
            return [
                'text' => $localText,
                'model' => $this->summaryModel(),
            ];
        }

        if (! $this->hasAnyAIKey()) {
            throw new RuntimeException('ไม่พบ API key สำหรับสรุปเอกสาร กรุณาอัปโหลดไฟล์ DOCX หรือ TXT');
        }

        $prompt = 'Extract the raw text from the attached study material. Return only the extracted text.';

        if ($this->useGemini()) {
            $geminiError = null;
            try {
                $content = $this->callGemini($prompt, $file);
            } catch (\Throwable $e) {
                $geminiError = $e;
                if (! $this->hasOpenAIKey()) {
                    throw $e;
                }
                try {
                    $content = $this->callOpenAIResponses($file, $prompt);
                } catch (\Throwable $openAiError) {
                    $fallbackLocalText = $this->extractLocalText($file);
                    if ($this->isUsableLocalText($fallbackLocalText, $extension)) {
                        return [
                            'text' => $fallbackLocalText,
                            'model' => 'fallback-local',
                        ];
                    }
                    $geminiMessage = $geminiError?->getMessage() ?: 'unknown';
                    $openAiMessage = $openAiError->getMessage() ?: 'unknown';
                    throw new RuntimeException(
                        "ไม่สามารถดึงข้อความจากเอกสารได้: Gemini ({$geminiMessage}) | OpenAI ({$openAiMessage})"
                    );
                }
            }
        } else {
            try {
                $content = $this->callOpenAIResponses($file, $prompt);
            } catch (\Throwable $e) {
                if (! $this->hasGeminiKey()) {
                    throw $e;
                }
                try {
                    $content = $this->callGemini($prompt, $file);
                } catch (\Throwable $geminiError) {
                    $fallbackLocalText = $this->extractLocalText($file);
                    if ($this->isUsableLocalText($fallbackLocalText, $extension)) {
                        return [
                            'text' => $fallbackLocalText,
                            'model' => 'fallback-local',
                        ];
                    }
                    throw $geminiError;
                }
            }
        }

        $content = $this->normalizeToUtf8((string) $content);
        if ($this->isLikelyGarbledText($content)) {
            $fallbackLocalText = $this->extractLocalText($file);
            if ($this->isUsableLocalText($fallbackLocalText, $extension)) {
                return [
                    'text' => $fallbackLocalText,
                    'model' => 'fallback-local',
                ];
            }
        }

        return [
            'text' => $content,
            'model' => $this->summaryModel(),
        ];
    }

    public function summarizeDocument(UploadedFile $file): array
    {
        $extension = strtolower($file->getClientOriginalExtension() ?? '');
        $localText = $this->extractLocalText($file);
        if ($this->isUsableLocalText($localText, $extension)) {
            $summary = $this->summarizeText(
                $localText,
                'อ่านข้อความต่อไปนี้ ซึ่งอาจเป็นภาษาไทยหรือภาษาอังกฤษ แล้วสรุปผลลัพธ์เป็นภาษาไทยเท่านั้นแบบกระชับ ระบุ bullet หัวข้อสำคัญ และ action items สั้นๆ หากต้นฉบับเป็นภาษาอังกฤษให้แปลใจความเป็นไทยก่อนสรุป'
            );

            return [
                'summary' => $summary,
                'text' => $localText,
                'model' => $this->summaryModel(),
            ];
        }

        if (! $this->hasAnyAIKey()) {
            throw new RuntimeException('ไม่พบ API key สำหรับสรุปเอกสาร กรุณาอัปโหลดไฟล์ DOCX หรือ TXT');
        }

        $prompt = 'อ่านไฟล์ที่แนบมา ซึ่งอาจเป็นภาษาไทยหรือภาษาอังกฤษ แล้วสรุปผลลัพธ์เป็นภาษาไทยเท่านั้นแบบกระชับ ระบุ bullet หัวข้อสำคัญ และ action items สั้นๆ หากต้นฉบับเป็นภาษาอังกฤษให้แปลใจความเป็นไทยก่อนสรุป';

        if ($this->useGemini()) {
            $geminiError = null;
            try {
                $summary = $this->callGemini($prompt, $file);
            } catch (\Throwable $e) {
                $geminiError = $e;
                if (! $this->hasOpenAIKey()) {
                    throw $e;
                }
                try {
                    $summary = $this->callOpenAIResponses($file, $prompt);
                } catch (\Throwable $openAiError) {
                    $fallbackLocalText = $this->extractLocalText($file);
                    if ($this->isUsableLocalText($fallbackLocalText, $extension)) {
                        return [
                            'summary' => $this->fallbackSummaryFromText($fallbackLocalText),
                            'text' => $fallbackLocalText,
                            'model' => 'fallback-local',
                        ];
                    }
                    $geminiMessage = $geminiError?->getMessage() ?: 'unknown';
                    $openAiMessage = $openAiError->getMessage() ?: 'unknown';
                    throw new RuntimeException(
                        "สรุปเอกสารไม่สำเร็จ: Gemini ({$geminiMessage}) | OpenAI ({$openAiMessage})"
                    );
                }
            }
        } else {
            try {
                $summary = $this->callOpenAIResponses($file, $prompt);
            } catch (\Throwable $e) {
                if (! $this->hasGeminiKey()) {
                    throw $e;
                }
                try {
                    $summary = $this->callGemini($prompt, $file);
                } catch (\Throwable $geminiError) {
                    $fallbackLocalText = $this->extractLocalText($file);
                    if ($this->isUsableLocalText($fallbackLocalText, $extension)) {
                        return [
                            'summary' => $this->fallbackSummaryFromText($fallbackLocalText),
                            'text' => $fallbackLocalText,
                            'model' => 'fallback-local',
                        ];
                    }
                    throw $geminiError;
                }
            }
        }

        return [
            'summary' => $summary,
            'model' => $this->summaryModel(),
        ];
    }

    private function extractLocalText(UploadedFile $file): ?string
    {
        $extension = strtolower($file->getClientOriginalExtension() ?? '');
        if ($extension === 'txt') {
            return $this->normalizeToUtf8((string) $file->get());
        }

        if ($extension === 'docx') {
            return $this->extractDocxText($file);
        }

        if ($extension === 'pdf') {
            $pdfText = $this->extractPdfText($file);
            if ($pdfText !== null && trim($pdfText) !== '') {
                return $pdfText;
            }

            return null;
        }

        if ($extension === 'doc') {
            return null;
        }

        return $this->extractLooseText($file);
    }

    private function extractDocxText(UploadedFile $file): ?string
    {
        if (! class_exists(ZipArchive::class)) {
            return null;
        }

        $archive = new ZipArchive();
        if ($archive->open($file->getRealPath()) !== true) {
            return null;
        }

        $xml = $archive->getFromName('word/document.xml');
        $archive->close();

        if ($xml === false) {
            return null;
        }

        $xml = str_replace(['</w:p>', '</w:tr>', '</w:tab>'], ["\n", "\n", "\t"], $xml);
        $text = strip_tags($xml);
        $text = html_entity_decode($text, ENT_QUOTES | ENT_XML1, 'UTF-8');
        $text = preg_replace("/\n{2,}/", "\n\n", $text ?? '');

        return trim((string) $text);
    }

    private function extractPdfText(UploadedFile $file): ?string
    {
        $content = (string) $file->get();
        $rawText = $this->extractPdfTextFromRawContent($content);
        if ($rawText !== null && trim($rawText) !== '') {
            return $rawText;
        }

        if (! function_exists('shell_exec')) {
            return null;
        }

        $binary = $this->findPdfToTextBinary();
        if ($binary === null) {
            return null;
        }

        $inputPath = $file->getRealPath();
        if (! $inputPath) {
            return null;
        }

        $outputPath = tempnam(sys_get_temp_dir(), 'pdftext_');
        if (! $outputPath) {
            return null;
        }

        $command = escapeshellarg($binary).' -layout '.escapeshellarg($inputPath).' '.escapeshellarg($outputPath);
        @shell_exec($command);

        if (! file_exists($outputPath)) {
            return null;
        }

        $text = @file_get_contents($outputPath);
        @unlink($outputPath);

        $text = trim((string) $text);
        return $text !== '' ? $text : null;
    }

    private function extractPdfTextFromRawContent(string $content): ?string
    {
        if ($content === '' || ! str_starts_with($content, '%PDF')) {
            return null;
        }

        preg_match_all('/stream\\r?\\n(.*?)\\r?\\nendstream/s', $content, $matches);
        $streams = $matches[1] ?? [];
        if (! is_array($streams) || $streams === []) {
            return null;
        }

        $chunks = [];
        foreach ($streams as $stream) {
            if (! is_string($stream) || $stream === '') {
                continue;
            }

            $candidates = [$stream];
            $decoded = @gzuncompress($stream);
            if (is_string($decoded) && $decoded !== '') {
                $candidates[] = $decoded;
            }

            $inflated = @gzinflate($stream);
            if (is_string($inflated) && $inflated !== '') {
                $candidates[] = $inflated;
            }

            if (str_starts_with($stream, "\x78\x9C") || str_starts_with($stream, "\x78\xDA")) {
                $alt = @gzuncompress(substr($stream, 2));
                if (is_string($alt) && $alt !== '') {
                    $candidates[] = $alt;
                }
            }

            foreach ($candidates as $candidate) {
                if (! is_string($candidate) || $candidate === '') {
                    continue;
                }

                preg_match_all('/\(([^()]*(?:\\\\.[^()]*)*)\)\s*Tj/s', $candidate, $textOps);
                foreach (($textOps[1] ?? []) as $token) {
                    if (is_string($token) && $token !== '') {
                        $chunks[] = $this->decodePdfStringToken($token);
                    }
                }

                preg_match_all('/\[(.*?)\]\s*TJ/s', $candidate, $arrayOps);
                foreach (($arrayOps[1] ?? []) as $block) {
                    if (! is_string($block) || $block === '') {
                        continue;
                    }
                    preg_match_all('/\(([^()]*(?:\\\\.[^()]*)*)\)/s', $block, $arrayTokens);
                    foreach (($arrayTokens[1] ?? []) as $token) {
                        if (is_string($token) && $token !== '') {
                            $chunks[] = $this->decodePdfStringToken($token);
                        }
                    }

                    preg_match_all('/<([0-9A-Fa-f]+)>/s', $block, $hexTokens);
                    foreach (($hexTokens[1] ?? []) as $hexToken) {
                        if (! is_string($hexToken) || $hexToken === '') {
                            continue;
                        }
                        $decodedHex = $this->decodePdfHexStringToken($hexToken);
                        if ($decodedHex !== '') {
                            $chunks[] = $decodedHex;
                        }
                    }
                }
            }
        }

        $text = trim(implode("\n", array_filter(array_map(
            static fn ($line) => trim((string) $line),
            $chunks
        ))));
        $text = preg_replace("/\n{3,}/", "\n\n", $text ?? '');

        return $text !== '' ? $text : null;
    }

    private function decodePdfStringToken(string $token): string
    {
        $decoded = preg_replace_callback('/\\\\([0-7]{1,3})/', static function (array $m) {
            return chr(octdec($m[1]));
        }, $token) ?? $token;

        $decoded = str_replace(
            ['\\n', '\\r', '\\t', '\\b', '\\f', '\\(', '\\)', '\\\\'],
            ["\n", "\r", "\t", "\x08", "\x0C", '(', ')', '\\'],
            $decoded
        );

        $decoded = $this->normalizeToUtf8($decoded);

        return trim($decoded);
    }

    private function decodePdfHexStringToken(string $hexToken): string
    {
        $hex = preg_replace('/\s+/', '', $hexToken) ?? '';
        if ($hex === '') {
            return '';
        }

        if (strlen($hex) % 2 !== 0) {
            $hex .= '0';
        }

        $binary = @hex2bin($hex);
        if (! is_string($binary) || $binary === '') {
            return '';
        }

        return trim($this->normalizeToUtf8($binary));
    }

    private function findPdfToTextBinary(): ?string
    {
        if (! function_exists('shell_exec')) {
            return null;
        }

        $command = PHP_OS_FAMILY === 'Windows' ? 'where pdftotext' : 'which pdftotext';
        $output = @shell_exec($command);
        if (! is_string($output) || trim($output) === '') {
            return null;
        }

        $lines = preg_split("/\r\n|\n|\r/", trim($output));
        $path = $lines[0] ?? '';

        return $path !== '' ? $path : null;
    }

    private function extractLooseText(UploadedFile $file): ?string
    {
        $content = (string) $file->get();
        if ($content === '') {
            return null;
        }

        $content = $this->normalizeToUtf8($content);

        $content = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/', ' ', $content);
        $content = preg_replace('/[ \t]+/', ' ', $content ?? '');
        $content = preg_replace("/\n{3,}/", "\n\n", $content ?? '');
        $content = trim((string) $content);

        return $content !== '' ? $content : null;
    }

    private function normalizeToUtf8(string $content): string
    {
        if ($content === '') {
            return '';
        }

        if (str_starts_with($content, "\xEF\xBB\xBF")) {
            return substr($content, 3);
        }

        if (str_starts_with($content, "\xFF\xFE")) {
            $converted = $this->safeConvertEncoding(substr($content, 2), 'UTF-8', 'UTF-16LE');
            return $converted !== null ? $converted : $content;
        }

        if (str_starts_with($content, "\xFE\xFF")) {
            $converted = $this->safeConvertEncoding(substr($content, 2), 'UTF-8', 'UTF-16BE');
            return $converted !== null ? $converted : $content;
        }

        if (mb_check_encoding($content, 'UTF-8')) {
            if ($this->looksLikeMojibake($content)) {
                $repaired = $this->repairMojibakeUtf8AsLatin1($content);
                if ($repaired !== null && ! $this->looksLikeMojibake($repaired)) {
                    return $repaired;
                }
            }
            return $content;
        }

        // Use canonical encoding names supported by mbstring.
        $encodings = ['CP874', 'TIS-620', 'CP1252', 'ISO-8859-1', 'UTF-16LE', 'UTF-16BE'];
        foreach ($encodings as $encoding) {
            $converted = $this->safeConvertEncoding($content, 'UTF-8', $encoding);
            if (! is_string($converted) || $converted === '') {
                continue;
            }
            if (mb_check_encoding($converted, 'UTF-8')) {
                return $converted;
            }
        }

        $auto = $this->safeConvertEncoding($content, 'UTF-8', 'auto');
        return $auto !== null ? $auto : $content;
    }

    private function safeConvertEncoding(string $value, string $to, string $from): ?string
    {
        try {
            $converted = mb_convert_encoding($value, $to, $from);
            return is_string($converted) ? $converted : null;
        } catch (\Throwable) {
            return null;
        }
    }

    private function looksLikeMojibake(string $text): bool
    {
        if ($text === '') {
            return false;
        }

        return preg_match('/(?:Ã.|Â.|â€|à¸|à¹|àº|ðŸ)/u', $text) === 1;
    }

    private function repairMojibakeUtf8AsLatin1(string $text): ?string
    {
        $latin1Decoded = $this->safeConvertEncoding($text, 'UTF-8', 'ISO-8859-1');
        if (is_string($latin1Decoded) && $latin1Decoded !== '' && mb_check_encoding($latin1Decoded, 'UTF-8')) {
            return $latin1Decoded;
        }

        $cp1252Decoded = $this->safeConvertEncoding($text, 'UTF-8', 'CP1252');
        if (is_string($cp1252Decoded) && $cp1252Decoded !== '' && mb_check_encoding($cp1252Decoded, 'UTF-8')) {
            return $cp1252Decoded;
        }

        return null;
    }

    private function isUsableLocalText(?string $text, string $extension): bool
    {
        if (! is_string($text)) {
            return false;
        }

        $trimmed = trim($text);
        if ($trimmed === '' || mb_strlen($trimmed, 'UTF-8') < 20) {
            return false;
        }

        // Some PDF/TXT payloads can pass basic checks but still be mojibake.
        if ($this->isLikelyGarbledText($trimmed)) {
            return false;
        }

        return true;
    }

    private function isLikelyGarbledText(string $text): bool
    {
        $length = max(1, mb_strlen($text, 'UTF-8'));
        $questionMarks = preg_match_all('/\?/', $text);
        $replacementChars = preg_match_all('/�/u', $text);
        $invalidSymbols = preg_match_all('/[^\p{L}\p{N}\p{P}\p{Zs}\r\n\t]/u', $text);
        $letters = preg_match_all('/[\p{Thai}\p{Latin}]/u', $text);
        $latinSupplement = preg_match_all('/[\x{00C0}-\x{00FF}]/u', $text);
        $thaiLetters = preg_match_all('/\p{Thai}/u', $text);
        $asciiLetters = preg_match_all('/[A-Za-z]/', $text);
        $suspiciousPdfOperators = preg_match_all('/\b(?:obj|endobj|stream|endstream|xref|trailer|Tj|TJ)\b/', $text);

        $noiseRatio = (($questionMarks ?: 0) + ($replacementChars ?: 0) + ($invalidSymbols ?: 0)) / $length;
        $letterRatio = ($letters ?: 0) / $length;
        $latinSupplementRatio = ($latinSupplement ?: 0) / $length;
        $meaningfulLetterRatio = (($thaiLetters ?: 0) + ($asciiLetters ?: 0)) / $length;

        return $noiseRatio > 0.25
            || $letterRatio < 0.2
            || ($latinSupplementRatio > 0.18 && $meaningfulLetterRatio < 0.35)
            || (($suspiciousPdfOperators ?: 0) >= 3 && $meaningfulLetterRatio < 0.45);
    }

    private function isUsableTranscript(string $text): bool
    {
        $trimmed = $this->normalizeAudioTranscriptText($text);
        if ($trimmed === '') {
            return false;
        }

        // หลีกเลี่ยง transcript สั้นมากที่มักเกิดจาก model เดาสุ่ม/จับเสียงผิด
        if (mb_strlen($trimmed, 'UTF-8') < 12) {
            return false;
        }

        $tokens = preg_split('/\s+/u', $trimmed, -1, PREG_SPLIT_NO_EMPTY) ?: [];
        $uniqueTokens = array_values(array_unique(array_map(
            static fn ($item) => mb_strtolower((string) $item, 'UTF-8'),
            $tokens
        )));

        if (count($tokens) >= 3 && count($uniqueTokens) <= 1) {
            return false;
        }

        $letterCount = preg_match_all('/[\p{Thai}\p{Latin}]/u', $trimmed);
        if (($letterCount ?: 0) < 6) {
            return false;
        }

        return true;
    }

    private function normalizeAudioTranscriptText(string $text): string
    {
        return $this->filterSupportedAudioText($text, false);
    }

    private function normalizeAudioDisplayText(string $text): string
    {
        return $this->filterSupportedAudioText($text, true);
    }

    private function filterSupportedAudioText(string $text, bool $allowBullets): string
    {
        $text = $this->normalizeToUtf8($text);
        $text = str_replace(["\r\n", "\r"], "\n", $text);

        $allowedPunctuation = $allowBullets
            ? '\.,;:!?\(\)\[\]\'"\/\-&%+=#@•'
            : '\.,;:!?\(\)\[\]\'"\/\-&%+=#@';

        $text = preg_replace("/[^\\p{Thai}\\p{Latin}\\p{N}\\p{Zs}\\n\\t{$allowedPunctuation}]/u", ' ', $text) ?? $text;
        $text = preg_replace("/[ ]{2,}/u", ' ', $text) ?? $text;
        $text = preg_replace("/\\n{3,}/u", "\n\n", $text) ?? $text;

        $lines = array_map(
            static fn (string $line) => trim((string) (preg_replace('/\s+/u', ' ', $line) ?? $line)),
            preg_split("/\n/u", $text) ?: []
        );

        return trim(implode("\n", array_values(array_filter($lines, static fn (string $line) => $line !== ''))));
    }

    /**
     * @param array<string,mixed> $result
     */
    private function isUsableAudioResult(array $result): bool
    {
        $transcript = trim((string) ($result['transcript'] ?? ''));
        $summary = trim((string) ($result['summary'] ?? ''));

        if ($transcript === '' && $summary === '') {
            return false;
        }

        if ($transcript !== '' && ! $this->isUsableTranscript($transcript)) {
            return false;
        }

        if ($summary !== '' && mb_strlen($summary, 'UTF-8') < 12) {
            return false;
        }

        return true;
    }

    private function summarizeText(string $text, string $prompt): string
    {
        $text = trim($text);
        if ($text === '') {
            return '';
        }

        $fallback = fn () => $this->fallbackSummaryFromText($text);

        if ($this->useGemini()) {
            if (! $this->hasGeminiKey() && ! $this->hasFallbackTextKey()) {
                return $fallback();
            }

            try {
                return $this->callGemini($prompt."\n\n".$text);
            } catch (\Throwable $e) {
                if (! $this->hasFallbackTextKey()) {
                    return $fallback();
                }
            }
        }

        try {
            return $this->callOpenAISummary($prompt, $text);
        } catch (\Throwable $e) {
            if (! $this->hasGeminiKey()) {
                return $fallback();
            }
        }

        try {
            return $this->callGemini($prompt."\n\n".$text);
        } catch (\Throwable $e) {
            return $fallback();
        }
    }

    private function fallbackSummaryFromText(string $text): string
    {
        $text = trim($text);
        if ($text === '') {
            return '';
        }

        $lines = $this->splitLines($text);
        if (count($lines) < 3) {
            $lines = $this->splitSentences($text);
        }

        $lines = array_values(array_filter($lines, fn (string $line) => mb_strlen($line, 'UTF-8') >= 12));
        if ($lines === []) {
            return $this->clipText($text, 300);
        }

        $lines = array_slice($lines, 0, 5);
        $bullets = array_map(fn (string $line) => '- '.$this->clipText($line, 180), $lines);

        return implode("\n", $bullets);
    }

    private function normalizeAudioSummary(string $summary, string $transcript = ''): string
    {
        $summary = trim($summary);
        if ($summary === '') {
            return $transcript !== '' ? $this->fallbackSummaryFromText($transcript) : '';
        }

        $lines = $this->splitLines($summary);
        if ($lines === []) {
            $lines = $this->splitSentences($summary);
        }

        $lines = array_values(array_filter(array_map(
            fn (string $line) => trim(preg_replace('/^[\-\*\d\.\)\s]+/u', '', $line) ?? ''),
            $lines
        ), fn (string $line) => $line !== ''));

        if ($lines === []) {
            return $transcript !== '' ? $this->fallbackSummaryFromText($transcript) : $this->clipText($summary, 300);
        }

        $lines = array_slice($lines, 0, 6);
        $bullets = array_map(fn (string $line) => '- '.$this->clipText($line, 180), $lines);

        return implode("\n", $bullets);
    }

    /**
     * @return array<int, string>
     */
    private function splitLines(string $text): array
    {
        $parts = preg_split("/\r\n|\n|\r/", $text);
        if (! is_array($parts)) {
            return [];
        }

        $lines = array_map('trim', $parts);
        $lines = array_values(array_filter($lines, fn (string $line) => $line !== ''));

        return $lines;
    }

    /**
     * @return array<int, string>
     */
    private function splitSentences(string $text): array
    {
        $parts = preg_split('/(?<=[.!?。！？])\s+/u', $text, -1, PREG_SPLIT_NO_EMPTY);
        if (! is_array($parts)) {
            return [];
        }

        $sentences = array_map('trim', $parts);
        $sentences = array_values(array_filter($sentences, fn (string $line) => $line !== ''));

        return $sentences;
    }

    private function clipText(string $text, int $limit = 120): string
    {
        $text = trim($text);
        if ($text === '') {
            return '';
        }

        return Str::limit($text, $limit, '...');
    }

    private function trimText(string $text, int $limit = 120): string
    {
        $text = trim($text);
        if ($text === '') {
            return '';
        }

        if (mb_strlen($text, 'UTF-8') <= $limit) {
            return $text;
        }

        return rtrim(mb_substr($text, 0, $limit, 'UTF-8'));
    }

    /**
     * @param  array<int, string>  $types
     * @return array<string, mixed>
     */
    private function fallbackQuizFromText(string $text, int $questionCount, array $types, string $title): array
    {
        $source = trim($text);
        $segments = $this->splitLines($source);
        if (count($segments) < 3) {
            $segments = $this->splitSentences($source);
        }
        $segments = array_values(array_filter($segments, fn (string $line) => mb_strlen($line, 'UTF-8') >= 12));
        if ($segments === []) {
            $segments = [$this->clipText($source, 160)];
        }

        $keywords = $this->extractKeywords($source);
        if ($keywords === []) {
            $keywords = $this->extractKeywords(implode(' ', $segments));
        }
        if ($keywords === []) {
            $keywords = ['หัวข้อหลัก', 'เนื้อหา', 'ข้อมูล', 'ประเด็นสำคัญ'];
        }

        $types = array_values(array_filter($types, fn (string $type) => in_array($type, ['multiple_choice', 'true_false', 'short_answer'], true)));
        if ($types === []) {
            $types = ['multiple_choice'];
        }

        $questions = [];
        $countSegments = count($segments);
        $countKeywords = count($keywords);
        for ($index = 0; $index < $questionCount; $index++) {
            $type = $types[$index % count($types)];
            $segment = $countSegments > 0 ? $segments[$index % $countSegments] : $source;
            $segment = $this->clipText($segment, 160);
            $keyword = $this->pickKeywordFromSegment($segment, $keywords)
                ?? $keywords[$index % $countKeywords]
                ?? '';
            $keyword = $this->clipText($keyword, 80);

            if ($type === 'true_false') {
                $statement = $keyword !== '' ? "เอกสารกล่าวถึง {$keyword}" : $segment;
                $questions[] = [
                    'question_text' => "ข้อความนี้ถูกหรือผิด: {$statement}",
                    'question_type' => 'true_false',
                    'options' => null,
                    'correct_answer' => 'true',
                    'explanation' => $segment,
                ];
                continue;
            }

            $questionText = $segment !== ''
                ? "จากข้อความต่อไปนี้ คำสำคัญคืออะไร?\n\"{$segment}\""
                : 'คำสำคัญหลักของเอกสารคืออะไร?';

            if ($type === 'short_answer') {
                $questions[] = [
                    'question_text' => $questionText,
                    'question_type' => 'short_answer',
                    'options' => null,
                    'correct_answer' => $keyword,
                    'explanation' => $segment,
                ];
                continue;
            }

            $options = $this->buildOptions($keyword, $keywords, 4);
            $questions[] = [
                'question_text' => $questionText,
                'question_type' => 'multiple_choice',
                'options' => $options,
                'correct_answer' => $keyword,
                'explanation' => $segment,
            ];
        }

        $title = trim($title);
        if ($title === '') {
            $title = 'แบบฝึกหัดจากเอกสาร';
        }

        return [
            'title' => $title,
            'description' => 'สร้างอัตโนมัติจากเนื้อหา (โหมดออฟไลน์)',
            'questions' => $questions,
        ];
    }

    /**
     * @return array<int, string>
     */
    private function extractKeywords(string $text): array
    {
        $tokens = preg_split('/[\s,.;:!?()\[\]{}<>"“”‘’\-–—\/\\\\]+/u', $text, -1, PREG_SPLIT_NO_EMPTY);
        if (! is_array($tokens)) {
            return [];
        }

        $stopwords = [
            'and', 'or', 'the', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'by',
            'from', 'is', 'are', 'was', 'were', 'be', 'as', 'that', 'this', 'it', 'its',
            'และ', 'หรือ', 'กับ', 'ที่', 'ของ', 'เป็น', 'ให้', 'ใน', 'จาก', 'มี', 'จะ', 'ได้',
            'ไม่', 'การ', 'ตาม', 'เพื่อ', 'ซึ่ง', 'แล้ว', 'โดย', 'คือ',
        ];

        $keywords = [];
        foreach ($tokens as $token) {
            $token = trim($token, " \t\n\r\0\x0B\"'“”‘’.,;:!?()[]{}");
            if ($token === '') {
                continue;
            }

            if (preg_match('/^\d+$/u', $token)) {
                continue;
            }

            if (mb_strlen($token, 'UTF-8') < 3) {
                continue;
            }

            $lower = mb_strtolower($token, 'UTF-8');
            if (in_array($lower, $stopwords, true)) {
                continue;
            }

            $keywords[$lower] = $token;
        }

        return array_values($keywords);
    }

    /**
     * @param  array<int, string>  $keywords
     */
    private function pickKeywordFromSegment(string $segment, array $keywords): ?string
    {
        foreach ($keywords as $keyword) {
            if ($keyword === '') {
                continue;
            }

            if (mb_stripos($segment, $keyword, 0, 'UTF-8') !== false) {
                return $keyword;
            }
        }

        return $keywords[0] ?? null;
    }

    /**
     * @param  array<int, string>  $keywords
     * @return array<int, string>
     */
    private function buildOptions(string $answer, array $keywords, int $count): array
    {
        $options = [];
        if ($answer !== '') {
            $options[] = $answer;
        }

        foreach ($keywords as $keyword) {
            if ($keyword === '' || $keyword === $answer) {
                continue;
            }
            $options[] = $keyword;
            if (count($options) >= $count) {
                break;
            }
        }

        $fallbacks = ['ตัวเลือกอื่น', 'ไม่ระบุ', 'ไม่เกี่ยวข้อง', 'ไม่พบในเอกสาร'];
        foreach ($fallbacks as $fallback) {
            if (count($options) >= $count) {
                break;
            }
            $options[] = $fallback;
        }

        $options = array_values(array_unique(array_map(fn (string $option) => $this->trimText($option, 80), $options)));
        while (count($options) < $count) {
            $options[] = 'อื่นๆ';
        }

        shuffle($options);

        return array_slice($options, 0, $count);
    }

    private function callOpenAIResponses(UploadedFile $file, string $prompt): string
    {
        $apiKey = config('ai.openai.api_key');
        if (! filled($apiKey)) {
            throw new RuntimeException('OpenAI API key is missing.');
        }

        $fileId = $this->uploadOpenAIFile($file, $apiKey);

        $payload = [
            'model' => config('ai.openai.summary_model'),
            'input' => [
                [
                    'role' => 'user',
                    'content' => [
                        ['type' => 'input_text', 'text' => $prompt],
                        ['type' => 'input_file', 'file_id' => $fileId],
                    ],
                ],
            ],
        ];

        $response = Http::withToken($apiKey)
            ->acceptJson()
            ->post('https://api.openai.com/v1/responses', $payload);

        if (! $response->successful()) {
            $message = $response->json('error.message') ?? $response->body();
            throw new RuntimeException('OpenAI request failed: '.$message);
        }

        $text = $this->extractResponseText($response->json());
        $this->deleteOpenAIFile($fileId, $apiKey);

        return $text;
    }

    /**
     * @param  array<string, mixed>  $payload
     */
    private function extractResponseText(array $payload): string
    {
        $direct = trim((string) data_get($payload, 'output_text', ''));
        if ($direct !== '') {
            return $direct;
        }

        $chunks = [];
        foreach ((array) data_get($payload, 'output', []) as $item) {
            foreach ((array) data_get($item, 'content', []) as $content) {
                $type = $content['type'] ?? '';
                if ($type === 'output_text' || $type === 'text') {
                    $text = trim((string) ($content['text'] ?? ''));
                    if ($text !== '') {
                        $chunks[] = $text;
                    }
                }
            }
        }

        return trim(implode("\n", $chunks));
    }

    private function callGemini(string $prompt, ?UploadedFile $file = null): string
    {
        $apiKey = config('ai.gemini.api_key');
        $model = $this->normalizeGeminiModel($this->geminiModel());
        $primaryVersion = (string) (config('ai.gemini.api_version') ?: 'v1');
        $activeModel = $model;
        $activeVersion = $primaryVersion;

        if (! filled($apiKey)) {
            throw new RuntimeException('Gemini API key is missing.');
        }

        $parts = [
            ['text' => $prompt],
        ];

        if ($file) {
            $mimeType = $this->resolveInlineMimeType($file);
            $parts[] = [
                'inlineData' => [
                    'mimeType' => $mimeType,
                    'data' => base64_encode($file->get()),
                ],
            ];
        }

        $payload = [
            'contents' => [
                [
                    'role' => 'user',
                    'parts' => $parts,
                ],
            ],
        ];

        $response = $this->requestGemini($activeVersion, $activeModel, $apiKey, $payload);
        if (! $response->successful() && $this->shouldRetryGeminiVersion($response)) {
            $activeVersion = $primaryVersion === 'v1' ? 'v1beta' : 'v1';
            $response = $this->requestGemini($activeVersion, $activeModel, $apiKey, $payload);
        }

        if (! $response->successful() && ($this->shouldRetryGeminiModel($response) || $this->shouldRetryGeminiOverload($response))) {
            $resolvedModel = $this->resolveGeminiModel($primaryVersion, $apiKey);
            if ($resolvedModel && $resolvedModel !== $activeModel) {
                $activeModel = $resolvedModel;
                $activeVersion = $primaryVersion;
                $response = $this->requestGemini($activeVersion, $activeModel, $apiKey, $payload);
                if (! $response->successful() && $this->shouldRetryGeminiVersion($response)) {
                    $activeVersion = $primaryVersion === 'v1' ? 'v1beta' : 'v1';
                    $response = $this->requestGemini($activeVersion, $activeModel, $apiKey, $payload);
                }
            }
        }

        if (! $response->successful()) {
            $maxAttempts = 3;
            $attempt = 1;
            while ($attempt < $maxAttempts && $this->shouldRetryGeminiOverload($response)) {
                // exponential backoff: 2s, 4s
                sleep(2 ** $attempt);
                $response = $this->requestGemini($activeVersion, $activeModel, $apiKey, $payload);
                $attempt++;
            }

            if (! $response->successful()) {
                $message = $response->json('error.message') ?? $response->body();
                throw new RuntimeException('Gemini request failed: '.$message);
            }
        }

        $parts = data_get($response->json(), 'candidates.0.content.parts', []);
        $chunks = [];
        foreach ((array) $parts as $part) {
            $text = trim((string) ($part['text'] ?? ''));
            if ($text !== '') {
                $chunks[] = $text;
            }
        }

        return trim(implode("\n", $chunks));
    }

    private function requestGemini(string $version, string $model, string $apiKey, array $payload)
    {
        $response = null;
        $lastResponse = null;

        foreach ($this->googleApiReferrerCandidates() as $httpReferrer) {
            $request = Http::acceptJson()
                ->connectTimeout(15)
                ->timeout(120)
                ->retry(2, 1000, throw: false);

            if ($httpReferrer !== '') {
                $request = $request->withHeaders([
                    'Referer' => $httpReferrer,
                    'Origin' => $httpReferrer,
                ]);
            }

            $response = $request->post(
                "https://generativelanguage.googleapis.com/{$version}/models/{$model}:generateContent?key={$apiKey}",
                $payload
            );

            $lastResponse = $response;
            $message = strtolower((string) ($response->json('error.message') ?? ''));
            $isReferrerBlocked = $response->status() === 403
                && str_contains($message, 'referer')
                && str_contains($message, 'blocked');

            if (! $isReferrerBlocked) {
                return $response;
            }
        }

        return $lastResponse;
    }

    private function shouldRetryGeminiVersion($response): bool
    {
        $message = (string) ($response->json('error.message') ?? '');
        if ($message === '') {
            return false;
        }

        $needle = 'not found for API version';
        $notSupported = 'not supported for generateContent';

        return stripos($message, $needle) !== false || stripos($message, $notSupported) !== false;
    }

    private function shouldRetryGeminiModel($response): bool
    {
        $message = (string) ($response->json('error.message') ?? '');
        if ($message === '') {
            return false;
        }

        return stripos($message, 'not found') !== false
            || stripos($message, 'not supported for generateContent') !== false;
    }

    private function shouldRetryGeminiOverload($response): bool
    {
        $status = (int) $response->status();
        $message = strtolower((string) ($response->json('error.message') ?? ''));

        if (in_array($status, [429, 500, 503], true)) {
            return true;
        }

        return str_contains($message, 'high demand')
            || str_contains($message, 'resource exhausted')
            || str_contains($message, 'try again later')
            || str_contains($message, 'temporarily unavailable')
            || str_contains($message, 'rate limit');
    }

    private function resolveGeminiModel(string $version, string $apiKey): ?string
    {
        $versions = [$version, $version === 'v1' ? 'v1beta' : 'v1'];
        foreach ($versions as $candidateVersion) {
            $response = null;

            foreach ($this->googleApiReferrerCandidates() as $httpReferrer) {
                $request = Http::acceptJson();

                if ($httpReferrer !== '') {
                    $request = $request->withHeaders([
                        'Referer' => $httpReferrer,
                        'Origin' => $httpReferrer,
                    ]);
                }

                $response = $request->get(
                    "https://generativelanguage.googleapis.com/{$candidateVersion}/models?key={$apiKey}"
                );

                $message = strtolower((string) ($response->json('error.message') ?? ''));
                $isReferrerBlocked = $response->status() === 403
                    && str_contains($message, 'referer')
                    && str_contains($message, 'blocked');

                if (! $isReferrerBlocked) {
                    break;
                }
            }

            if (! $response || ! $response->successful()) {
                continue;
            }

            $models = (array) ($response->json('models') ?? []);
            $filtered = collect($models)
                ->filter(fn ($model) => in_array('generateContent', (array) ($model['supportedGenerationMethods'] ?? []), true))
                ->map(fn ($model) => $this->normalizeGeminiModel((string) ($model['name'] ?? '')))
                ->filter()
                ->values()
                ->all();

            if ($filtered === []) {
                continue;
            }

            $preferred = $this->pickPreferredGeminiModel($filtered);
            if ($preferred) {
                return $preferred;
            }

            return $filtered[0] ?? null;
        }

        return null;
    }

    /**
     * @param  array<int, string>  $models
     */
    private function pickPreferredGeminiModel(array $models): ?string
    {
        $priority = [
            'gemini-2.5-flash',
            'gemini-2.5-flash-lite',
            'gemini-2.0-flash-lite',
            'gemini-2.0-flash',
            'gemini-1.5-flash-8b',
            'gemini-1.5-flash',
            'gemini-1.5-pro',
            'gemini-1.0-pro',
        ];

        foreach ($priority as $preferred) {
            if (in_array($preferred, $models, true)) {
                return $preferred;
            }
        }

        return null;
    }

    private function normalizeGeminiModel(string $model): string
    {
        $model = trim($model);
        if ($model === '') {
            return $model;
        }

        if (str_starts_with($model, 'models/')) {
            return substr($model, 7);
        }

        return $model;
    }

    private function resolveInlineMimeType(UploadedFile $file): string
    {
        $extension = strtolower((string) $file->getClientOriginalExtension());
        $mimeType = (string) ($file->getMimeType() ?: '');

        $map = [
            'mp3' => 'audio/mpeg',
            'wav' => 'audio/wav',
            'm4a' => 'audio/mp4',
            'webm' => 'audio/webm',
            'ogg' => 'audio/ogg',
            'mp4' => 'video/mp4',
            'aac' => 'audio/aac',
            '3gp' => 'audio/3gpp',
            '3gpp' => 'audio/3gpp',
            'pdf' => 'application/pdf',
            'doc' => 'application/msword',
            'docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'txt' => 'text/plain',
        ];

        // บาง browser ส่งไฟล์อัดเสียงเป็น video/webm แม้จะมีแต่เสียง ทำให้ Gemini พยายามอ่านเป็นวิดีโอ
        // แล้วตอบกลับ "0 Frames found" จึง normalize ให้เป็น audio ตามนามสกุลไฟล์
        if ($mimeType !== '' && $mimeType !== 'application/octet-stream') {
            $mimeTypeLower = strtolower($mimeType);
            if (str_starts_with($mimeTypeLower, 'video/')) {
                if (isset($map[$extension]) && str_starts_with($map[$extension], 'audio/')) {
                    return $map[$extension];
                }
                if ($mimeTypeLower === 'video/webm') {
                    return 'audio/webm';
                }
                if ($mimeTypeLower === 'video/ogg') {
                    return 'audio/ogg';
                }
                if ($mimeTypeLower === 'video/mp4') {
                    return 'audio/mp4';
                }
            }
            return $mimeTypeLower;
        }

        return $map[$extension] ?? 'application/octet-stream';
    }

    private function transcribeAudioWithGoogleSpeech(UploadedFile $file): ?string
    {
        $apiKey = (string) config('ai.google.speech_api_key');
        if (! filled($apiKey)) {
            return null;
        }

        $encoding = $this->resolveSpeechEncoding($file);
        $config = [
            'languageCode' => 'th-TH',
            'alternativeLanguageCodes' => ['en-US'],
            'enableAutomaticPunctuation' => true,
        ];

        if ($encoding !== 'ENCODING_UNSPECIFIED') {
            $config['encoding'] = $encoding;
        }
        $detectedChannels = $this->detectWavChannelCount($file);
        if ($detectedChannels !== null) {
            $config['audioChannelCount'] = $detectedChannels;
            if ($detectedChannels > 1) {
                $config['enableSeparateRecognitionPerChannel'] = false;
            }
        }

        $payload = [
            'config' => $config,
            'audio' => [
                'content' => base64_encode($file->get()),
            ],
        ];

        $response = null;
        $lastErrorMessage = '';
        foreach ($this->googleSpeechReferrerCandidates() as $httpReferrer) {
            $request = Http::acceptJson()
                ->connectTimeout(10)
                ->timeout(90)
                ->retry(2, 800, throw: false);

            if ($httpReferrer !== '') {
                $request = $request->withHeaders([
                    'Referer' => $httpReferrer,
                    'Origin' => $httpReferrer,
                ]);
            }

            $response = $request->post(
                "https://speech.googleapis.com/v1/speech:recognize?key={$apiKey}",
                $payload
            );

            if ($response->successful()) {
                break;
            }

            $lastErrorMessage = (string) ($response->json('error.message') ?? '');
            $isReferrerBlocked = $response->status() === 403
                && str_contains(strtolower($lastErrorMessage), 'referer')
                && str_contains(strtolower($lastErrorMessage), 'blocked');

            if (! $isReferrerBlocked) {
                break;
            }
        }

        if ($response === null) {
            throw new RuntimeException('Google Speech request failed: no response');
        }

        if (! $response->successful()) {
            $message = (string) ($response->json('error.message') ?? '');
            $status = (int) $response->status();

            if ($message === '') {
                $message = trim((string) $response->body());
            }

            if ($message === '') {
                $message = 'unknown error';
            }

            throw new RuntimeException("Google Speech request failed ({$status}): {$message}");
        }

        $results = (array) ($response->json('results') ?? []);
        $chunks = [];
        foreach ($results as $result) {
            $alternatives = (array) ($result['alternatives'] ?? []);
            $text = (string) ($alternatives[0]['transcript'] ?? '');
            if ($text !== '') {
                $chunks[] = $text;
            }
        }

        return trim(implode("\n", $chunks));
    }

    /**
     * @return array<int, string>
     */
    private function googleSpeechReferrerCandidates(): array
    {
        $values = [
            trim((string) config('ai.google.speech_http_referrer', '')),
            trim((string) env('FRONTEND_ORIGIN', '')),
            trim((string) env('FRONTEND_URL', '')),
            trim((string) config('app.url', '')),
            'http://localhost:5173',
            'http://127.0.0.1:5173',
            'http://localhost',
            'http://127.0.0.1',
            '',
        ];

        $normalized = [];
        foreach ($values as $value) {
            if ($value === '') {
                $normalized[] = '';
                continue;
            }
            $normalized[] = rtrim($value, '/');
        }

        return array_values(array_unique($normalized));
    }

    /**
     * @return array<int, string>
     */
    private function googleApiReferrerCandidates(): array
    {
        return $this->googleSpeechReferrerCandidates();
    }

    private function resolveSpeechEncoding(UploadedFile $file): string
    {
        $extension = strtolower((string) $file->getClientOriginalExtension());
        $map = [
            'mp3' => 'MP3',
            'wav' => 'LINEAR16',
            'flac' => 'FLAC',
            'webm' => 'WEBM_OPUS',
            'ogg' => 'OGG_OPUS',
            'amr' => 'AMR',
            '3gp' => 'AMR',
            '3gpp' => 'AMR',
        ];

        return $map[$extension] ?? 'ENCODING_UNSPECIFIED';
    }

    private function detectWavChannelCount(UploadedFile $file): ?int
    {
        $path = $file->getRealPath();
        if (! $path || ! is_readable($path)) {
            return null;
        }

        $handle = @fopen($path, 'rb');
        if (! $handle) {
            return null;
        }

        try {
            $header = fread($handle, 12);
            if (! is_string($header) || strlen($header) < 12) {
                return null;
            }

            $chunkId = substr($header, 0, 4);
            $format = substr($header, 8, 4);
            if ($chunkId !== 'RIFF' || $format !== 'WAVE') {
                return null;
            }

            // Read RIFF chunks to find "fmt " safely (not all WAV files keep it at offset 12).
            while (! feof($handle)) {
                $chunkHeader = fread($handle, 8);
                if (! is_string($chunkHeader) || strlen($chunkHeader) < 8) {
                    break;
                }

                $subChunkId = substr($chunkHeader, 0, 4);
                $subChunkSizeData = substr($chunkHeader, 4, 4);
                $unpackedSize = unpack('V', $subChunkSizeData);
                $subChunkSize = (int) ($unpackedSize[1] ?? 0);
                if ($subChunkSize < 0) {
                    return null;
                }

                if ($subChunkId === 'fmt ') {
                    $fmtData = fread($handle, max(16, $subChunkSize));
                    if (! is_string($fmtData) || strlen($fmtData) < 4) {
                        return null;
                    }

                    $channelsData = substr($fmtData, 2, 2);
                    if (strlen($channelsData) !== 2) {
                        return null;
                    }

                    $channels = unpack('v', $channelsData);
                    $value = (int) (($channels[1] ?? 0));
                    return $value > 0 ? $value : null;
                }

                if ($subChunkSize > 0) {
                    // WAV chunks are word-aligned; skip padding byte when needed.
                    $skip = $subChunkSize + ($subChunkSize % 2);
                    if (fseek($handle, $skip, SEEK_CUR) !== 0) {
                        break;
                    }
                }
            }
        } finally {
            fclose($handle);
        }

        return null;
    }

    private function transcribeAudioWithOpenAI(UploadedFile $file, string $apiKey): array
    {
        $response = Http::withToken($apiKey)
            ->acceptJson()
            ->attach('file', fopen($file->getRealPath(), 'r'), $file->getClientOriginalName())
            ->post('https://api.openai.com/v1/audio/transcriptions', [
                'model' => config('ai.whisper_model', 'whisper-1'),
            ]);

        if (! $response->successful()) {
            $message = $response->json('error.message') ?? $response->body();
            if ($this->isOpenAIQuotaExceeded($message)) {
                throw new RuntimeException('OpenAI quota ไม่เพียงพอ กรุณาตรวจสอบ plan/billing หรือรอรอบบิลใหม่');
            }
            throw new RuntimeException('OpenAI transcription failed: '.$message);
        }

        $payload = $response->json();

        return [
            'text' => $payload['text'] ?? '',
            'language' => $payload['language'] ?? null,
        ];
    }

    private function useGemini(): bool
    {
        $provider = strtolower((string) config('ai.provider'));

        if (in_array($provider, ['gemini', 'google'], true)) {
            return $this->hasGeminiKey();
        }

        // Safety fallback: if provider isn't explicitly set to Gemini but only Gemini key exists,
        // keep assistant/text features running with Gemini instead of failing on OpenAI.
        return ! $this->hasOpenAIKey() && ! $this->hasGroqKey() && $this->hasGeminiKey();
    }

    private function useGroq(): bool
    {
        return config('ai.provider') === 'groq';
    }

    private function hasGeminiKey(): bool
    {
        return filled(config('ai.gemini.api_key'));
    }

    private function hasOpenAIKey(): bool
    {
        return filled(config('ai.openai.api_key'));
    }

    private function hasGroqKey(): bool
    {
        return filled(config('ai.groq.api_key'));
    }

    private function hasAnyAIKey(): bool
    {
        return $this->hasGeminiKey() || $this->hasOpenAIKey() || $this->hasGroqKey();
    }

    private function hasFallbackTextKey(): bool
    {
        return $this->hasOpenAIKey() || $this->hasGroqKey();
    }

    private function geminiModel(): string
    {
        $configured = $this->normalizeGeminiModel((string) (config('ai.gemini.model') ?: ''));

        return match ($configured) {
            '', 'gemini-1.5-flash', 'gemini-1.5-flash-8b' => 'gemini-2.0-flash',
            default => $configured,
        };
    }

    private function summaryModel(): string
    {
        if ($this->useGemini()) {
            return $this->geminiModel();
        }

        if ($this->useGroq()) {
            return $this->groqModel();
        }

        return $this->openAISummaryModel();
    }

    private function groqModel(): string
    {
        return (string) (config('ai.groq.model') ?: 'llama-3.3-70b-versatile');
    }

    private function textClient()
    {
        return $this->useGroq() ? $this->factory->groq() : $this->factory->openAI();
    }

    private function openAISummaryModel(): string
    {
        return (string) (config('ai.openai.summary_model') ?: 'gpt-4o-mini');
    }

    private function callOpenAISummary(string $prompt, string $text): string
    {
        $client = $this->textClient();
        try {
            $response = $client->chat()->create([
                'model' => $this->summaryModel(),
                'messages' => [
                    ['role' => 'system', 'content' => $prompt],
                    ['role' => 'user', 'content' => $text],
                ],
            ]);
        } catch (\Throwable $e) {
            $message = (string) $e->getMessage();
            if ($this->isOpenAIQuotaExceeded($message)) {
                throw new RuntimeException('OpenAI quota ไม่เพียงพอ กรุณาตรวจสอบ plan/billing หรือรอรอบบิลใหม่');
            }
            throw $e;
        }

        return trim($response->choices[0]->message->content ?? '');
    }

    private function isOpenAIQuotaExceeded(?string $message): bool
    {
        $text = strtolower(trim((string) $message));
        if ($text === '') {
            return false;
        }

        return str_contains($text, 'insufficient_quota')
            || str_contains($text, 'exceeded your current quota')
            || str_contains($text, 'check your plan and billing')
            || str_contains($text, 'billing');
    }

    private function quizModel(): string
    {
        if ($this->useGeminiForQuiz()) {
            return $this->geminiModel();
        }

        if ($this->useGroq()) {
            return $this->groqModel();
        }

        return (string) config('ai.openai.quiz_model');
    }

    private function useGeminiForQuiz(): bool
    {
        $provider = strtolower((string) config('ai.provider'));
        if (in_array($provider, ['gemini', 'google'], true)) {
            return $this->hasGeminiKey();
        }

        // Safety fallback: if only Gemini key exists, still allow quiz generation.
        return ! $this->hasOpenAIKey() && ! $this->hasGroqKey() && $this->hasGeminiKey();
    }

    private function uploadOpenAIFile(UploadedFile $file, string $apiKey): string
    {
        $response = Http::withToken($apiKey)
            ->acceptJson()
            ->attach('file', fopen($file->getRealPath(), 'r'), $file->getClientOriginalName())
            ->post('https://api.openai.com/v1/files', [
                'purpose' => 'assistants',
            ]);

        if (! $response->successful()) {
            $message = $response->json('error.message') ?? $response->body();
            throw new RuntimeException('OpenAI file upload failed: '.$message);
        }

        $fileId = $response->json('id');
        if (! is_string($fileId) || $fileId === '') {
            throw new RuntimeException('OpenAI file upload failed: missing file id.');
        }

        return $fileId;
    }

    private function deleteOpenAIFile(string $fileId, string $apiKey): void
    {
        try {
            Http::withToken($apiKey)->delete('https://api.openai.com/v1/files/'.$fileId);
        } catch (\Throwable $e) {
            // Ignore cleanup failures.
        }
    }

    /**
     * @return array{context: string, summary_ids: array<int>, source: string}
     */
    private function quizSourceContext(Subject $subject): array
    {
        $summaries = Summary::query()
            ->select('summaries.id', 'summaries.content', 'study_logs.title', 'study_logs.log_date')
            ->join('study_logs', 'summaries.study_log_id', '=', 'study_logs.id')
            ->where('study_logs.subject_id', $subject->id)
            ->orderByDesc('summaries.created_at')
            ->limit(3)
            ->get();

        if ($summaries->isNotEmpty()) {
            $lines = $summaries->map(function ($summary) {
                $date = $summary->log_date ? Carbon::parse($summary->log_date)->toDateString() : null;
                $title = $summary->title ?: 'Study Log';
                $content = $this->trimContext($summary->content);
                $label = $date ? "{$title} ({$date})" : $title;

                return "- {$label}: {$content}";
            })->values()->all();

            return [
                'context' => implode("\n", $lines),
                'summary_ids' => $summaries->pluck('id')->all(),
                'source' => 'summary',
            ];
        }

        $logs = StudyLog::query()
            ->select('title', 'note', 'log_date')
            ->where('subject_id', $subject->id)
            ->orderByDesc('log_date')
            ->limit(3)
            ->get();

        if ($logs->isNotEmpty()) {
            $lines = $logs->map(function ($log) {
                $date = $log->log_date ? Carbon::parse($log->log_date)->toDateString() : null;
                $title = $log->title ?: 'Study Log';
                $note = $this->trimContext($log->note ?: '');
                $label = $date ? "{$title} ({$date})" : $title;

                return $note ? "- {$label}: {$note}" : "- {$label}";
            })->values()->all();

            return [
                'context' => implode("\n", $lines),
                'summary_ids' => [],
                'source' => 'study_log',
            ];
        }

        $fallback = $subject->description ? $this->trimContext($subject->description) : $subject->name;

        return [
            'context' => "- Subject overview: {$fallback}",
            'summary_ids' => [],
            'source' => 'subject',
        ];
    }

    private function trimContext(?string $content, int $limit = 1500): string
    {
        $content = trim((string) $content);
        if ($content === '') {
            return '';
        }

        return Str::limit($content, $limit, '...');
    }

    /**
     * @param  array<string,mixed>  $decoded
     * @param  array<int, string>  $types
     * @param  array<string, mixed>  $metadata
     * @return array<string, mixed>
     */
    private function buildQuizPayload(
        array $decoded,
        Subject $subject,
        int $questionCount,
        string $difficulty,
        array $types,
        array $metadata
    ): array {
        return [
            'title' => $decoded['title'] ?? ($subject->name.' Quiz'),
            'description' => $decoded['description'] ?? null,
            'model' => $this->quizModel(),
            'metadata' => array_merge([
                'difficulty' => $difficulty,
                'requested_types' => $types,
            ], $metadata),
            'questions' => $this->normalizeQuizQuestions($decoded['questions'] ?? [], $questionCount),
        ];
    }

    /**
     * @param  array<int, array<string,mixed>>  $questions
     * @return array<int, array<string, mixed>>
     */
    private function normalizeQuizQuestions(array $questions, int $questionCount): array
    {
        return collect($questions)
            ->take($questionCount)
            ->map(function (array $question) {
                $options = $question['options'] ?? null;
                if (is_string($options)) {
                    $options = array_values(array_filter(array_map('trim', explode('|', $options))));
                }
                if (is_array($options)) {
                    $options = array_values(array_filter($options, fn ($option) => (string) $option !== ''));
                }

                $type = $question['question_type'] ?? 'multiple_choice';
                $allowed = ['multiple_choice', 'true_false', 'short_answer'];
                if (! in_array($type, $allowed, true)) {
                    $type = 'multiple_choice';
                }

                return [
                    'question_text' => $question['question_text'] ?? 'Question',
                    'question_type' => $type,
                    'options' => $options ?: null,
                    'correct_answer' => $question['correct_answer'] ?? null,
                    'explanation' => $question['explanation'] ?? null,
                ];
            })->values()->all();
    }

    /**
     * @return array<string, mixed>
     */
    private function decodeJsonPayload(string $content, string $label): array
    {
        try {
            $decoded = json_decode($content, true, 512, JSON_THROW_ON_ERROR);
            if (is_array($decoded)) {
                return $decoded;
            }
        } catch (\Throwable $e) {
            // handled below
        }

        $json = $this->extractJsonBlock($content);
        if ($json !== null) {
            try {
                $decoded = json_decode($json, true, 512, JSON_THROW_ON_ERROR);
                if (is_array($decoded)) {
                    return $decoded;
                }
            } catch (\Throwable $e) {
                // handled below
            }
        }

        throw new RuntimeException("AI {$label} response is not valid JSON.");
    }

    private function extractJsonBlock(string $content): ?string
    {
        $start = strpos($content, '{');
        $end = strrpos($content, '}');

        if ($start === false || $end === false || $end <= $start) {
            return null;
        }

        return substr($content, $start, $end - $start + 1);
    }
}
