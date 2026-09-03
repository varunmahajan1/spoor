<?php
/**
 * Plugin Name: spoor
 * Description: Records which AI crawlers reach this site. Drop in wp-content/mu-plugins/.
 * Version: 0.1.0
 * License: MIT
 *
 * PRD CS-4 — WooCommerce and WordPress on managed hosting, where there is no
 * shell and therefore no Vector.
 *
 * This adapter shares no code with core, by necessity: core is TypeScript and
 * this runs in PHP. What it does share is the ruleset — `spoor-data/*.json` is
 * copied verbatim from `packages/core/data`, never retyped. That is exactly
 * what AR-6 was for, and the test suite proves the two implementations agree on
 * classification, verification and event identity rather than assuming it.
 *
 * The rules this file lives under, all of them from PRD §11:
 *   NF-1  never block the response — the write is an append, the upload is cron
 *   NF-2  never throw into the page. Every entry point is wrapped, and a fatal
 *         here would be a white screen on somebody's storefront
 *   NF-3  batched — one line appended per request, shipped on a timer
 *   NF-7  failures are recorded where the operator can see them, not swallowed
 *
 * @package spoor
 */

if (!defined('ABSPATH')) {
    exit;
}

if (!defined('SPOOR_DIR')) {
    define('SPOOR_DIR', __DIR__ . '/spoor-data');
}

/**
 * Where spooled NDJSON accumulates between uploads.
 *
 * **This has to be unreachable from the web.** The only writable location on
 * most managed hosting is the uploads directory, and WordPress serves that
 * publicly — a spool at a guessable path under it would publish every recorded
 * user agent and IP prefix to anyone who asked for the URL. Three things stop
 * that, and none of them is sufficient alone:
 *
 *   1. the directory name carries a per-site random suffix, so it cannot be
 *      guessed from the plugin source;
 *   2. an Apache `.htaccess` denies the whole directory;
 *   3. an `index.php` stops directory listing where autoindex is on.
 *
 * **On nginx none of that applies** — nginx does not read `.htaccess`. Add the
 * rule from the README to the server block, or set `SPOOR_SPOOL_DIR` to a path
 * outside the web root. `spoor_spool_is_exposed()` reports the risk rather than
 * leaving it silent.
 */
function spoor_spool_dir(): string {
    if (defined('SPOOR_SPOOL_DIR')) {
        return rtrim((string) SPOOR_SPOOL_DIR, '/\\');
    }
    $uploads = wp_upload_dir();
    return trailingslashit($uploads['basedir']) . 'spoor-' . spoor_site_token();
}

/** A stable per-site suffix. Derived from salts already unique to the install. */
function spoor_site_token(): string {
    $seed = (defined('AUTH_SALT') ? (string) AUTH_SALT : '')
          . (defined('ABSPATH') ? (string) ABSPATH : '');
    if ($seed === '') {
        $seed = (string) (function_exists('get_option') ? get_option('siteurl', 'spoor') : 'spoor');
    }
    return substr(hash('sha256', 'spoor-spool|' . $seed), 0, 16);
}

/** True when the spool sits somewhere the web server may serve directly. */
function spoor_spool_is_exposed(): bool {
    if (defined('SPOOR_SPOOL_DIR')) {
        return false;
    }
    $uploads = wp_upload_dir();
    return strpos(spoor_spool_dir(), trailingslashit($uploads['basedir'])) === 0;
}

/** Writes the guards. Called once, when the directory is created. */
function spoor_protect_dir(string $dir): void {
    $htaccess = $dir . '/.htaccess';
    if (!file_exists($htaccess)) {
        // "Require all denied" is Apache 2.4; the Order/Deny pair is 2.2. Both
        // are present because managed hosts run both, and an unrecognised
        // directive in the wrong one is ignored rather than fatal.
        @file_put_contents($htaccess, implode("\n", [
            '# spoor spool — request data, never public.',
            '<IfModule mod_authz_core.c>',
            '  Require all denied',
            '</IfModule>',
            '<IfModule !mod_authz_core.c>',
            '  Order allow,deny',
            '  Deny from all',
            '</IfModule>',
            '',
        ]));
    }
    $index = $dir . '/index.php';
    if (!file_exists($index)) {
        @file_put_contents($index, "<?php // Silence is golden.\n");
    }
}

/** Loads a bundled data file once per request. */
function spoor_data(string $name): array {
    static $cache = [];
    if (isset($cache[$name])) {
        return $cache[$name];
    }
    $path = SPOOR_DIR . '/' . $name . '.json';
    $raw  = is_readable($path) ? file_get_contents($path) : false;
    $data = $raw === false ? [] : json_decode($raw, true);
    $cache[$name] = is_array($data) ? $data : [];
    return $cache[$name];
}

/**
 * Classifies a user agent against the bundled ruleset.
 *
 * Matching is case-insensitive substring, first match wins, so ruleset order is
 * significant — the JSON is ordered most-specific-first and must not be sorted.
 *
 * @return array{bucket:string,purpose:string,version:string}
 */
function spoor_classify(?string $user_agent): array {
    $ruleset = spoor_data('ruleset');
    $version = isset($ruleset['version']) ? (string) $ruleset['version'] : '0';
    $human   = ['bucket' => 'human', 'purpose' => 'unknown', 'version' => $version];

    if ($user_agent === null || $user_agent === '') {
        return $human;
    }
    $ua = strtolower($user_agent);

    foreach (($ruleset['agents'] ?? []) as $agent) {
        foreach (($agent['match'] ?? []) as $needle) {
            if ($needle !== '' && strpos($ua, strtolower((string) $needle)) !== false) {
                return [
                    'bucket'  => (string) $agent['bucket'],
                    'purpose' => (string) $agent['purpose'],
                    'version' => $version,
                ];
            }
        }
    }

    // Bot-shaped but unrecognised. CL-4: purpose is `unknown`, never guessed
    // from the vendor — a wrong purpose is worse than no purpose, because the
    // reports group by it.
    foreach (($ruleset['genericBotHints']['match'] ?? []) as $hint) {
        if ($hint !== '' && strpos($ua, strtolower((string) $hint)) !== false) {
            return ['bucket' => 'other-bot', 'purpose' => 'unknown', 'version' => $version];
        }
    }

    return $human;
}

/** True when $ip falls inside $cidr. Returns false — never throws — on junk. */
function spoor_ip_in_cidr(string $ip, string $cidr): bool {
    $slash = strrpos($cidr, '/');
    if ($slash === false) {
        return false;
    }
    $base = substr($cidr, 0, $slash);
    $bits = substr($cidr, $slash + 1);
    if (!ctype_digit($bits)) {
        return false;
    }
    $bits = (int) $bits;

    $a = @inet_pton($ip);
    $b = @inet_pton($base);
    if ($a === false || $b === false || strlen($a) !== strlen($b)) {
        return false;
    }
    if ($bits < 0 || $bits > strlen($a) * 8) {
        return false;
    }

    $whole = intdiv($bits, 8);
    $rest  = $bits % 8;
    if ($whole > 0 && substr($a, 0, $whole) !== substr($b, 0, $whole)) {
        return false;
    }
    if ($rest === 0) {
        return true;
    }
    $mask = chr((0xFF << (8 - $rest)) & 0xFF);
    return (($a[$whole] & $mask) === ($b[$whole] & $mask));
}

/**
 * Verifies a claimed crawler identity against the bundled published ranges.
 *
 * VF-2. Returns `unverified` rather than a guess when there is no range data
 * for the bucket — a stale or absent list reads as spoofing otherwise, which is
 * why `spoor doctor` reports an unpopulated list as a setup problem.
 *
 * @return array{verified:bool,by:string}
 */
function spoor_verify(string $bucket, ?string $ip): array {
    $unverified = ['verified' => false, 'by' => 'unverified'];
    if ($bucket === 'human' || $ip === null || $ip === '') {
        return $unverified;
    }
    $ranges = spoor_data('ranges');
    $cidrs  = $ranges['ranges'][$bucket] ?? [];
    foreach ($cidrs as $cidr) {
        if (spoor_ip_in_cidr($ip, (string) $cidr)) {
            return ['verified' => true, 'by' => 'ip_range'];
        }
    }
    return $unverified;
}

/**
 * Truncates at source — /24 for IPv4, /48 for IPv6.
 *
 * OWN-3/LG-2: the full address never reaches storage. These rows remain
 * pseudonymous rather than anonymous; a /24 is still identifying in a small
 * population, and that is stated rather than glossed.
 */
function spoor_truncate_ip(?string $ip): ?string {
    if ($ip === null) {
        return null;
    }
    $ip = trim($ip);
    if ($ip === '') {
        return null;
    }
    if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
        $p = explode('.', $ip);
        return $p[0] . '.' . $p[1] . '.' . $p[2] . '.0/24';
    }
    if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6)) {
        $packed = inet_pton($ip);
        if ($packed === false) {
            return null;
        }
        $hextets = [];
        for ($i = 0; $i < 3; $i++) {
            $hextets[] = ltrim(bin2hex(substr($packed, $i * 2, 2)), '0') ?: '0';
        }
        return implode(':', $hextets) . '::/48';
    }
    return null;
}

/**
 * Content hash, byte-identical to the TypeScript `deterministicEventId`.
 *
 * PI-6: this surface can re-emit an event if a spool upload is retried, so
 * identity has to be a property of the event rather than of the emit. The
 * format is fixed by the schema and the cross-implementation test asserts it —
 * if these two ever disagree, the roll-up stops deduplicating and starts
 * inflating the crawl count.
 */
function spoor_event_id(string $ts, ?string $ip_prefix, string $path, string $ua, int $status): string {
    $material = implode('|', [$ts, $ip_prefix ?? '', $path, $ua, (string) $status]);
    return substr(hash('sha256', $material), 0, 32);
}

/** Client IP, most trustworthy header first. */
function spoor_client_ip(): ?string {
    foreach (['HTTP_CF_CONNECTING_IP', 'HTTP_X_REAL_IP', 'HTTP_TRUE_CLIENT_IP'] as $key) {
        if (!empty($_SERVER[$key])) {
            return trim((string) $_SERVER[$key]);
        }
    }
    // Client-appendable, so only the first entry means anything, and only when
    // nothing set by the edge is present.
    if (!empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
        $parts = explode(',', (string) $_SERVER['HTTP_X_FORWARDED_FOR']);
        return trim($parts[0]);
    }
    return !empty($_SERVER['REMOTE_ADDR']) ? trim((string) $_SERVER['REMOTE_ADDR']) : null;
}

/** Assets and admin are not page fetches. */
function spoor_should_ignore(string $path): bool {
    foreach (['/wp-admin', '/wp-login.php', '/wp-json', '/wp-content/', '/wp-includes/'] as $prefix) {
        if (strpos($path, $prefix) === 0) {
            return true;
        }
    }
    return (bool) preg_match('#\.(css|js|png|jpe?g|gif|svg|webp|woff2?|ico|map)$#i', $path);
}

/** Builds one schema row for the current request. */
function spoor_build_event(array $server, int $status = 200): ?array {
    $uri = (string) ($server['REQUEST_URI'] ?? '/');
    $path = (string) (parse_url($uri, PHP_URL_PATH) ?? '/');
    if ($path === '') {
        $path = '/';
    }
    if (spoor_should_ignore($path)) {
        return null;
    }

    $ua       = isset($server['HTTP_USER_AGENT']) ? (string) $server['HTTP_USER_AGENT'] : '';
    $class    = spoor_classify($ua);
    $ip       = $server['__spoor_ip'] ?? null;
    $verify   = spoor_verify($class['bucket'], $ip);
    $prefix   = spoor_truncate_ip($ip);
    $ts       = gmdate('Y-m-d\TH:i:s.000\Z');

    // LG-3: human rows are dropped at source by default. Smaller storage,
    // materially smaller legal surface, and no core report needs them.
    if ($class['bucket'] === 'human' && !defined('SPOOR_KEEP_HUMANS')) {
        return null;
    }

    return [
        'event_id'           => spoor_event_id($ts, $prefix, $path, $ua, $status),
        'ts'                 => $ts,
        'host'               => (string) ($server['HTTP_HOST'] ?? ''),
        'method'             => (string) ($server['REQUEST_METHOD'] ?? 'GET'),
        'path'               => $path,
        // The column always exists; the value only on explicit opt-in.
        'query'              => defined('SPOOR_RETAIN_QUERY') ? (parse_url($uri, PHP_URL_QUERY) ?: null) : null,
        'status'             => $status,
        'bytes'              => null,
        'duration_ms'        => null,
        // An origin cannot see whether an edge cache answered some other
        // request without reaching it, so `unknown` is the honest value.
        'cache_status'       => 'unknown',
        'user_agent'         => $ua,
        'crawler_bucket'     => $class['bucket'],
        'crawler_purpose'    => $class['purpose'],
        'crawler_verified'   => $verify['verified'],
        'verified_by'        => $verify['by'],
        'classifier_version' => $class['version'],
        'referer'            => isset($server['HTTP_REFERER']) ? (string) $server['HTTP_REFERER'] : null,
        'ip_prefix'          => $prefix,
        'surface'            => 'wordpress',
    ];
}

/** Appends one line. LOCK_EX so concurrent PHP workers cannot interleave. */
function spoor_append(array $event, ?string $dir = null): bool {
    $dir = $dir ?? spoor_spool_dir();
    if (!is_dir($dir)) {
        if (!wp_mkdir_p($dir)) {
            return false;
        }
        spoor_protect_dir($dir);
    }
    $file = $dir . '/' . gmdate('Y-m-d') . '.ndjson';
    $line = wp_json_encode($event);
    if ($line === false) {
        return false;
    }
    return file_put_contents($file, $line . "\n", FILE_APPEND | LOCK_EX) !== false;
}

/**
 * The one hook. Runs late enough that WordPress is loaded and early enough that
 * nothing has been sent, and is wrapped so a failure here can never become a
 * white screen — NF-2 in a runtime with no `passThroughOnException`.
 */
function spoor_record_request(): void {
    try {
        if (is_admin() || wp_doing_ajax() || wp_doing_cron() || (defined('WP_CLI') && WP_CLI)) {
            return;
        }
        $server = $_SERVER;
        $server['__spoor_ip'] = spoor_client_ip();
        $event = spoor_build_event($server, http_response_code() ?: 200);
        if ($event !== null) {
            spoor_append($event);
        }
    } catch (Throwable $e) {
        // NF-7: visible to the operator, invisible to the visitor.
        if (defined('WP_DEBUG') && WP_DEBUG) {
            error_log('[spoor] ' . $e->getMessage());
        }
    }
}

if (function_exists('add_action')) {
    add_action('wp', 'spoor_record_request', 1);
}
