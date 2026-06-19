<?php

namespace App\Http\Resources;

use App\Models\StudyCalendarEvent;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;
use Illuminate\Support\Facades\DB;
use Throwable;

class SubjectResource extends JsonResource
{
    private static ?bool $hasCalendarTable = null;

    public function toArray(Request $request): array
    {
        [$startDate, $startTime, $endTime] = $this->resolveSchedule();
        [$semesterId, $semester, $academicYear] = $this->resolveSemester();

        return [
            'id' => $this->id,
            'user_id' => $this->user_id,
            'semester_id' => $semesterId,
            'semester' => $semester,
            'academic_year' => $academicYear,
            'name' => $this->name,
            'description' => $this->description,
            'color' => $this->color,
            'room' => $this->room,
            'classroom' => $this->room,
            'target_hours' => $this->target_hours,
            'start_date' => $startDate,
            'start_time' => $startTime,
            'end_time' => $endTime,
            'created_at' => $this->created_at,
            'updated_at' => $this->updated_at,
            'study_log_count' => $this->whenCounted('studyLogs'),
            'study_logs' => StudyLogResource::collection($this->whenLoaded('studyLogs')),
        ];
    }

    private function resolveSemester(): array
    {
        if (! $this->hasColumnSafe($this->resource->getTable(), 'semester_id')) {
            return [null, null, null];
        }

        $semesterId = $this->semester_id;
        if (! $semesterId) {
            return [null, null, null];
        }

        $semester = null;
        $academicYear = null;

        if ($this->relationLoaded('semester') && $this->semester) {
            $semester = (int) $this->semester->semester;
            $academicYear = (int) $this->semester->academic_year;
        }

        return [(int) $semesterId, $semester, $academicYear];
    }

    private function resolveSchedule(): array
    {
        $startDate = $this->start_date;
        $startTime = $this->start_time;
        $endTime = $this->end_time;

        if ($startDate || ! $this->hasCalendarTable()) {
            return [$startDate, $startTime, $endTime];
        }

        $event = $this->loadScheduleEvent();
        if (! $event) {
            return [$startDate, $startTime, $endTime];
        }

        $allDay = (bool) (data_get($event->metadata, 'all_day', false));
        $startDate = $event->start_time?->toDateString();
        $startTime = $allDay ? null : $event->start_time?->format('H:i:s');
        $endTime = $allDay ? null : $event->end_time?->format('H:i:s');

        return [$startDate, $startTime, $endTime];
    }

    private function loadScheduleEvent(): ?StudyCalendarEvent
    {
        $query = StudyCalendarEvent::query()
            ->where('subject_id', $this->id);

        try {
            $query->where('metadata->source', 'subject');
        } catch (Throwable $error) {
            $query->where('metadata', 'like', '%"source":"subject"%');
        }

        return $query->orderByDesc('start_time')->first();
    }

    private function hasCalendarTable(): bool
    {
        if (self::$hasCalendarTable === null) {
            self::$hasCalendarTable = $this->hasTableSafe((new StudyCalendarEvent())->getTable());
        }

        return self::$hasCalendarTable;
    }

    private function hasTableSafe(string $table): bool
    {
        static $cache = [];
        if (array_key_exists($table, $cache)) {
            return $cache[$table];
        }

        try {
            $exists = DB::selectOne(
                'SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1',
                [$table]
            ) !== null;
        } catch (Throwable $error) {
            $exists = false;
        }

        $cache[$table] = $exists;
        return $exists;
    }

    private function hasColumnSafe(string $table, string $column): bool
    {
        $key = $table . '.' . $column;
        static $cache = [];
        if (array_key_exists($key, $cache)) {
            return $cache[$key];
        }

        try {
            $exists = DB::selectOne(
                'SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1',
                [$table, $column]
            ) !== null;
        } catch (Throwable $error) {
            $exists = false;
        }

        $cache[$key] = $exists;
        return $exists;
    }
}
