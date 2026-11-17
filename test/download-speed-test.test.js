import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import {
  calculateMbps, downloadOnce, MAX_REDIRECTS, parseUrl, REQUEST_COUNT, runBenchmark,
} from '../download-speed-test.js';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL('../download-speed-test.js', import.meta.url));

async function startServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

function endLater(response, body, delayMs) {
  const timer = setTimeout(() => response.end(body), delayMs);
  response.once('close', () => clearTimeout(timer));
}

async function runCli(args) {
  try {
    return { code: 0, ...await execFileAsync(process.execPath, [scriptPath, ...args], {
      encoding: 'utf8', timeout: 10_000,
    }) };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test('exactly 10 sequential GETs count streamed bytes and include the full body in timing', async (t) => {
  const first = Buffer.from('Начало 🐈\n');
  const last = Buffer.alloc(16_387, 0xa5);
  let requests = 0;
  let active = 0;
  let maxActive = 0;
  const serverDurations = [];
  const { url } = await startServer(t, (request, response) => {
    requests += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    assert.equal(request.method, 'GET');
    assert.equal(request.headers['accept-encoding'], 'identity');
    const startedAt = performance.now();
    response.once('finish', () => { active -= 1; });
    // No Content-Length: the result must come from streamed Buffers.
    response.write(first);
    const timer = setTimeout(() => {
      serverDurations.push(performance.now() - startedAt);
      response.end(last);
    }, 25);
    response.once('close', () => clearTimeout(timer));
  });
  const progress = [];
  const startedAt = performance.now();
  const summary = await runBenchmark(url, {
    onProgress: (result, index) => progress.push({ result, index }),
  });
  const elapsedMs = performance.now() - startedAt;

  assert.equal(REQUEST_COUNT, 10);
  assert.equal(requests, 10);
  assert.equal(maxActive, 1);
  assert.equal(active, 0);
  assert.deepEqual(progress.map(({ index }) => index), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(summary.results.length, 10);
  for (const [index, result] of summary.results.entries()) {
    assert.equal(result.bytes, first.length + last.length);
    assert.ok(result.durationMs >= serverDurations[index], 'must wait for the last chunk');
    assert.ok(Number.isFinite(result.durationMs));
    assert.equal(result.speedMbps, result.bytes * 8 / (result.durationMs / 1000 * 1_000_000));
  }
  const measuredSum = summary.results.reduce((sum, result) => sum + result.durationMs, 0);
  assert.equal(summary.totalBytes, 10 * (first.length + last.length));
  assert.equal(summary.totalDurationMs, measuredSum);
  assert.ok(summary.totalDurationMs <= elapsedMs);
  assert.equal(summary.averageDurationMs, measuredSum / 10);
  assert.equal(summary.speedMbps, summary.totalBytes * 8 / (measuredSum / 1000 * 1_000_000));
});

test('Mbps uses decimal megabits and milliseconds are converted to seconds', () => {
  assert.equal(calculateMbps(1_000_000, 2000), 4);
  assert.equal(calculateMbps(125_000, 250), 4);
  assert.equal(calculateMbps(0, 100), 0);
});

test('overall speed uses total bytes / total duration with varying downloads', async (t) => {
  let requests = 0;
  const expectedSizes = [];
  const { url } = await startServer(t, (_request, response) => {
    requests += 1;
    const size = requests * 1000;
    expectedSizes.push(size);
    endLater(response, Buffer.alloc(size), requests % 2 === 0 ? 20 : 2);
  });
  const summary = await runBenchmark(url);
  assert.deepEqual(summary.results.map(({ bytes }) => bytes), expectedSizes);
  assert.equal(summary.totalBytes, 55_000);
  assert.equal(summary.speedMbps, 55_000 * 8 / (summary.totalDurationMs / 1000 * 1_000_000));
});

test('empty 204 responses have zero bytes and zero speed', async (t) => {
  const { url } = await startServer(t, (_request, response) => {
    response.writeHead(204);
    response.end();
  });
  const summary = await runBenchmark(url);
  assert.equal(summary.totalBytes, 0);
  assert.equal(summary.speedMbps, 0);
  assert.ok(summary.averageDurationMs > 0);
});

test('Content-Length is not counted as bytes for a bodyless 204', async (t) => {
  const { url } = await startServer(t, (_request, response) => {
    response.writeHead(204, { 'Content-Length': '999999' });
    response.end();
  });
  assert.equal((await downloadOnce(url)).bytes, 0);
});

test('compressed bodies are counted as received, without automatic decompression', async (t) => {
  const encoded = gzipSync(Buffer.alloc(50_000, 0x61));
  const { url } = await startServer(t, (_request, response) => {
    // Deliberately ignore Accept-Encoding: identity.
    response.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': encoded.length });
    response.end(encoded);
  });
  assert.equal((await downloadOnce(url)).bytes, encoded.length);
});

test('all five redirect statuses resolve relative URLs and consume every body sequentially', async (t) => {
  const statuses = [301, 302, 303, 307, 308];
  const paths = [];
  let active = 0;
  let maxActive = 0;
  const { url } = await startServer(t, (request, response) => {
    paths.push(request.url);
    active += 1;
    maxActive = Math.max(maxActive, active);
    response.once('finish', () => { active -= 1; });
    const step = Number(request.url.slice(1));
    if (step < statuses.length) {
      response.writeHead(statuses[step], { Location: String(step + 1) });
      response.write('r');
      endLater(response, '!', 2);
    } else {
      response.end('file');
    }
  });
  const summary = await runBenchmark(`${url}/0`);
  assert.equal(paths.length, 60);
  assert.deepEqual(paths, Array.from({ length: 10 }, () => ['/0', '/1', '/2', '/3', '/4', '/5']).flat());
  assert.equal(maxActive, 1);
  assert.equal(summary.totalBytes, 10 * (5 * 2 + 4));
});

test('absolute redirect can target another local origin', async (t) => {
  let destinationRequests = 0;
  const destination = await startServer(t, (_request, response) => {
    destinationRequests += 1;
    response.end('target');
  });
  const source = await startServer(t, (_request, response) => {
    response.writeHead(302, { Location: `${destination.url}/file` });
    response.end('hop');
  });
  const result = await downloadOnce(source.url);
  assert.equal(result.bytes, 3 + 6);
  assert.equal(destinationRequests, 1);
});

test('redirect loops stop at the documented limit', async (t) => {
  let requests = 0;
  const { url } = await startServer(t, (_request, response) => {
    requests += 1;
    response.writeHead(302, { Location: '/' });
    response.end();
  });
  await assert.rejects(runBenchmark(url), /лимит редиректов/);
  assert.equal(requests, MAX_REDIRECTS + 1);
});

test('missing, malformed and unsupported redirect locations fail', async (t) => {
  for (const location of [undefined, 'http://[invalid', 'file:///secret', 'ftp://example.com/file']) {
    await t.test(String(location), async (t) => {
      let requests = 0;
      const { url } = await startServer(t, (_request, response) => {
        requests += 1;
        response.writeHead(302, location === undefined ? {} : { Location: location });
        response.end();
      });
      await assert.rejects(runBenchmark(url), /Location|URL редиректа/);
      assert.equal(requests, 1);
    });
  }
});

test('HTTP 404 and 500 stop immediately without progress', async (t) => {
  for (const status of [404, 500]) {
    await t.test(String(status), async (t) => {
      let requests = 0;
      let progressCalls = 0;
      const { url } = await startServer(t, (_request, response) => {
        requests += 1;
        response.writeHead(status);
        response.end('error');
      });
      await assert.rejects(runBenchmark(url, {
        onProgress: () => { progressCalls += 1; },
      }), new RegExp(`Запрос 1/10.*HTTP ${status}`));
      assert.equal(requests, 1);
      assert.equal(progressCalls, 0);
    });
  }
});

test('invalid URLs and non-HTTP protocols are rejected', async () => {
  for (const input of [undefined, '', 'not a URL', '/file', 'http://', 'ftp://example.com/file', 'file:///tmp/file', 'data:text/plain,a']) {
    assert.throws(() => parseUrl(input), /URL|протоколы/);
    await assert.rejects(runBenchmark(input), /URL|протоколы/);
  }
  assert.equal(parseUrl('https://example.com/file').protocol, 'https:');
});

test('invalid timeout values fail before making any request', async () => {
  for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, 2_147_483_648]) {
    await assert.rejects(runBenchmark('http://127.0.0.1:1', { timeoutMs }), /Тайм-аут/);
  }
});

test('connection refusal is reported as a network error', async (t) => {
  const { server, url } = await startServer(t, (_request, response) => response.end());
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(runBenchmark(url), /Запрос 1\/10.*ECONNREFUSED/);
});

test('deadline also applies while waiting for headers', async (t) => {
  const { url } = await startServer(t, () => {});
  await assert.rejects(runBenchmark(url, { timeoutMs: 80 }), /тайм-аут 80 мс/);
});

test('deadline aborts an active body, even if data keeps arriving', async (t) => {
  const { url } = await startServer(t, (_request, response) => {
    response.write('start');
    const timer = setInterval(() => response.write('more'), 5);
    response.once('close', () => clearInterval(timer));
  });
  await assert.rejects(runBenchmark(url, { timeoutMs: 80 }), /тайм-аут 80 мс/);
});

test('redirects share one deadline instead of resetting it per hop', async (t) => {
  const { url } = await startServer(t, (request, response) => {
    response.writeHead(302, { Location: String(Number(request.url.slice(1)) + 1) });
    endLater(response, 'hop', 40);
  });
  await assert.rejects(downloadOnce(`${url}/0`, { timeoutMs: 100 }), /тайм-аут 100 мс/);
});

test('truncated HTTP bodies are errors rather than successful measurements', async (t) => {
  let progressCalls = 0;
  const { url } = await startServer(t, (_request, response) => {
    response.writeHead(200, { 'Content-Length': '1000' });
    response.write('partial');
    const timer = setTimeout(() => response.destroy(), 10);
    response.once('close', () => clearTimeout(timer));
  });
  await assert.rejects(runBenchmark(url, {
    onProgress: () => { progressCalls += 1; },
  }), /Запрос 1\/10/);
  assert.equal(progressCalls, 0);
});

test('HTTP protocol upgrades are rejected without hanging', async (t) => {
  const { url } = await startServer(t, (_request, response) => {
    response.writeHead(101, { Connection: 'Upgrade', Upgrade: 'test' });
    response.end();
  });
  await assert.rejects(downloadOnce(url, { timeoutMs: 1000 }), /HTTP 101/);
});

test('CLI prints 10 measurements and a consistent successful summary', async (t) => {
  let requests = 0;
  const { url } = await startServer(t, (_request, response) => {
    requests += 1;
    response.end(Buffer.alloc(1234));
  });
  const result = await runCli([url, '--timeout-ms', '5000']);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.equal(requests, 10);
  assert.equal((result.stdout.match(/^\[\d+\/10\]/gm) ?? []).length, 10);
  assert.match(result.stdout, /Итоги \(10 скачиваний\):/);
  assert.match(result.stdout, /Суммарный объём: 12340 байт/);
  assert.match(result.stdout, /Среднее время: \d+\.\d{2} мс/);
  assert.match(result.stdout, /Общая скорость: \d+\.\d{3} Mbps/);
});

test('CLI failure after two downloads keeps progress but never prints a summary', async (t) => {
  let requests = 0;
  const { url } = await startServer(t, (_request, response) => {
    requests += 1;
    response.writeHead(requests === 3 ? 503 : 200);
    response.end('data');
  });
  const result = await runCli([url]);
  assert.equal(result.code, 1);
  assert.equal(requests, 3);
  assert.equal((result.stdout.match(/^\[\d+\/10\]/gm) ?? []).length, 2);
  assert.doesNotMatch(result.stdout, /Итоги|Среднее время|Общая скорость/);
  assert.match(result.stderr, /Запрос 3\/10.*HTTP 503/);
  assert.match(result.stderr, /Итоговые результаты не рассчитаны/);
});

test('CLI validates arguments, URL and timeout; help exits successfully', async () => {
  for (const args of [[], ['bad-url'], ['ftp://example.com/file'], ['http://127.0.0.1:1', '--unknown', '1'], ['http://127.0.0.1:1', '--timeout-ms', '0']]) {
    const result = await runCli(args);
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stdout, /Итоги|Общая скорость/);
    assert.match(result.stderr, /Ошибка:/);
  }
  const help = await runCli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Использование:/);
});
