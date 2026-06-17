<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        if (! Schema::hasTable('career_recommendations')) {
            return;
        }

        DB::statement('ALTER TABLE `career_recommendations` MODIFY `reason` LONGTEXT NULL');
        DB::statement('ALTER TABLE `career_recommendations` MODIFY `metadata` LONGTEXT NULL');
    }

    public function down(): void
    {
        if (! Schema::hasTable('career_recommendations')) {
            return;
        }

        DB::statement('ALTER TABLE `career_recommendations` MODIFY `reason` TEXT NULL');
        DB::statement('ALTER TABLE `career_recommendations` MODIFY `metadata` TEXT NULL');
    }
};
