import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import validator from 'gltf-validator';
import content from './gltf-tools-content.json' with { type: 'json' };

const builtinDirectory = fileURLToPath(new URL('../internal/assets/builtin/', import.meta.url));

// 只遍历真实子目录，避免符号链接目录循环；显式输入的模型仍可通过链接读取。
async function collectModels(inputs) {
  const files = new Map();
  async function visit(input) {
    const filename = path.resolve(input);
    try {
      const details = await stat(filename);
      if (details.isDirectory()) {
        const entries = await readdir(filename, { withFileTypes: true });
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (entry.isDirectory() || (entry.isFile() && path.extname(entry.name).toLowerCase() === '.glb')) {
            await visit(path.join(filename, entry.name));
          }
        }
        return;
      }
      if (path.extname(filename).toLowerCase() !== '.glb') throw new Error(content.unsupportedInput);
      const resolved = await realpath(filename);
      files.set(resolved, { file: resolved });
    } catch (error) {
      files.set(filename, { file: filename, error: error.message });
    }
  }
  for (const input of inputs) await visit(input);
  return [...files.values()].sort((a, b) => a.file.localeCompare(b.file));
}

// Khronos 校验不改变字节，也不下载外链；单文件失败不会跳过其余模型。
export async function checkGltfAssets(inputs = [builtinDirectory]) {
  const files = await collectModels(inputs);
  if (!files.length) throw new Error(content.noAssets);
  for (const entry of files) {
    if (entry.error) continue;
    try {
      const bytes = await readFile(entry.file);
      entry.bytes = bytes.length;
      entry.validation = await validator.validateBytes(new Uint8Array(bytes), {
        uri: path.basename(entry.file), maxIssues: 0,
        externalResourceFunction: async () => { throw new Error(content.externalResource); },
      });
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    validator: validator.version(),
    summary: {
      files: files.length,
      failed: files.filter((entry) => entry.error || entry.validation.issues.numErrors > 0).length,
      errors: files.reduce((total, entry) => total + (entry.error ? 1 : entry.validation.issues.numErrors), 0),
      warnings: files.reduce((total, entry) => total + (entry.validation?.issues.numWarnings ?? 0), 0),
    },
    files,
  };
}

// 报告是唯一允许的写入；拒绝通过直接路径或符号链接覆写输入模型。
async function writeReport(filename, report) {
  const resolved = path.resolve(filename);
  let target = resolved;
  try { target = await realpath(resolved); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (report.files.some((entry) => entry.file === target)) throw new Error(content.overwriteInput);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { values, positionals } = parseArgs({
      options: { output: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
      allowPositionals: true,
    });
    if (values.help) {
      console.log(content.help);
    } else {
      const report = await checkGltfAssets(positionals.length ? positionals : undefined);
      if (values.output) await writeReport(values.output, report);
      console.log(JSON.stringify(report, null, 2));
      if (report.summary.errors) process.exitCode = 1;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
