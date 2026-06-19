# Laravel backend — works on Railway / Render (Docker)
FROM php:8.2-cli

# System deps + PHP extensions needed by Laravel + MySQL
RUN apt-get update && apt-get install -y \
        git unzip libzip-dev libpng-dev libonig-dev libxml2-dev libicu-dev libcurl4-openssl-dev \
    && docker-php-ext-install pdo_mysql mbstring zip bcmath gd intl \
    && rm -rf /var/lib/apt/lists/*

# Composer
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

WORKDIR /app
COPY . /app

# Install PHP deps (production)
RUN composer install --no-dev --optimize-autoloader --no-interaction --no-progress

ENV APP_ENV=production
ENV APP_DEBUG=false

# Start the app on the platform-provided $PORT.
# migrate runs but must not block startup (schema is already imported).
CMD php artisan config:clear || true; \
    php artisan migrate --force || true; \
    php artisan serve --host=0.0.0.0 --port=${PORT:-8080}
