import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUpdateManager } from './update-utils.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    console.log('Обновление WatchAutomation из последнего публичного GitHub Release.');
    console.log('Перед применением закрой окно автогенерации и заверши активный прогон.');
    const answer = await terminal.question('Введи ОБНОВИТЬ, чтобы продолжить: ');
    if (answer.trim().toUpperCase() !== 'ОБНОВИТЬ') {
      console.log('Обновление отменено.');
      return;
    }
  } finally {
    terminal.close();
  }

  const manager = createUpdateManager(PROJECT_ROOT);
  if (!manager.startPrepare()) throw new Error('Проверка обновления уже выполняется');
  let result = await manager.waitForPrepare();
  if (result.phase === 'error') throw new Error(result.error || result.message);
  console.log(result.message);
  if (result.phase === 'current') return;
  if (result.phase !== 'ready') throw new Error(`Неожиданный этап обновления: ${result.phase}`);

  if (!manager.startApply()) throw new Error('Подготовленный пакет не удалось передать установщику');
  result = await manager.waitForApply();
  if (result.phase === 'error') throw new Error(result.error || result.message);
  console.log(result.message);
  console.log('Открой автогенерацию снова, чтобы Chrome загрузил обновлённую версию расширения.');
}

main().catch((error) => {
  console.error(`Обновление не выполнено: ${error?.message || error}`);
  process.exitCode = 1;
});
