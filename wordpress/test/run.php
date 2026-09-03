<?php
/**
 * Tests for the WordPress adapter, run against golden values produced by the
 * TypeScript implementation.
 *
 * The point is not that the PHP works in isolation. It is that **one ruleset in
 * two languages produces the same answers** — if these drift, a WordPress row
 * and a Vector row describing the same crawler stop being comparable, and the
 * roll-up stops deduplicating.
 *
 *   docker run --rm -v "$PWD:/w" -w /w php:8.3-cli-alpine php wordpress/test/run.php
 */

// ---- Minimal WordPress surface. Only what the plugin actually touches. ----
define('ABSPATH', __DIR__);
$GLOBALS['__uploads'] = sys_get_temp_dir() . '/spoor-wp-test-' . getmypid();

function wp_upload_dir(): array { return ['basedir' => $GLOBALS['__uploads']]; }
function trailingslashit(string $s): string { return rtrim($s, '/\\') . '/'; }
function wp_mkdir_p(string $d): bool { return is_dir($d) || mkdir($d, 0777, true); }
function wp_json_encode($v) { return json_encode($v, JSON_UNESCAPED_SLASHES); }
function is_admin(): bool { return false; }
function wp_doing_ajax(): bool { return false; }
function wp_doing_cron(): bool { return false; }
function add_action(...$a) {}

require __DIR__ . '/../spoor.php';

$golden = json_decode(file_get_contents(__DIR__ . '/golden.json'), true);

$pass = 0; $fail = 0; $failures = [];
function ok(string $name, $actual, $expected) {
    global $pass, $fail, $failures;
    if ($actual === $expected) { $pass++; return; }
    $fail++;
    $failures[] = sprintf("  %s\n    expected: %s\n    actual:   %s",
        $name, var_export($expected, true), var_export($actual, true));
}

// ---- Classification must match TypeScript, agent for agent ----
foreach ($golden['classify'] as $ua => $expected) {
    $c = spoor_classify($ua === '' ? '' : $ua);
    ok("classify bucket  [" . substr($ua, 0, 42) . "]", $c['bucket'], $expected['bucket']);
    ok("classify purpose [" . substr($ua, 0, 42) . "]", $c['purpose'], $expected['purpose']);
}

// ---- IP truncation must match, including the null cases ----
foreach ($golden['truncate'] as $ip => $expected) {
    ok("truncate [$ip]", spoor_truncate_ip($ip === '' ? '' : $ip), $expected);
}

// ---- Event identity must be byte-identical, or dedupe silently breaks ----
foreach ($golden['eventId'] as $key => $expected) {
    [$ts, $prefix, $path, $ua, $status] = json_decode($key, true);
    ok("event_id $path", spoor_event_id($ts, $prefix, $path, $ua, (int) $status), $expected);
}

// ---- CIDR matching ----
ok('cidr v4 inside',  spoor_ip_in_cidr('192.168.1.55', '192.168.1.0/24'), true);
ok('cidr v4 outside', spoor_ip_in_cidr('192.168.2.55', '192.168.1.0/24'), false);
ok('cidr v4 /22 edge', spoor_ip_in_cidr('216.73.216.10', '216.73.216.0/22'), true);
ok('cidr v4 /22 out',  spoor_ip_in_cidr('216.73.220.10', '216.73.216.0/22'), false);
ok('cidr v4 high',    spoor_ip_in_cidr('255.255.255.255', '255.255.255.0/24'), true);
ok('cidr v6 /32',     spoor_ip_in_cidr('2001:db8::1', '2001:db8::/32'), true);
ok('cidr v6 /48 out', spoor_ip_in_cidr('2001:db8:1235::1', '2001:db8:1234::/48'), false);
ok('cidr junk ip',    spoor_ip_in_cidr('nonsense', '10.0.0.0/8'), false);
ok('cidr junk cidr',  spoor_ip_in_cidr('1.2.3.4', 'garbage'), false);
ok('cidr v4 vs v6',   spoor_ip_in_cidr('1.2.3.4', '2001:db8::/32'), false);

// ---- Verification against the bundled ranges ----
$ranges = spoor_data('ranges');
$gpt = null;
foreach (($ranges['ranges']['gptbot'] ?? []) as $c) {
    if (strpos($c, '.') !== false && substr($c, -3) === '/32') { $gpt = substr($c, 0, -3); break; }
}
if ($gpt !== null) {
    ok('verify real gptbot range', spoor_verify('gptbot', $gpt), ['verified' => true, 'by' => 'ip_range']);
}
ok('verify spoofed ua', spoor_verify('gptbot', '203.0.113.7'), ['verified' => false, 'by' => 'unverified']);
ok('verify human',      spoor_verify('human', '8.8.8.8'),      ['verified' => false, 'by' => 'unverified']);
ok('verify no ip',      spoor_verify('gptbot', null),          ['verified' => false, 'by' => 'unverified']);

// ---- Event building ----
$server = [
    'REQUEST_URI' => '/products/widget?variant=blue',
    'REQUEST_METHOD' => 'GET',
    'HTTP_HOST' => 'shop.example',
    'HTTP_USER_AGENT' => 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
    'HTTP_REFERER' => 'https://shop.example/',
    '__spoor_ip' => '203.0.113.42',
];
$e = spoor_build_event($server, 200);
ok('event bucket',   $e['crawler_bucket'], 'claudebot');
ok('event purpose',  $e['crawler_purpose'], 'train');
ok('event path',     $e['path'], '/products/widget');
ok('event query dropped', $e['query'], null);
ok('event surface',  $e['surface'], 'wordpress');
ok('event ip_prefix', $e['ip_prefix'], '203.0.113.0/24');
ok('full ip absent', strpos(json_encode($e), '203.0.113.42'), false);

// Field parity with the TypeScript schema — a missing column breaks the roll-up.
$expected_fields = ['event_id','ts','host','method','path','query','status','bytes','duration_ms',
    'cache_status','user_agent','crawler_bucket','crawler_purpose','crawler_verified','verified_by',
    'classifier_version','referer','ip_prefix','surface'];
$actual_fields = array_keys($e);
sort($expected_fields); sort($actual_fields);
ok('schema fields match core', $actual_fields, $expected_fields);

// ---- What must never be recorded ----
ok('ignores wp-admin', spoor_build_event(array_merge($server, ['REQUEST_URI' => '/wp-admin/edit.php']), 200), null);
ok('ignores wp-json',  spoor_build_event(array_merge($server, ['REQUEST_URI' => '/wp-json/v2/posts']), 200), null);
ok('ignores assets',   spoor_build_event(array_merge($server, ['REQUEST_URI' => '/wp-content/themes/x/style.css']), 200), null);
ok('ignores images',   spoor_build_event(array_merge($server, ['REQUEST_URI' => '/uploads/a.png']), 200), null);
ok('drops humans',     spoor_build_event(array_merge($server, [
    'HTTP_USER_AGENT' => 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36']), 200), null);

// ---- NF-2: the request path must survive anything ----
$threw = false;
try {
    spoor_build_event([], 200);
    spoor_build_event(['REQUEST_URI' => null, 'HTTP_USER_AGENT' => null], 0);
    spoor_classify(null);
    spoor_truncate_ip(null);
    spoor_record_request();
} catch (Throwable $t) { $threw = true; }
ok('never throws on junk input', $threw, false);

// ---- Appending ----
$dir = $GLOBALS['__uploads'] . '/spool';
ok('append writes a line', spoor_append(['event_id' => 'x', 'ts' => '2026-09-04T00:00:00.000Z'], $dir), true);
$written = glob($dir . '/*.ndjson');
ok('append created a file', count($written), 1);
ok('append is valid ndjson', json_decode(trim(file_get_contents($written[0])), true)['event_id'], 'x');
// ---- The spool must never be readable from the web ----
define('AUTH_SALT', 'test-salt-value');
$auto = spoor_spool_dir();
ok('spool name is not guessable', (bool) preg_match('#/spoor-[0-9a-f]{16}$#', $auto), true);
ok('spool is flagged as web-exposed under uploads', spoor_spool_is_exposed(), true);

spoor_append(['event_id' => 'y', 'ts' => '2026-09-04T00:00:00.000Z'], $auto);
ok('htaccess written', file_exists($auto . '/.htaccess'), true);
ok('htaccess denies', (bool) strpos(file_get_contents($auto . '/.htaccess'), 'Require all denied'), true);
ok('index.php written', file_exists($auto . '/index.php'), true);
$token_a = spoor_site_token();
ok('site token is stable', spoor_site_token(), $token_a);

@array_map('unlink', glob($auto . '/*')); @array_map('unlink', glob($auto . '/.*')); @rmdir($auto);
@array_map('unlink', glob($dir . '/*')); @rmdir($dir); @rmdir($GLOBALS['__uploads']);

echo "\n";
if ($fail > 0) {
    echo "FAILURES:\n" . implode("\n", $failures) . "\n\n";
}
printf("  %d passed, %d failed\n\n", $pass, $fail);
exit($fail === 0 ? 0 : 1);
