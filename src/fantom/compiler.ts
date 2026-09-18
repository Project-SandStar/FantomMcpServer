/**
 * Fantom Pod Compiler - executes fan build scripts against selected instances
 */

import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { getFantomDatabase } from './database.js';
import type { CompileRequest, CompileResult, CompileLog } from './types.js';

/**
 * Compile a Fantom pod using the specified instance
 */
export async function compilePod(request: CompileRequest): Promise<CompileResult> {
  const db = getFantomDatabase();

  // Get pod
  const pod = await db.getPodById(request.podId);
  if (!pod) {
    throw new Error(`Pod not found: ${request.podId}`);
  }

  // Resolve instance (specified, pod default, or active)
  let instanceId = request.instanceId;
  if (!instanceId && pod.defaultInstanceId) {
    instanceId = pod.defaultInstanceId;
  }
  if (!instanceId) {
    instanceId = (await db.getActiveInstanceId()) ?? undefined;
  }
  if (!instanceId) {
    throw new Error('No instance specified and no active instance set');
  }

  const instance = await db.getInstanceById(instanceId);
  if (!instance) {
    throw new Error(`Instance not found: ${instanceId}`);
  }

  // Validate instance
  const validation = await db.validateInstance(instanceId);
  if (!validation.isValid) {
    throw new Error(`Instance validation failed: ${validation.error}`);
  }

  // Resolve build file
  const buildFile = request.buildFile || pod.buildFile;
  const buildFilePath = path.join(pod.path, buildFile);

  if (!fs.existsSync(buildFilePath)) {
    throw new Error(`Build file not found: ${buildFilePath}`);
  }

  // Create compile log entry
  const log = await db.createCompileLog(pod.id, instanceId, buildFile);

  // Execute compilation
  const startTime = Date.now();
  const fanPath = path.join(instance.path, instance.fanExecutable);

  try {
    const { output, error, exitCode } = await runFanBuild(fanPath, buildFilePath, pod.path);
    const durationMs = Date.now() - startTime;

    const status = exitCode === 0 ? 'success' : 'failure';
    await db.completeCompileLog(log.id, status, output, error || null, durationMs);

    // Update last compiled pod
    await db.setSetting('last_compiled_pod_id', pod.id.toString());

    return {
      success: exitCode === 0,
      logId: log.id,
      output,
      error: error || undefined,
      durationMs
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMessage = err instanceof Error ? err.message : String(err);

    await db.completeCompileLog(log.id, 'failure', '', errorMessage, durationMs);

    return {
      success: false,
      logId: log.id,
      output: '',
      error: errorMessage,
      durationMs
    };
  }
}

/**
 * Run the fan build command
 */
function runFanBuild(
  fanPath: string,
  buildFile: string,
  workingDir: string
): Promise<{ output: string; error: string; exitCode: number }> {
  return new Promise((resolve) => {
    let output = '';
    let error = '';

    const proc = spawn(fanPath, [buildFile], {
      cwd: workingDir,
      env: { ...process.env },
      shell: false
    });

    proc.stdout.on('data', (data: Buffer) => {
      output += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      error += data.toString();
    });

    proc.on('close', (code) => {
      resolve({
        output,
        error,
        exitCode: code ?? 1
      });
    });

    proc.on('error', (err) => {
      resolve({
        output,
        error: err.message,
        exitCode: 1
      });
    });
  });
}

/**
 * Get compile logs for a pod
 */
export async function getCompileLogs(podId: number, limit: number = 20): Promise<CompileLog[]> {
  const db = getFantomDatabase();
  return db.getCompileLogsForPod(podId, limit);
}

/**
 * Get compile log by ID
 */
export async function getCompileLog(logId: number): Promise<CompileLog | null> {
  const db = getFantomDatabase();
  return db.getCompileLogById(logId);
}

/**
 * Get currently running compilations
 */
export async function getRunningCompilations(): Promise<CompileLog[]> {
  const db = getFantomDatabase();
  return db.getRunningCompilations();
}
