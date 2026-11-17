import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REQUEST_COUNT = 10;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function parseUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Некорректный URL. Укажите абсолютный адрес http:// или https://.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Разрешены только протоколы http: и https:.');
  }
  return url;
}

function validateTimeout(timeoutMs) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error('Тайм-аут должен быть целым числом от 1 до 2147483647 мс.');
  }
}

export function calculateMbps(bytes, durationMs) {
  return bytes * 8 / ((durationMs / 1000) * 1_000_000);
}

function getResponse(url, signal) {
  return new Promise((resolveResponse, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.get(url, {
      signal,
      // Each GET uses a fresh connection; no global pool needs to be cleaned up.
      agent: false,
      headers: { 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache' },
    }, resolveResponse);
    request.once('error', reject);
    request.once('upgrade', (_response, socket) => {
      socket.destroy();
      reject(new Error('HTTP 101: переключение протокола не поддерживается.'));
    });
  });
}

export async function downloadOnce(input, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let url = parseUrl(input);
  validateTimeout(timeoutMs);
  const controller = new AbortController();
  const startedAt = performance.now();
  // A single deadline covers connection setup, every redirect and the entire body.
  const timer = setTimeout(() => {
    controller.abort(new Error(`Превышен тайм-аут ${timeoutMs} мс.`));
  }, timeoutMs);
  let bytes = 0;

  try {
    for (let redirects = 0; ; redirects += 1) {
      const response = await getResponse(url, controller.signal);
      const status = response.statusCode;
      const isRedirect = REDIRECT_STATUSES.has(status);
      if (!isRedirect && (status < 200 || status >= 300)) {
        response.destroy();
        throw new Error(`HTTP ${status}: ожидался успешный ответ 2xx.`);
      }

      // Buffers are counted and discarded, without decoding or retaining the file.
      for await (const chunk of response) {
        bytes += chunk.byteLength;
      }
      if (!response.complete) {
        throw new Error('Тело HTTP-ответа получено не полностью.');
      }

      if (!isRedirect) {
        const durationMs = performance.now() - startedAt;
        return { bytes, durationMs, speedMbps: calculateMbps(bytes, durationMs) };
      }
      if (!response.headers.location) {
        throw new Error(`HTTP ${status}: отсутствует заголовок Location.`);
      }
      if (redirects >= MAX_REDIRECTS) {
        throw new Error(`Превышен лимит редиректов (${MAX_REDIRECTS}).`);
      }
      // Resolve relative locations against the current hop and recheck the protocol.
      try {
        url = parseUrl(new URL(response.headers.location, url));
      } catch (error) {
        throw new Error(`Некорректный URL редиректа: ${error.message}`, { cause: error });
      }
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw controller.signal.reason;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function runBenchmark(input, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onProgress = () => {},
} = {}) {
  const url = parseUrl(input);
  validateTimeout(timeoutMs);
  const results = [];

  for (let index = 1; index <= REQUEST_COUNT; index += 1) {
    let result;
    try {
      result = await downloadOnce(url, { timeoutMs });
    } catch (error) {
      throw new Error(`Запрос ${index}/${REQUEST_COUNT} не выполнен: ${error.message}`, {
        cause: error,
      });
    }
    results.push(result);
    onProgress(result, index);
  }

  const totalBytes = results.reduce((sum, result) => sum + result.bytes, 0);
  const totalDurationMs = results.reduce((sum, result) => sum + result.durationMs, 0);
  return {
    results,
    totalBytes,
    totalDurationMs,
    averageDurationMs: totalDurationMs / REQUEST_COUNT,
    speedMbps: calculateMbps(totalBytes, totalDurationMs),
  };
}

const USAGE = `Использование: node download-speed-test.js <URL> [--timeout-ms <мс>]
Пример: node download-speed-test.js "https://example.com/image.jpg"
Всегда 10 последовательных скачиваний. Тайм-аут: ${DEFAULT_TIMEOUT_MS} мс на скачивание.
Скорость: Mbps (1 Mbps = 1 000 000 бит/с).`;

async function main(args) {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(USAGE);
    return;
  }
  if (args.length !== 1 && !(args.length === 3 && args[1] === '--timeout-ms')) {
    throw new Error(USAGE);
  }
  const timeoutMs = args.length === 3 ? Number(args[2]) : DEFAULT_TIMEOUT_MS;
  const summary = await runBenchmark(args[0], {
    timeoutMs,
    onProgress: (result, index) => {
      console.log(`[${index}/${REQUEST_COUNT}] ${result.durationMs.toFixed(2)} мс | `
        + `${result.bytes} байт | ${result.speedMbps.toFixed(3)} Mbps`);
    },
  });
  console.log(`\nИтоги (${REQUEST_COUNT} скачиваний):`);
  console.log(`Среднее время: ${summary.averageDurationMs.toFixed(2)} мс`);
  console.log(`Суммарный объём: ${summary.totalBytes} байт`);
  console.log(`Суммарное время запросов: ${(summary.totalDurationMs / 1000).toFixed(3)} с`);
  console.log(`Общая скорость: ${summary.speedMbps.toFixed(3)} Mbps`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Ошибка: ${error.message}`);
    console.error('Замер прерван. Итоговые результаты не рассчитаны.');
    process.exitCode = 1;
  });
}
